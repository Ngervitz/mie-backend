'use strict';

/**
 * Job: sms_notifyme_poll
 * Cadence: every 5 min via cron-job.org → POST /jobs/run-sms-notifyme-poll
 *
 * Polls NotifyMe status + responses for recent non-error campaigns.
 * Does not invent message statuses. Excludes campaign.status='error'.
 */

const { randomUUID } = require('crypto');
const logger = require('../lib/logger');
const {
  AUTO_POLL_CUTOFF_HOURS,
  listAutoPollCampaigns,
  pollCampaignNotifyme,
} = require('../lib/smsNotifymePoll');

const JOB_NAME = 'sms_notifyme_poll';
/** Longer than cron cadence (5m); short enough to recover from crashed runs. */
const JOB_LOCK_TTL_SECONDS = 10 * 60;

function getSupabase(override) {
  if (override) return override;
  return require('../clients/supabase');
}

async function acquireJobLock(lockedBy, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
    p_ttl_seconds: JOB_LOCK_TTL_SECONDS,
  });
  if (error) {
    throw new Error(`acquire_job_lock failed: ${error.message}`);
  }
  return data === true;
}

async function releaseJobLock(lockedBy, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { error } = await supabase.rpc('release_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
  });
  if (error) {
    logger.error('release_job_lock failed', {
      jobName: JOB_NAME,
      lockedBy: lockedBy,
      error: error.message,
    });
  }
}

/**
 * @param {{
 *   supabase?: object,
 *   now?: Date,
 *   cutoffHours?: number,
 *   pollCampaignFn?: Function,
 *   listCampaignsFn?: Function,
 *   acquireLockFn?: Function,
 *   releaseLockFn?: Function,
 * }} [opts]
 */
async function runSmsNotifymePoll(opts) {
  const options = opts || {};
  const lockedBy = randomUUID();
  const acquire =
    options.acquireLockFn ||
    function (id) {
      return acquireJobLock(id, options.supabase);
    };
  const release =
    options.releaseLockFn ||
    function (id) {
      return releaseJobLock(id, options.supabase);
    };

  const acquired = await acquire(lockedBy);
  if (!acquired) {
    return {
      ok: false,
      skipped: true,
      reason: 'lock_not_acquired',
      jobName: JOB_NAME,
    };
  }

  const summary = {
    ok: true,
    jobName: JOB_NAME,
    lockedBy: lockedBy,
    cutoffHours:
      options.cutoffHours != null ? options.cutoffHours : AUTO_POLL_CUTOFF_HOURS,
    campaignsConsidered: 0,
    campaignsPolled: 0,
    campaignsFailed: 0,
    statusRequested: 0,
    statusUpdated: 0,
    responseRequested: 0,
    responseUpdated: 0,
    errors: [],
  };

  try {
    const listFn =
      options.listCampaignsFn ||
      function () {
        return listAutoPollCampaigns({
          supabase: options.supabase,
          now: options.now || new Date(),
          cutoffHours: summary.cutoffHours,
        });
      };
    const pollFn =
      options.pollCampaignFn ||
      function (campaignId) {
        return pollCampaignNotifyme(campaignId, {
          skipDeliveredForStatus: true,
          supabase: options.supabase,
        });
      };

    const campaigns = await listFn();
    summary.campaignsConsidered = (campaigns || []).length;

    for (let i = 0; i < (campaigns || []).length; i += 1) {
      const camp = campaigns[i];
      if (!camp || !camp.id) continue;
      try {
        const result = await pollFn(camp.id);
        summary.campaignsPolled += 1;
        if (result && result.status_poll) {
          summary.statusRequested += Number(result.status_poll.requested) || 0;
          summary.statusUpdated += Number(result.status_poll.updated) || 0;
        }
        if (result && result.response_poll) {
          summary.responseRequested +=
            Number(result.response_poll.requested) || 0;
          summary.responseUpdated += Number(result.response_poll.updated) || 0;
        }
      } catch (err) {
        summary.campaignsFailed += 1;
        summary.ok = false;
        summary.errors.push({
          campaign_id: camp.id,
          error: err && err.message ? String(err.message).slice(0, 500) : 'unknown',
        });
        logger.error('sms_notifyme_poll campaign failed', {
          campaignId: camp.id,
          error: err && err.message ? err.message : 'unknown',
        });
      }
    }

    logger.info('sms_notifyme_poll completed', {
      campaignsConsidered: summary.campaignsConsidered,
      campaignsPolled: summary.campaignsPolled,
      campaignsFailed: summary.campaignsFailed,
      statusRequested: summary.statusRequested,
      statusUpdated: summary.statusUpdated,
      responseRequested: summary.responseRequested,
      responseUpdated: summary.responseUpdated,
      cutoffHours: summary.cutoffHours,
    });

    return summary;
  } finally {
    await release(lockedBy);
  }
}

module.exports = {
  runSmsNotifymePoll,
  JOB_NAME,
  JOB_LOCK_TTL_SECONDS,
  AUTO_POLL_CUTOFF_HOURS,
};
