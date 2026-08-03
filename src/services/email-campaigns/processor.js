/**
 * Email campaign materialization + queue processor.
 * Uses existing job_locks RPCs (acquire_job_lock / release_job_lock) inline —
 * same pattern as czSync.js. Does not import Instagram/Facebook lock helpers.
 */

const { randomUUID } = require('crypto');
const supabase = require('../../clients/supabase');
const logger = require('../../lib/logger');
const { getEmailProvider } = require('../email-provider');
const { validateRule, filterBySegment } = require('./rule-engine');

const PAGE_SIZE = 1000;
const INSERT_BATCH_SIZE = 500;
const QUEUE_LIMIT = 50;
const PROCESS_QUEUE_JOB_NAME = 'email_campaigns_process_queue';
const PROCESS_QUEUE_LOCK_TTL_SECONDS = 15 * 60;

const MATERIALIZE_ALLOWED_STATUSES = new Set(['draft', 'scheduled']);
const SEND_ALLOWED_STATUSES = new Set(['draft', 'scheduled', 'sending']);

/**
 * @param {unknown} campaignId
 * @returns {string}
 */
function normalizeCampaignId(campaignId) {
  if (campaignId == null || campaignId === '') {
    throw new Error('materializeCampaign: campaignId is required');
  }
  if (typeof campaignId === 'bigint') {
    return campaignId.toString();
  }
  if (typeof campaignId === 'number') {
    if (!Number.isFinite(campaignId) || !Number.isInteger(campaignId) || campaignId < 1) {
      throw new Error(`materializeCampaign: invalid campaignId: ${campaignId}`);
    }
    return String(campaignId);
  }
  const s = String(campaignId).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`materializeCampaign: invalid campaignId: ${campaignId}`);
  }
  return s;
}

/**
 * Normalize encuesta_score (and leave other fields intact) for rule evaluation.
 * Supabase NUMERIC often arrives as string — convert valid numeric strings to number.
 * Invalid values abort the whole materialization (no partial audience).
 *
 * @param {object} record
 * @returns {object} shallow copy with encuesta_score as number|null
 */
function normalizeEncuestaRecord(record) {
  const raw = record && record.encuesta_score;
  if (raw === null || raw === undefined) {
    return { ...record, encuesta_score: null };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      logger.error('normalizeEncuestaRecord: invalid encuesta_score (non-finite number)', {
        recordId: record.id,
        ci: record.ci,
        raw,
      });
      throw new Error(
        `normalizeEncuestaRecord: invalid encuesta_score for record id=${record.id} ci=${record.ci} raw=${raw}`,
      );
    }
    return { ...record, encuesta_score: raw };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return { ...record, encuesta_score: null };
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      logger.error('normalizeEncuestaRecord: invalid encuesta_score (non-numeric string)', {
        recordId: record.id,
        ci: record.ci,
        raw,
      });
      throw new Error(
        `normalizeEncuestaRecord: invalid encuesta_score for record id=${record.id} ci=${record.ci} raw=${JSON.stringify(raw)}`,
      );
    }
    return { ...record, encuesta_score: n };
  }

  logger.error('normalizeEncuestaRecord: invalid encuesta_score (unsupported type)', {
    recordId: record && record.id,
    ci: record && record.ci,
    raw,
    rawType: typeof raw,
  });
  throw new Error(
    `normalizeEncuestaRecord: invalid encuesta_score type for record id=${record && record.id}`,
  );
}

/**
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * @param {string} table
 * @param {string} columns
 * @returns {Promise<object[]>}
 */
async function fetchAllRows(table, columns) {
  const all = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, to);
    if (error) {
      logger.error(`${table} page failed`, {
        from,
        to,
        error: error.message,
      });
      throw new Error(`${table} page failed: ${error.message}`);
    }
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/**
 * @param {string} lockedBy
 * @returns {Promise<boolean>}
 */
async function acquireProcessQueueLock(lockedBy) {
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_name: PROCESS_QUEUE_JOB_NAME,
    p_locked_by: lockedBy,
    p_ttl_seconds: PROCESS_QUEUE_LOCK_TTL_SECONDS,
  });
  if (error) {
    logger.error('acquire_job_lock failed', {
      jobName: PROCESS_QUEUE_JOB_NAME,
      error: error.message,
    });
    throw new Error(`acquire_job_lock failed: ${error.message}`);
  }
  return data === true;
}

/**
 * @param {string} lockedBy
 */
async function releaseProcessQueueLock(lockedBy) {
  const { error } = await supabase.rpc('release_job_lock', {
    p_job_name: PROCESS_QUEUE_JOB_NAME,
    p_locked_by: lockedBy,
  });
  if (error) {
    logger.error('release_job_lock failed', {
      jobName: PROCESS_QUEUE_JOB_NAME,
      lockedBy,
      error: error.message,
    });
  }
}

