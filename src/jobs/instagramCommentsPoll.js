const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  COMMENT_POLL_LOOKBACK_DAYS,
  JOB_NAMES,
  JOB_LOCK_TTL_SECONDS,
  getAccessToken,
} = require('../services/instagram-comments/config');
const {
  acquireJobLock,
  releaseJobLock,
  confirmJobLock,
} = require('../services/instagram-comments/locks');
const {
  listTopLevelComments,
  InstagramGraphError,
} = require('../services/instagram-comments/graph-client');

/**
 * Pick the winning cursor comment: max comment_timestamp, tie-break greater ig_comment_id text.
 */
function pickCursorWinner(comments) {
  if (!comments.length) return null;
  let best = comments[0];
  for (let i = 1; i < comments.length; i += 1) {
    const c = comments[i];
    const bt = Date.parse(best.comment_timestamp) || 0;
    const ct = Date.parse(c.comment_timestamp) || 0;
    if (ct > bt) {
      best = c;
      continue;
    }
    if (ct === bt && String(c.ig_comment_id) > String(best.ig_comment_id)) {
      best = c;
    }
  }
  return best;
}

function mapMetaComment(raw, post) {
  const from = raw.from || {};
  return {
    social_media_post_id: post.id,
    platform: 'instagram',
    ig_comment_id: String(raw.id),
    ig_media_id: post.ig_media_id,
    from_username:
      raw.username != null
        ? String(raw.username)
        : from.username != null
          ? String(from.username)
          : null,
    from_ig_user_id: from.id != null ? String(from.id) : null,
    text: raw.text != null ? String(raw.text) : null,
    comment_timestamp: raw.timestamp
      ? new Date(raw.timestamp).toISOString()
      : new Date().toISOString(),
  };
}

async function upsertCommentBasics(mapped) {
  const { data: existing, error: selErr } = await supabase
    .from('social_comments')
    .select('id')
    .eq('ig_comment_id', mapped.ig_comment_id)
    .maybeSingle();

  if (selErr) {
    throw new Error(`social_comments select failed: ${selErr.message}`);
  }

  if (!existing) {
    const { error: insErr } = await supabase.from('social_comments').insert({
      ...mapped,
      status: 'pending',
      fetched_at: new Date().toISOString(),
    });
    if (insErr) {
      throw new Error(`social_comments insert failed: ${insErr.message}`);
    }
    return 'inserted';
  }

  // Only refresh basic fields — never status / reply_* / is_deleted / fetched_at.
  const { error: updErr } = await supabase
    .from('social_comments')
    .update({
      text: mapped.text,
      from_username: mapped.from_username,
      from_ig_user_id: mapped.from_ig_user_id,
    })
    .eq('ig_comment_id', mapped.ig_comment_id);
  if (updErr) {
    throw new Error(`social_comments update failed: ${updErr.message}`);
  }
  return 'updated';
}

