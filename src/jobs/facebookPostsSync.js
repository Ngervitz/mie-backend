const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  FB_PAGE_ID,
  MEDIA_LOOKBACK_DAYS,
  JOB_NAMES,
  JOB_LOCK_TTL_SECONDS,
  getAccessToken,
} = require('../services/facebook-comments/config');
const {
  acquireJobLock,
  releaseJobLock,
} = require('../services/facebook-comments/locks');
const {
  listFeed,
  FacebookGraphError,
} = require('../services/facebook-comments/graph-client');

/**
 * Job 1: sync Facebook Page feed into social_media_posts (platform=facebook).
 * Does not touch poll cursors or is_polling_active.
 */
async function runFacebookPostsSync() {
  if (!getAccessToken()) {
    return {
      ok: false,
      error: 'FB_CREDIZONAUY_PAGE_ACCESS_TOKEN is not configured',
      code: 'MISSING_FB_TOKEN',
    };
  }

  const lockedBy = randomUUID();
  const jobName = JOB_NAMES.postsSync;
  const acquired = await acquireJobLock(
    jobName,
    lockedBy,
    JOB_LOCK_TTL_SECONDS.postsSync,
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
    mediaFetched: 0,
    inserted: 0,
    updated: 0,
    rateLimited: false,
    budgetExhausted: false,
  };

  try {
    const until = Date.now() - MEDIA_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    let feedItems;
    try {
      const result = await listFeed({
        pageId: FB_PAGE_ID,
        untilTimestampMs: until,
      });
      feedItems = result.items || [];
    } catch (err) {
      if (err instanceof FacebookGraphError && err.isRateLimited) {
        summary.rateLimited = true;
        summary.budgetExhausted = err.metaCode === 'budget';
        summary.message = err.message;
        return summary;
      }
      throw err;
    }

    const inWindow = feedItems.filter((m) => {
      if (!m || !m.id) return false;
      if (!m.created_time) return true;
      const ts = Date.parse(m.created_time);
      return !Number.isFinite(ts) || ts >= until;
    });

    summary.mediaFetched = inWindow.length;

    for (const post of inWindow) {
      const fbPostId = String(post.id);
      const rowBasics = {
        platform: 'facebook',
        ig_media_id: fbPostId,
        media_type: null,
        permalink: post.permalink_url || null,
        caption: post.message != null ? String(post.message) : null,
        media_timestamp: post.created_time
          ? new Date(post.created_time).toISOString()
          : new Date().toISOString(),
      };

      const { data: existing, error: selErr } = await supabase
        .from('social_media_posts')
        .select('id')
        .eq('platform', 'facebook')
        .eq('ig_media_id', fbPostId)
        .maybeSingle();

      if (selErr) {
        throw new Error(`social_media_posts select failed: ${selErr.message}`);
      }

      if (!existing) {
        const { error: insErr } = await supabase
          .from('social_media_posts')
          .insert(rowBasics);
        if (insErr) {
          throw new Error(`social_media_posts insert failed: ${insErr.message}`);
        }
        summary.inserted += 1;
      } else {
        const { error: updErr } = await supabase
          .from('social_media_posts')
          .update({
            media_type: rowBasics.media_type,
            permalink: rowBasics.permalink,
            caption: rowBasics.caption,
            media_timestamp: rowBasics.media_timestamp,
          })
          .eq('platform', 'facebook')
          .eq('ig_media_id', fbPostId);
        if (updErr) {
          throw new Error(`social_media_posts update failed: ${updErr.message}`);
        }
        summary.updated += 1;
      }
    }

    logger.info('facebook_posts_sync completed', summary);
    return summary;
  } finally {
    await releaseJobLock(jobName, lockedBy);
  }
}

module.exports = { runFacebookPostsSync };
