const supabase = require('../../clients/supabase');
const logger = require('../../lib/logger');
const { getConversationWithMessages } = require('./graph');
const {
  pickRecipient,
  messageDirection,
  computeConversationStatus,
  extremaFromMappedMessages,
} = require('./conversation-state');

function mapMetaMessage(raw, conversationRowId) {
  const direction = messageDirection(raw.from);
  const created = raw.created_time || raw.timestamp;
  return {
    social_conversation_id: conversationRowId,
    ig_message_id: String(raw.id),
    direction,
    source: direction === 'outbound' ? 'instagram' : null,
    text: raw.message != null ? String(raw.message) : null,
    message_timestamp: created
      ? new Date(created).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Upsert message basics — never overwrite guardrail_* / sent_by / source if
 * already set from MetaDash send.
 */
async function upsertMessageBasics(mapped) {
  const { data: existing, error: selErr } = await supabase
    .from('social_messages')
    .select('id, source, sent_by')
    .eq('ig_message_id', mapped.ig_message_id)
    .maybeSingle();

  if (selErr) {
    throw new Error(`social_messages select failed: ${selErr.message}`);
  }

  if (!existing) {
    const { error: insErr } = await supabase.from('social_messages').insert({
      ...mapped,
      fetched_at: new Date().toISOString(),
    });
    if (insErr) {
      throw new Error(`social_messages insert failed: ${insErr.message}`);
    }
    return 'inserted';
  }

  // Refresh text/timestamp/direction only — never guardrail_* or metadash provenance.
  const patch = {
    text: mapped.text,
    message_timestamp: mapped.message_timestamp,
    direction: mapped.direction,
  };
  if (existing.source !== 'metadash') {
    patch.source = mapped.source;
  }

  const { error: updErr } = await supabase
    .from('social_messages')
    .update(patch)
    .eq('ig_message_id', mapped.ig_message_id);
  if (updErr) {
    throw new Error(`social_messages update failed: ${updErr.message}`);
  }
  return 'updated';
}

async function upsertConversationShell(igConversationId, recipient, updatedTime) {
  const { data: existing, error: selErr } = await supabase
    .from('social_conversations')
    .select('*')
    .eq('ig_conversation_id', igConversationId)
    .maybeSingle();

  if (selErr) {
    throw new Error(`social_conversations select failed: ${selErr.message}`);
  }

  if (!existing) {
    const row = {
      platform: 'instagram',
      ig_conversation_id: igConversationId,
      recipient_ig_scoped_id: recipient.id,
      ig_username: recipient.username,
      status: 'pending',
    };
    const { data: inserted, error: insErr } = await supabase
      .from('social_conversations')
      .insert(row)
      .select('*')
      .single();
    if (insErr) {
      throw new Error(`social_conversations insert failed: ${insErr.message}`);
    }
    return inserted;
  }

  const patch = {
    recipient_ig_scoped_id: recipient.id,
  };
  if (recipient.username) {
    patch.ig_username = recipient.username;
  }

  const { data: updated, error: updErr } = await supabase
    .from('social_conversations')
    .update(patch)
    .eq('id', existing.id)
    .select('*')
    .single();
  if (updErr) {
    throw new Error(`social_conversations update failed: ${updErr.message}`);
  }
  void updatedTime;
  return updated;
}

async function applyConversationDerivedState(conversationRow, mappedMessages) {
  const { lastInboundAt, lastOutboundAt } =
    extremaFromMappedMessages(mappedMessages);

  const derived = computeConversationStatus({
    lastInboundAt,
    lastOutboundAt,
    currentStatus: conversationRow.status,
  });

  const patch = {
    last_inbound_at: lastInboundAt,
    last_outbound_at: lastOutboundAt,
    response_window_expires_at: derived.response_window_expires_at,
    response_window_status: derived.response_window_status,
    status: derived.status,
    last_synced_at: new Date().toISOString(),
    last_sync_status: 'success',
    last_sync_error: null,
  };

  const { data, error } = await supabase
    .from('social_conversations')
    .update(patch)
    .eq('id', conversationRow.id)
    .select('*')
    .single();
  if (error) {
    throw new Error(`conversation state update failed: ${error.message}`);
  }
  return data;
}

/**
 * Sync one conversation: fetch messages from Meta, upsert, recalculate window/status.
 * @returns {{ conversation, messagesUpserted, mappedMessages }}
 */
async function syncOneConversation({
  igConversationId,
  participantsFromList = null,
}) {
  const detail = await getConversationWithMessages(igConversationId);
  const participants = detail.participants || participantsFromList;
  const recipient = pickRecipient(participants);
  if (!recipient) {
    throw new Error(
      `Could not resolve recipient_ig_scoped_id for conversation ${igConversationId}`,
    );
  }

  const conversation = await upsertConversationShell(
    String(detail.id || igConversationId),
    recipient,
    null,
  );

  const mappedMessages = [];
  for (const raw of detail.messages || []) {
    if (!raw || !raw.id) continue;
    const mapped = mapMetaMessage(raw, conversation.id);
    mappedMessages.push(mapped);
    await upsertMessageBasics(mapped);
  }

  // Also fold in DB messages we already have (for extrema if Meta page incomplete).
  const { data: dbMsgs, error: dbErr } = await supabase
    .from('social_messages')
    .select('direction, message_timestamp')
    .eq('social_conversation_id', conversation.id);
  if (dbErr) {
    throw new Error(`load messages for extrema failed: ${dbErr.message}`);
  }

  const forExtrema = (dbMsgs || []).map((m) => ({
    direction: m.direction,
    message_timestamp: m.message_timestamp,
  }));

  const updated = await applyConversationDerivedState(conversation, forExtrema);

  return {
    conversation: updated,
    messagesUpserted: mappedMessages.length,
    mappedMessages,
  };
}

async function markConversationSyncError(igConversationId, message) {
  const { error } = await supabase
    .from('social_conversations')
    .update({
      last_sync_status: 'error',
      last_sync_error: String(message || 'unknown').slice(0, 2000),
      last_synced_at: new Date().toISOString(),
    })
    .eq('ig_conversation_id', igConversationId);
  if (error) {
    logger.warn('markConversationSyncError failed', {
      igConversationId,
      error: error.message,
    });
  }
}

module.exports = {
  syncOneConversation,
  markConversationSyncError,
  upsertMessageBasics,
  mapMetaMessage,
  upsertConversationShell,
  applyConversationDerivedState,
};
