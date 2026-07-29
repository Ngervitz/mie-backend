-- Instagram comments module for Credizona (@credizonauy).
-- Autonomous: does not touch activity_metrics, monitored_entities, or Meta Ad Library tables.
-- Apply manually in Supabase.

BEGIN;

-- Shared updated_at trigger helper (idempotent).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.social_media_posts (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform                text NOT NULL
    CHECK (platform IN ('instagram', 'facebook')),
  ig_media_id             text NOT NULL UNIQUE,
  media_type              text,
  permalink               text,
  caption                 text,
  media_timestamp         timestamptz NOT NULL,
  is_polling_active       boolean NOT NULL DEFAULT false,
  last_comment_seen_at    timestamptz,
  last_comment_id         text,
  last_polled_at          timestamptz,
  last_poll_status        text
    CHECK (last_poll_status IN ('success', 'error') OR last_poll_status IS NULL),
  last_poll_error         text,
  last_poll_duration_ms   integer,
  last_successful_poll    timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.social_media_posts.last_comment_seen_at IS
  'comment_timestamp MAX among comments processed in a fully successful pagination cycle for this post. Not advanced on partial/failed polls.';
COMMENT ON COLUMN public.social_media_posts.last_comment_id IS
  'ig_comment_id of the comment that won last_comment_seen_at (tie-break: greater ig_comment_id text). Not advanced on partial/failed polls.';

CREATE INDEX IF NOT EXISTS idx_social_media_posts_media_timestamp
  ON public.social_media_posts (media_timestamp DESC);

CREATE TABLE IF NOT EXISTS public.social_comments (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  social_media_post_id  bigint NOT NULL REFERENCES public.social_media_posts(id),
  platform              text NOT NULL
    CHECK (platform IN ('instagram', 'facebook')),
  ig_comment_id         text NOT NULL UNIQUE,
  ig_media_id           text NOT NULL,
  from_username         text,
  from_ig_user_id       text,
  text                  text,
  comment_timestamp     timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'replying', 'replied', 'ignored')),
  reply_source          text
    CHECK (reply_source IN ('metadash', 'instagram', 'facebook') OR reply_source IS NULL),
  replied_text          text,
  ig_reply_id           text,
  replied_by            text,
  replied_at            timestamptz,
  reply_started_at      timestamptz,
  reply_attempted_at    timestamptz,
  reply_error           text,
  last_checked_at       timestamptz,
  is_deleted            boolean NOT NULL DEFAULT false,
  deleted_at            timestamptz,
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.social_comments.fetched_at IS
  'First time this system detected the comment. Never modified after insert.';
COMMENT ON COLUMN public.social_comments.last_checked_at IS
  'Last time /replies was queried on Meta for reconciliation. Null until first reply attempt.';
COMMENT ON COLUMN public.social_comments.is_deleted IS
  'Set only when a direct comment or /replies call shows the comment is gone/inaccessible. No historical sweep for deletions.';
COMMENT ON COLUMN public.social_comments.deleted_at IS
  'Timestamp when is_deleted was set true during reply flow or recovery.';
COMMENT ON COLUMN public.social_comments.replied_by IS
  'Free-form actor id, e.g. user:nicolas | process:auto_reply | external:instagram';

CREATE INDEX IF NOT EXISTS idx_social_comments_post_id
  ON public.social_comments (social_media_post_id);

CREATE INDEX IF NOT EXISTS idx_social_comments_status_replying
  ON public.social_comments (status, reply_started_at)
  WHERE status = 'replying';

