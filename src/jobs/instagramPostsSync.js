const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  IG_USER_ID,
  MEDIA_LOOKBACK_DAYS,
  JOB_NAMES,
  JOB_LOCK_TTL_SECONDS,
  getAccessToken,
} = require('../services/instagram-comments/config');
const {
  acquireJobLock,
  releaseJobLock,
} = require('../services/instagram-comments/locks');
const {
  listMedia,
  InstagramGraphError,
} = require('../services/instagram-comments/graph-client');

/**
 * Job 1: sync Instagram media catalog into social_media_posts.
 * Does not touch poll cursors or is_polling_active.
 */
async function runInstagramPostsSync() {
  if (!getAccessToken()) {
    return {
      ok: false,
      error: 'IG_CREDIZONAUY_ACCESS_TOKEN is not configured',
      code: 'MISSING_IG_TOKEN',
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
    // Budget is reserved atomically inside each graph.instagram.com call.
    const until = Date.now() - MEDIA_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    let mediaItems;
    try {
      const result = await listMedia({
        userId: IG_USER_ID,
        untilTimestampMs: until,
      });
      mediaItems = result.items || [];
    } catch (err) {
      if (err instanceof InstagramGraphError && err.isRateLimited) {
        summary.rateLimited = true;
        summary.budgetExhausted = err.metaCode === 'budget';
        summary.message = err.message;
        return summary;
      }
      throw err;
    }

    // Filter to lookback window (paginate may include one older page).
    const inWindow = mediaItems.filter((m) => {
      if (!m || !m.id) return false;
      if (!m.timestamp) return true;
      const ts = Date.parse(m.timestamp);
      return !Number.isFinite(ts) || ts >= until;
    });

    summary.mediaFetched = inWindow.length;

    for (const media of inWindow) {
      const igMediaId = String(media.id);
      const rowBasics = {
        platform: 'instagram',
        ig_media_id: igMediaId,
        media_type: media.media_type || null,
        permalink: media.permalink || null,
        caption: media.caption != null ? String(media.caption) : null,
        media_timestamp: media.timestamp
          ? new Date(media.timestamp).toISOString()
          : new Date().toISOString(),
      };

      const { data: existing, error: selErr } = await supabase
        .from('social_media_posts')
        .select('id')
        .eq('ig_media_id', igMediaId)
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
        // Update only catalog fields — never poll cursors / is_polling_active.
        const { error: updErr } = await supabase
          .from('social_media_posts')
          .update({
            media_type: rowBasics.media_type,
            permalink: rowBasics.permalink,
            caption: rowBasics.caption,
            media_timestamp: rowBasics.media_timestamp,
          })
          .eq('ig_media_id', igMediaId);
        if (updErr) {
          throw new Error(`social_media_posts update failed: ${updErr.message}`);
        }
        summary.updated += 1;
      }
    }

    logger.info('instagram_posts_sync completed', summary);
    return summary;
  } finally {
    await releaseJobLock(jobName, lockedBy);
  }
}

module.exports = { runInstagramPostsSync };