/**
 * Materialize recipients for a draft/scheduled campaign from cz_encuestas_synced.
 *
 * @param {unknown} campaignIdRaw
 * @returns {Promise<object>}
 */
async function materializeCampaign(campaignIdRaw) {
  const campaignId = normalizeCampaignId(campaignIdRaw);

  const { data: campaign, error: campaignErr } = await supabase
    .from('email_campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (campaignErr) {
    logger.error('materializeCampaign: campaign load failed', {
      campaignId,
      error: campaignErr.message,
    });
    throw new Error(`materializeCampaign: campaign load failed: ${campaignErr.message}`);
  }
  if (!campaign) {
    throw new Error(`materializeCampaign: campaign not found: ${campaignId}`);
  }

  if (!MATERIALIZE_ALLOWED_STATUSES.has(campaign.status)) {
    throw new Error(
      `materializeCampaign: campaign status must be draft or scheduled (got ${campaign.status})`,
    );
  }

  const { count: existingCount, error: countErr } = await supabase
    .from('email_campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId);

  if (countErr) {
    logger.error('materializeCampaign: recipients existence check failed', {
      campaignId,
      error: countErr.message,
    });
    throw new Error(
      `materializeCampaign: recipients existence check failed: ${countErr.message}`,
    );
  }
  if (typeof existingCount === 'number' && existingCount > 0) {
    throw new Error(
      `materializeCampaign: campaign ${campaignId} already has ${existingCount} recipients — refuse re-materialization`,
    );
  }

  if (campaign.segment_id == null) {
    throw new Error(`materializeCampaign: campaign ${campaignId} has no segment_id`);
  }

  const { data: segment, error: segmentErr } = await supabase
    .from('email_segments')
    .select('*')
    .eq('id', campaign.segment_id)
    .single();

  if (segmentErr) {
    logger.error('materializeCampaign: segment load failed', {
      campaignId,
      segmentId: campaign.segment_id,
      error: segmentErr.message,
    });
    throw new Error(`materializeCampaign: segment load failed: ${segmentErr.message}`);
  }
  if (!segment) {
    throw new Error(
      `materializeCampaign: segment not found: ${campaign.segment_id}`,
    );
  }

  validateRule(segment.rules);

  const rawEncuestas = await fetchAllRows('cz_encuestas_synced', '*');
  const normalizedEncuestas = [];
  for (const row of rawEncuestas) {
    normalizedEncuestas.push(normalizeEncuestaRecord(row));
  }

  const suppressions = await fetchAllRows('email_suppressions', 'email');
  const suppressedSet = new Set(
    suppressions.map((s) => normalizeEmail(s && s.email)).filter(Boolean),
  );

  let excludedNoEmail = 0;
  let excludedNoConsent = 0;
  let excludedSuppressed = 0;
  let excludedDuplicates = 0;

  const eligible = [];
  for (const record of normalizedEncuestas) {
    const emailNorm = normalizeEmail(record.email);
    if (!emailNorm) {
      excludedNoEmail += 1;
      continue;
    }
    if (record.marketing_consent !== true) {
      excludedNoConsent += 1;
      continue;
    }
    if (suppressedSet.has(emailNorm)) {
      excludedSuppressed += 1;
      continue;
    }
    eligible.push({ ...record, email: emailNorm });
  }

  const matched = filterBySegment(segment.rules, eligible);

  const seenEmails = new Set();
  const recipientRows = [];
  for (const record of matched) {
    const emailNorm = normalizeEmail(record.email);
    if (seenEmails.has(emailNorm)) {
      excludedDuplicates += 1;
      continue;
    }
    seenEmails.add(emailNorm);
    recipientRows.push({
      campaign_id: campaignId,
      idempotency_key: randomUUID(),
      ci: record.ci != null ? String(record.ci) : null,
      email: emailNorm,
      status: 'queued',
    });
  }

  let inserted = 0;
  if (recipientRows.length > 0) {
    for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
      const chunk = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
      const { error: insertErr } = await supabase
        .from('email_campaign_recipients')
        .insert(chunk);
      if (insertErr) {
        logger.error('materializeCampaign: recipients batch insert failed', {
          campaignId,
          batchStart: i,
          batchSize: chunk.length,
          error: insertErr.message,
        });
        throw new Error(
          `materializeCampaign: recipients batch insert failed: ${insertErr.message}`,
        );
      }
      inserted += chunk.length;
    }
  }

  const nextStatus = campaign.scheduled_at ? 'scheduled' : 'draft';
  const { error: updateErr } = await supabase
    .from('email_campaigns')
    .update({
      segment_rules_snapshot: segment.rules,
      recipient_count: inserted,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId);

  if (updateErr) {
    logger.error('materializeCampaign: campaign update failed', {
      campaignId,
      inserted,
      error: updateErr.message,
    });
    throw new Error(
      `materializeCampaign: campaign update failed: ${updateErr.message}`,
    );
  }

  logger.info('materializeCampaign completed', {
    campaignId,
    recipientCount: inserted,
    excluded: {
      noEmail: excludedNoEmail,
      noConsent: excludedNoConsent,
      suppressed: excludedSuppressed,
      duplicates: excludedDuplicates,
    },
  });

  return {
    campaignId,
    recipientCount: inserted,
    excluded: {
      noEmail: excludedNoEmail,
      noConsent: excludedNoConsent,
      suppressed: excludedSuppressed,
      duplicates: excludedDuplicates,
    },
  };
}

/**
 * @param {number} previousAttemptCount
 * @param {string} nowIso
 * @param {string} errorReason
 */
function buildFailurePatch(previousAttemptCount, nowIso, errorReason) {
  const newAttemptCount = previousAttemptCount + 1;
  const patch = {
    last_attempt_at: nowIso,
    attempt_count: newAttemptCount,
    error_reason: errorReason ? String(errorReason).slice(0, 2000) : null,
  };
  if (newAttemptCount === 1) {
    patch.status = 'queued';
    patch.next_attempt_at = new Date(
      Date.parse(nowIso) + 5 * 60 * 1000,
    ).toISOString();
  } else if (newAttemptCount === 2) {
    patch.status = 'queued';
    patch.next_attempt_at = new Date(
      Date.parse(nowIso) + 30 * 60 * 1000,
    ).toISOString();
  } else {
    patch.status = 'failed';
    patch.next_attempt_at = null;
  }
  return { patch, newAttemptCount, deferred: patch.status === 'queued' };
}

/**
 * @param {string|number} campaignId
 */
async function recalculateCampaignStatus(campaignId) {
  const { data: rows, error } = await supabase
    .from('email_campaign_recipients')
    .select('status')
    .eq('campaign_id', campaignId);

  if (error) {
    logger.error('recalculateCampaignStatus: select failed', {
      campaignId,
      error: error.message,
    });
    throw new Error(`recalculateCampaignStatus failed: ${error.message}`);
  }

  const list = rows || [];
  let queued = 0;
  let sent = 0;
  let failed = 0;
  for (const r of list) {
    if (r.status === 'queued') queued += 1;
    else if (r.status === 'sent') sent += 1;
    else if (r.status === 'failed') failed += 1;
  }

  let nextStatus = 'sending';
  if (queued > 0) {
    nextStatus = 'sending';
  } else if (sent > 0 && failed === 0) {
    nextStatus = 'completed';
  } else if (sent > 0 && failed > 0) {
    nextStatus = 'partial_error';
  } else if (sent === 0 && failed > 0) {
    nextStatus = 'error';
  } else {
    // No recipients left in known buckets — keep sending as safe default.
    nextStatus = 'sending';
  }

  const nowIso = new Date().toISOString();
  const updatePayload = {
    status: nextStatus,
    updated_at: nowIso,
  };
  if (nextStatus === 'completed') {
    updatePayload.sent_at = nowIso;
  }

  const { error: updErr } = await supabase
    .from('email_campaigns')
    .update(updatePayload)
    .eq('id', campaignId);

  if (updErr) {
    logger.error('recalculateCampaignStatus: update failed', {
      campaignId,
      nextStatus,
      error: updErr.message,
    });
    throw new Error(`recalculateCampaignStatus update failed: ${updErr.message}`);
  }

  return nextStatus;
}

/**
 * Process up to QUEUE_LIMIT queued recipients behind a job_locks mutex.
 *
 * @returns {Promise<object>}
 */
async function processQueue() {
  const lockedBy = randomUUID();
  const acquired = await acquireProcessQueueLock(lockedBy);
  if (!acquired) {
    return {
      skipped: true,
      reason: 'lock_not_acquired',
      jobName: PROCESS_QUEUE_JOB_NAME,
      selected: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
      skippedRecipients: 0,
      affectedCampaignIds: [],
    };
  }

  const summary = {
    selected: 0,
    sent: 0,
    failed: 0,
    deferred: 0,
    skipped: 0,
    affectedCampaignIds: [],
  };

  try {
    const fromAddr = (process.env.EMAIL_CAMPAIGNS_FROM || '').trim();
    if (!fromAddr) {
      logger.error('processQueue: EMAIL_CAMPAIGNS_FROM is not configured');
      throw new Error('EMAIL_CAMPAIGNS_FROM is not configured');
    }

    const nowIso = new Date().toISOString();
    const { data: recipients, error: queueErr } = await supabase
      .from('email_campaign_recipients')
      .select('*')
      .eq('status', 'queued')
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
      .order('created_at', { ascending: true })
      .limit(QUEUE_LIMIT);

    if (queueErr) {
      logger.error('processQueue: queue select failed', {
        error: queueErr.message,
      });
      throw new Error(`processQueue: queue select failed: ${queueErr.message}`);
    }

    const list = recipients || [];
    summary.selected = list.length;
    if (!list.length) {
      return summary;
    }

    const uniqueCampaignIds = [
      ...new Set(list.map((r) => String(r.campaign_id))),
    ];

    const { data: campaigns, error: campErr } = await supabase
      .from('email_campaigns')
      .select('*')
      .in('id', uniqueCampaignIds);

    if (campErr) {
      logger.error('processQueue: campaigns load failed', {
        error: campErr.message,
        uniqueCampaignIds,
      });
      throw new Error(`processQueue: campaigns load failed: ${campErr.message}`);
    }

    const campaignById = new Map();
    for (const c of campaigns || []) {
      campaignById.set(String(c.id), c);
    }

    const provider = getEmailProvider();
    const markedSending = new Set();
    const affected = new Set();

    for (const recipient of list) {
      const campaignId = String(recipient.campaign_id);
      const campaign = campaignById.get(campaignId);

      if (!campaign) {
        summary.skipped += 1;
        logger.error('processQueue: campaign missing for recipient', {
          recipientId: recipient.id,
          campaignId,
        });
        continue;
      }

      if (!SEND_ALLOWED_STATUSES.has(campaign.status)) {
        summary.skipped += 1;
        continue;
      }

      if (
        (campaign.status === 'draft' || campaign.status === 'scheduled') &&
        !markedSending.has(campaignId)
      ) {
        const { error: sendingErr } = await supabase
          .from('email_campaigns')
          .update({
            status: 'sending',
            updated_at: new Date().toISOString(),
          })
          .eq('id', campaignId)
          .in('status', ['draft', 'scheduled']);

        if (sendingErr) {
          logger.error('processQueue: failed to mark campaign sending', {
            campaignId,
            error: sendingErr.message,
          });
          throw new Error(
            `processQueue: failed to mark campaign sending: ${sendingErr.message}`,
          );
        }
        campaign.status = 'sending';
        markedSending.add(campaignId);
      }

      affected.add(campaignId);
      const attemptAt = new Date().toISOString();
      const previousAttemptCount = Number(recipient.attempt_count) || 0;

      let sendResult;
      try {
        sendResult = await provider.send({
          to: recipient.email,
          subject: campaign.subject,
          html: campaign.body_html,
          from: fromAddr,
        });
      } catch (sendErr) {
        const reason =
          sendErr && sendErr.message ? sendErr.message : 'send failed';
        const { patch, deferred } = buildFailurePatch(
          previousAttemptCount,
          attemptAt,
          reason,
        );
        const { error: failUpdErr } = await supabase
          .from('email_campaign_recipients')
          .update(patch)
          .eq('id', recipient.id);

        if (failUpdErr) {
          logger.error('processQueue: failed to persist send failure', {
            recipientId: recipient.id,
            campaignId,
            error: failUpdErr.message,
          });
          throw new Error(
            `processQueue: failed to persist send failure: ${failUpdErr.message}`,
          );
        }

        if (deferred) summary.deferred += 1;
        else summary.failed += 1;
        continue;
      }

      const successPatch = {
        status: 'sent',
        provider_message_id: sendResult.providerMessageId,
        sent_at: attemptAt,
        last_attempt_at: attemptAt,
        next_attempt_at: null,
        attempt_count: previousAttemptCount + 1,
        error_reason: null,
      };

      const { error: successUpdErr } = await supabase
        .from('email_campaign_recipients')
        .update(successPatch)
        .eq('id', recipient.id);

      if (successUpdErr) {
        logger.error(
          'ALERT: provider confirmed send but recipient update failed',
          {
            recipientId: recipient.id,
            campaignId,
            providerMessageId: sendResult.providerMessageId,
            idempotencyKey: recipient.idempotency_key,
            error: successUpdErr.message,
          },
        );
        // Do not retry send in this run.
        summary.skipped += 1;
        continue;
      }

      summary.sent += 1;
    }

    summary.affectedCampaignIds = [...affected];
    for (const campaignId of summary.affectedCampaignIds) {
      await recalculateCampaignStatus(campaignId);
    }

    logger.info('processQueue completed', summary);
    return summary;
  } finally {
    await releaseProcessQueueLock(lockedBy);
  }
}

module.exports = {
  materializeCampaign,
  processQueue,
  normalizeEncuestaRecord,
  normalizeCampaignId,
  PROCESS_QUEUE_JOB_NAME,
};