CREATE TABLE IF NOT EXISTS public.job_locks (
  job_name    text PRIMARY KEY,
  locked_at   timestamptz NOT NULL,
  locked_by   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.job_locks.locked_by IS
  'UUID generated at the start of each job run. Used to acquire, own-check, and release the lock. Never hostname/PID.';

-- Shared Meta API hourly budget for @credizonauy Instagram calls.
CREATE TABLE IF NOT EXISTS public.meta_api_rate_budget (
  bucket_key          text PRIMARY KEY,
  window_started_at   timestamptz NOT NULL,
  calls_reserved      integer NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.meta_api_rate_budget IS
  'Atomic shared hourly call budget for graph.instagram.com jobs (posts sync, comments poll, reply recovery).';

DROP TRIGGER IF EXISTS trg_social_media_posts_updated_at ON public.social_media_posts;
CREATE TRIGGER trg_social_media_posts_updated_at
  BEFORE UPDATE ON public.social_media_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_social_comments_updated_at ON public.social_comments;
CREATE TRIGGER trg_social_comments_updated_at
  BEFORE UPDATE ON public.social_comments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_job_locks_updated_at ON public.job_locks;
CREATE TRIGGER trg_job_locks_updated_at
  BEFORE UPDATE ON public.job_locks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_meta_api_rate_budget_updated_at ON public.meta_api_rate_budget;
CREATE TRIGGER trg_meta_api_rate_budget_updated_at
  BEFORE UPDATE ON public.meta_api_rate_budget
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Acquire lock: INSERT or take over if expired. Returns true if this locked_by owns it.
CREATE OR REPLACE FUNCTION public.acquire_job_lock(
  p_job_name text,
  p_locked_by text,
  p_ttl_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_expires timestamptz := now() + make_interval(secs => p_ttl_seconds);
  v_row public.job_locks%ROWTYPE;
BEGIN
  INSERT INTO public.job_locks (job_name, locked_at, locked_by, expires_at)
  VALUES (p_job_name, v_now, p_locked_by, v_expires)
  ON CONFLICT (job_name) DO UPDATE
    SET
      locked_at = EXCLUDED.locked_at,
      locked_by = EXCLUDED.locked_by,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
    WHERE public.job_locks.expires_at < v_now
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN v_row.locked_by = p_locked_by;
END;
$$;

-- Release only if still owned by this run.
CREATE OR REPLACE FUNCTION public.release_job_lock(
  p_job_name text,
  p_locked_by text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.job_locks
  WHERE job_name = p_job_name
    AND locked_by = p_locked_by;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

-- Confirm lock still owned by this run (before writing partial results).
CREATE OR REPLACE FUNCTION public.confirm_job_lock(
  p_job_name text,
  p_locked_by text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.job_locks
    WHERE job_name = p_job_name
      AND locked_by = p_locked_by
      AND expires_at >= now()
  ) INTO v_ok;
  RETURN v_ok;
END;
$$;

-- Atomic check-and-reserve against shared hourly budget.
-- Resets window when expired. Returns true if reservation succeeded.
CREATE OR REPLACE FUNCTION public.reserve_meta_api_budget(
  p_bucket_key text,
  p_calls integer,
  p_hourly_limit integer,
  p_window_seconds integer DEFAULT 3600
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_row public.meta_api_rate_budget%ROWTYPE;
  v_window_end timestamptz;
BEGIN
  IF p_calls IS NULL OR p_calls < 1 THEN
    RETURN false;
  END IF;

  INSERT INTO public.meta_api_rate_budget (bucket_key, window_started_at, calls_reserved)
  VALUES (p_bucket_key, v_now, 0)
  ON CONFLICT (bucket_key) DO NOTHING;

  SELECT * INTO v_row
  FROM public.meta_api_rate_budget
  WHERE bucket_key = p_bucket_key
  FOR UPDATE;

  v_window_end := v_row.window_started_at + make_interval(secs => p_window_seconds);
  IF v_now >= v_window_end THEN
    v_row.window_started_at := v_now;
    v_row.calls_reserved := 0;
  END IF;

  IF v_row.calls_reserved + p_calls > p_hourly_limit THEN
    UPDATE public.meta_api_rate_budget
    SET
      window_started_at = v_row.window_started_at,
      calls_reserved = v_row.calls_reserved,
      updated_at = now()
    WHERE bucket_key = p_bucket_key;
    RETURN false;
  END IF;

  UPDATE public.meta_api_rate_budget
  SET
    window_started_at = v_row.window_started_at,
    calls_reserved = v_row.calls_reserved + p_calls,
    updated_at = now()
  WHERE bucket_key = p_bucket_key;

  RETURN true;
END;
$$;

COMMIT;
