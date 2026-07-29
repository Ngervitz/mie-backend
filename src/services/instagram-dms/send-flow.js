/**
 * POST /api/social-conversations/:id/send flow.
 */

const { randomUUID } = require('crypto');
const supabase = require('../../clients/supabase');
const logger = require('../../lib/logger');
const { SEND_LOCK_TTL_SECONDS } = require('./config');
const { evaluateGuardrails } = require('./guardrails');
const { syncOneConversation } = require('./sync');
const { sendDirectMessage, InstagramGraphError } = require('./graph');
const {
  computeConversationStatus,
} = require('./conversation-state');

async function acquireSendLock(conversationId, lockedBy) {
  const { data, error } = await supabase.rpc('acquire_dm_send_lock', {
    p_conversation_id: conversationId,
    p_locked_by: lockedBy,
    p_ttl_seconds: SEND_LOCK_TTL_SECONDS,
  });
  if (error) {
    throw new Error(`acquire_dm_send_lock failed: ${error.message}`);
  }
  // rpc returning SETOF may be array or single row depending on client
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function releaseSendLock(conversationId, lockedBy) {
  const { error } = await supabase.rpc('release_dm_send_lock', {
    p_conversation_id: conversationId,
    p_locked_by: lockedBy,
  });
  if (error) {
    logger.warn('release_dm_send_lock failed', {
      conversationId,
      error: error.message,
    });
  }
}

/**
 * @returns {{ httpStatus: number, body: object }}
 */
async function runSendFlow({
  conversationId,
  messageText,
  sentBy,
  guardrailConfirmed = false,
}) {
  const guardrail = await evaluateGuardrails(messageText);

  if (guardrail.highestSeverity === 'blocked') {
    return {
      httpStatus: 422,
      body: {
        ok: false,
        error: 'Message blocked by guardrail',
        guardrailSeverity: 'blocked',
        matches: guardrail.blocked,
      },
    };
  }

  if (
    guardrail.highestSeverity === 'confirmation' &&
    guardrailConfirmed !== true
  ) {
    return {
      httpStatus: 409,
      body: {
        ok: false,
        error: 'Guardrail confirmation required',
        guardrailSeverity: 'confirmation',
        matches: guardrail.confirmation,
        requiresConfirmation: true,
      },
    };
  }

  const { data: conversation, error: loadErr } = await supabase
    .from('social_conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();

  if (loadErr) {
    throw new Error(loadErr.message);
  }
  if (!conversation) {
    return {
      httpStatus: 404,
      body: { ok: false, error: 'Conversation not found' },
    };
  }

  if (conversation.response_window_status === 'expired') {
    return {
      httpStatus: 422,
      body: {
        ok: false,
        error: '24h response window expired',
        responseWindowStatus: 'expired',
        responseWindowExpiresAt: conversation.response_window_expires_at,
      },
    };
  }

  const lockedBy = randomUUID();
  const lockedRow = await acquireSendLock(conversationId, lockedBy);
  if (!lockedRow) {
    return {
      httpStatus: 409,
      body: {
        ok: false,
        error: 'Send lock held by another request',
      },
    };
  }

  try {
    // Step 3: always reconcile this conversation against Meta before send.
    const synced = await syncOneConversation({
      igConversationId: conversation.ig_conversation_id,
    });
    const fresh = synced.conversation;

    const alreadyAnswered =
      fresh.last_inbound_at &&
      fresh.last_outbound_at &&
      new Date(fresh.last_outbound_at).getTime() >=
        new Date(fresh.last_inbound_at).getTime();

    if (alreadyAnswered) {
      await releaseSendLock(conversationId, lockedBy);
      return {
        httpStatus: 200,
        body: {
          ok: true,
          alreadyReplied: true,
          message: 'Outbound already present after last inbound; send skipped',
          conversationId,
          status: fresh.status,
        },
      };
    }

    if (fresh.response_window_status === 'expired') {
      await releaseSendLock(conversationId, lockedBy);
      return {
        httpStatus: 422,
        body: {
          ok: false,
          error: '24h response window expired',
          responseWindowStatus: 'expired',
        },
      };
    }

    let sendResult;
    try {
      sendResult = await sendDirectMessage(
        fresh.recipient_ig_scoped_id,
        messageText,
      );
    } catch (err) {
      await releaseSendLock(conversationId, lockedBy);
      return {
        httpStatus: 502,
        body: {
          ok: false,
          error: err && err.message ? err.message : 'Send failed',
          rateLimited: Boolean(
            err instanceof InstagramGraphError && err.isRateLimited,
          ),
        },
      };
    }

    const igMessageId =
      (sendResult && (sendResult.message_id || sendResult.id)) || null;

    const nowIso = new Date().toISOString();
    const severityForAudit =
      guardrail.highestSeverity === 'warning' ||
      (guardrail.highestSeverity === 'confirmation' && guardrailConfirmed)
        ? guardrail.highestSeverity
        : guardrail.highestSeverity === 'confirmation'
          ? 'confirmation'
          : guardrail.warning.length
            ? 'warning'
            : null;

    let messagePersisted = false;

    // Only persist when Meta returned a real message id. A synthetic local:*
    // id would duplicate when the next syncOneConversation brings the real id.
    if (igMessageId) {
      const insertRow = {
        social_conversation_id: conversationId,
        ig_message_id: String(igMessageId),
        direction: 'outbound',
        source: 'metadash',
        text: messageText,
        sent_by: sentBy,
        message_timestamp: nowIso,
        guardrail_severity: severityForAudit,
        guardrail_matches:
          guardrail.matches.length > 0 ? guardrail.matches : null,
        guardrail_confirmed_at:
          guardrail.highestSeverity === 'confirmation' && guardrailConfirmed
            ? nowIso
            : null,
        guardrail_confirmed_by:
          guardrail.highestSeverity === 'confirmation' && guardrailConfirmed
            ? sentBy
            : null,
        fetched_at: nowIso,
      };

      const { error: insErr } = await supabase
        .from('social_messages')
        .upsert(insertRow, { onConflict: 'ig_message_id' });

      if (insErr) {
        logger.error('social_messages insert after send failed', {
          conversationId,
          error: insErr.message,
        });
        try {
          await syncOneConversation({
            igConversationId: fresh.ig_conversation_id,
          });
        } catch (_) {
          /* ignore */
        }
        await releaseSendLock(conversationId, lockedBy);
        return {
          httpStatus: 502,
          body: {
            ok: false,
            error: `Sent but local persist failed: ${insErr.message}`,
          },
        };
      }
      messagePersisted = true;
    } else {
      logger.info(
        'Instagram DM sent without Meta message id — skipping local insert; next sync will persist',
        { conversationId, sentBy },
      );
    }

    const lastInboundAt = fresh.last_inbound_at;
    const lastOutboundAt = nowIso;
    const derived = computeConversationStatus({
      lastInboundAt,
      lastOutboundAt,
      currentStatus: fresh.status,
    });

    await supabase
      .from('social_conversations')
      .update({
        last_outbound_at: lastOutboundAt,
        response_window_expires_at: derived.response_window_expires_at,
        response_window_status: derived.response_window_status,
        status: derived.status,
      })
      .eq('id', conversationId);

    await releaseSendLock(conversationId, lockedBy);

    logger.info('Instagram DM sent', {
      conversationId,
      igMessageId,
      messagePersisted,
      sentBy,
    });

    return {
      httpStatus: 200,
      body: {
        ok: true,
        alreadyReplied: false,
        igMessageId: igMessageId ? String(igMessageId) : null,
        messagePersisted,
        status: derived.status,
        guardrailSeverity: severityForAudit,
        guardrailMatches: guardrail.matches,
      },
    };
  } catch (err) {
    await releaseSendLock(conversationId, lockedBy);
    if (err instanceof InstagramGraphError && err.isRateLimited) {
      return {
        httpStatus: 502,
        body: {
          ok: false,
          error: err.message,
          rateLimited: true,
        },
      };
    }
    throw err;
  }
}

module.exports = { runSendFlow, acquireSendLock, releaseSendLock };
