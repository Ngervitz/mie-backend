const { randomUUID } = require('crypto');
const logger = require('../lib/logger');
const {
  getAccessToken,
  DMS_SYNC_JOB_NAME,
  DMS_SYNC_LOCK_TTL_SECONDS,
} = require('../services/instagram-dms/config');
const {
  acquireJobLock,
  releaseJobLock,
} = require('../services/instagram-comments/locks');
const {
  listConversations,
  InstagramGraphError,
} = require('../services/instagram-dms/graph');
const {
  syncOneConversation,
  markConversationSyncError,
} = require('../services/instagram-dms/sync');

/**
 * Job: instagram_dms_sync
 * Cadence: every 5 min via cron-job.org (prefer BEFORE comments_poll for budget).
 * Folders Primary/General/Requests: v1 does not filter — polls /conversations as returned.
 */
async function runInstagramDmsSync() {
  if (!getAccessToken()) {
    return {
      ok: false,
      error: 'IG_CREDIZONAUY_ACCESS_TOKEN is not configured',
      code: 'MISSING_IG_TOKEN',
    };
  }

  const lockedBy = randomUUID();
  const jobName = DMS_SYNC_JOB_NAME;
  const acquired = await acquireJobLock(
    jobName,
    lockedBy,
    DMS_SYNC_LOCK_TTL_SECONDS,
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
    conversationsListed: 0,
    conversationsSynced: 0,
    conversationsError: 0,
    messagesUpserted: 0,
    rateLimited: false,
    budgetExhausted: false,
  };

  try {
    let conversations;
    try {
      const listed = await listConversations();
      conversations = listed.items || [];
    } catch (err) {
      if (err instanceof InstagramGraphError && err.isRateLimited) {
        summary.rateLimited = true;
        summary.budgetExhausted = err.metaCode === 'budget';
        summary.message = err.message;
        return summary;
      }
      throw err;
    }

    summary.conversationsListed = conversations.length;

    for (const conv of conversations) {
      if (!conv || !conv.id) continue;
      const igConversationId = String(conv.id);
      try {
        const result = await syncOneConversation({
          igConversationId,
          participantsFromList: conv.participants || null,
        });
        summary.conversationsSynced += 1;
        summary.messagesUpserted += result.messagesUpserted || 0;
      } catch (err) {
        if (err instanceof InstagramGraphError && err.isRateLimited) {
          summary.rateLimited = true;
          summary.budgetExhausted = err.metaCode === 'budget';
          summary.message = err.message;
          break;
        }
        summary.conversationsError += 1;
        await markConversationSyncError(
          igConversationId,
          err && err.message ? err.message : 'unknown',
        );
        logger.error('instagram_dms_sync conversation failed', {
          igConversationId,
          error: err && err.message ? err.message : 'unknown',
        });
      }
    }

    logger.info('instagram_dms_sync completed', summary);
    return summary;
  } finally {
    await releaseJobLock(jobName, lockedBy);
  }
}

module.exports = { runInstagramDmsSync };