async function pollOnePost(post, { jobName, lockedBy }) {
  const started = Date.now();
  const mappedComments = [];

  try {
    const { items } = await listTopLevelComments(post.ig_media_id);
    for (const raw of items) {
      if (!raw || !raw.id) continue;
      mappedComments.push(mapMetaComment(raw, post));
    }

    for (const mapped of mappedComments) {
      await upsertCommentBasics(mapped);
    }

    const stillOwned = await confirmJobLock(jobName, lockedBy);
    if (!stillOwned) {
      logger.warn('instagram_comments_poll discarded post result — lock lost', {
        igMediaId: post.ig_media_id,
        lockedBy,
      });
      return { status: 'discarded_lock_lost' };
    }

    const durationMs = Date.now() - started;
    const winner = pickCursorWinner(mappedComments);
    const patch = {
      last_polled_at: new Date().toISOString(),
      last_poll_status: 'success',
      last_poll_error: null,
      last_poll_duration_ms: durationMs,
      last_successful_poll: new Date().toISOString(),
    };
    if (winner) {
      patch.last_comment_seen_at = winner.comment_timestamp;
      patch.last_comment_id = winner.ig_comment_id;
    }

    const { error: updErr } = await supabase
      .from('social_media_posts')
      .update(patch)
      .eq('id', post.id);
    if (updErr) {
      throw new Error(`post poll success update failed: ${updErr.message}`);
    }

    return {
      status: 'success',
      commentsSeen: mappedComments.length,
      durationMs,
    };
  } catch (err) {
    if (err instanceof InstagramGraphError && err.isRateLimited) {
      throw err;
    }

    const stillOwned = await confirmJobLock(jobName, lockedBy);
    if (stillOwned) {
      const durationMs = Date.now() - started;
      await supabase
        .from('social_media_posts')
        .update({
          last_poll_status: 'error',
          last_poll_error: (err && err.message ? err.message : 'unknown').slice(
            0,
            2000,
          ),
          last_poll_duration_ms: durationMs,
        })
        .eq('id', post.id);
    }

    return {
      status: 'error',
      error: err && err.message ? err.message : 'unknown',
    };
  }
}

/**
 * Job 2: poll top-level comments for eligible posts.
 */
async function runInstagramCommentsPoll() {
  if (!getAccessToken()) {
    return {
      ok: false,
      error: 'IG_CREDIZONAUY_ACCESS_TOKEN is not configured',
      code: 'MISSING_IG_TOKEN',
    };
  }

  const lockedBy = randomUUID();
  const jobName = JOB_NAMES.commentsPoll;
  const acquired = await acquireJobLock(
    jobName,
    lockedBy,
    JOB_LOCK_TTL_SECONDS.commentsPoll,
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
    postsEligible: 0,
    postsSuccess: 0,
    postsError: 0,
    postsDiscarded: 0,
    rateLimited: false,
    budgetExhausted: false,
  };

  try {
    // Budget is reserved atomically inside each graph.instagram.com call.
    const cutoff = new Date(
      Date.now() - COMMENT_POLL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Eligible: recent OR manually kept active. Fetch both sets and merge by id.
    const { data: recent, error: recentErr } = await supabase
      .from('social_media_posts')
      .select('*')
      .eq('platform', 'instagram')
      .gte('media_timestamp', cutoff);

    if (recentErr) {
      throw new Error(`eligible posts (recent) query failed: ${recentErr.message}`);
    }

    const { data: active, error: activeErr } = await supabase
      .from('social_media_posts')
      .select('*')
      .eq('platform', 'instagram')
      .eq('is_polling_active', true);

    if (activeErr) {
      throw new Error(`eligible posts (active) query failed: ${activeErr.message}`);
    }

    const byId = new Map();
    for (const p of recent || []) byId.set(p.id, p);
    for (const p of active || []) byId.set(p.id, p);
    const posts = [...byId.values()];
    summary.postsEligible = posts.length;

    for (const post of posts) {
      try {
        const result = await pollOnePost(post, { jobName, lockedBy });
        if (result.status === 'success') summary.postsSuccess += 1;
        else if (result.status === 'discarded_lock_lost') summary.postsDiscarded += 1;
        else summary.postsError += 1;
      } catch (err) {
        if (err instanceof InstagramGraphError && err.isRateLimited) {
          summary.rateLimited = true;
          summary.budgetExhausted = err.metaCode === 'budget';
          summary.message = err.message;
          // Stop immediately — no blocking backoff; next cron-job.org tick retries.
          break;
        }
        summary.postsError += 1;
        logger.error('instagram_comments_poll post failed unexpectedly', {
          igMediaId: post.ig_media_id,
          error: err && err.message ? err.message : 'unknown',
        });
      }
    }

    logger.info('instagram_comments_poll completed', summary);
    return summary;
  } finally {
    await releaseJobLock(jobName, lockedBy);
  }
}

module.exports = { runInstagramCommentsPoll };
