const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  JOB_NAMES,
  JOB_LOCK_TTL_SECONDS,
  REPLY_STUCK_MINUTES,
  getAccessToken,
} = require('../services/facebook-comments/config');
const {
  acquireJobLock,
  releaseJobLock,
} = require('../services/facebook-comments/locks');
const { runReplyFlow } = require('../services/facebook-comments/reply-flow');

/**
 * Job 3: recover stuck Facebook 'replying' comments via reconcile-first reply flow.
 * Independent of the comments poll job.
 */
async function runFacebookReplyRecovery() {
  if (!getAccessToken()) {
    return {
      ok: false,
      error: 'FB_CREDIZONAUY_PAGE_ACCESS_TOKEN is not configured',
      code: 'MISSING_FB_TOKEN',
    };
  }

  const lockedBy = randomUUID();
  const jobName = JOB_NAMES.replyRecovery;
  const acquired = await acquireJobLock(
    jobName,
    lockedBy,
    JOB_LOCK_TTL_SECONDS.replyRecovery,
  );

  if (!acquired) {
    return {
      ok: false,
      skipped: true,
      reason: 'lock_not_acquired',
      jobName,
    };
  }

  const summary = {
    ok: true,
    jobName,
    lockedBy,
    stuckFound: 0,
    recovered: 0,
    deleted: 0,
    reverted: 0,
    errors: 0,
    rateLimited: false,
    budgetExhausted: false,
    results: [],
  };

  try {
    const cutoff = new Date(
      Date.now() - REPLY_STUCK_MINUTES * 60 * 1000,
    ).toISOString();

    const { data: stuck, error } = await supabase
      .from('social_comments')
      .select('*')
      .eq('platform', 'facebook')
      .eq('status', 'replying')
      .lt('reply_started_at', cutoff);

    if (error) {
      throw new Error(`stuck replies query failed: ${error.message}`);
    }

    const rows = stuck || [];
    summary.stuckFound = rows.length;

    for (const row of rows) {
      try {
        const result = await runReplyFlow({
          commentId: row.id,
          replyText: null,
          repliedBy: 'process:reply_recovery',
          skipOptimisticLock: true,
          commentRow: row,
        });

        summary.results.push({
          id: row.id,
          outcome: result.outcome,
        });

        if (result.outcome === 'deleted') summary.deleted += 1;
        else if (
          result.outcome === 'already_replied' ||
          result.outcome === 'reverted' ||
          result.outcome === 'published'
        ) {
          summary.recovered += 1;
          if (result.outcome === 'reverted') summary.reverted += 1;
        } else if (
          result.outcome === 'transient_error' ||
          result.outcome === 'meta_error'
        ) {
          summary.reverted += 1;
          if (result.rateLimited) {
            summary.rateLimited = true;
            summary.message = result.body && result.body.error;
            break;
          }
        } else {
          summary.errors += 1;
        }
      } catch (err) {
        summary.errors += 1;
        logger.error('facebook_reply_recovery item failed', {
          commentId: row.id,
          error: err && err.message ? err.message : 'unknown',
        });
      }
    }

    logger.info('facebook_reply_recovery completed', summary);
    return summary;
  } finally {
    await releaseJobLock(jobName, lockedBy);
  }
}

module.exports = { runFacebookReplyRecovery };
