-- Dashboard multi-user auth + per-section permissions (V1).
-- Apply manually in Supabase. No automatic migration of the old shared password.
--
-- After applying: bootstrap the first admin via POST /admin/bootstrap-first-admin
-- (uses DASHBOARD_LOGIN_PASSWORD once). Then REMOVE DASHBOARD_LOGIN_PASSWORD
-- from Railway env — it must not remain as a permanent login backdoor.
-- Additional collaborators: insert into dashboard_users + dashboard_user_permissions
-- via SQL (no admin UI in V1).

BEGIN;

CREATE TABLE IF NOT EXISTS public.dashboard_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_users_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS public.dashboard_user_permissions (
  user_id uuid NOT NULL REFERENCES public.dashboard_users (id) ON DELETE CASCADE,
  section_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_user_permissions_pkey PRIMARY KEY (user_id, section_key),
  CONSTRAINT dashboard_user_permissions_section_key_check CHECK (
    section_key IN (
      'market',
      'discoveries',
      'ai-visibility',
      'ga4',
      'searchconsole',
      'meta',
      'sms',
      'email',
      'inbox'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_dashboard_user_permissions_section
  ON public.dashboard_user_permissions (section_key);

COMMENT ON TABLE public.dashboard_users IS
  'Janus dashboard accounts. Cookie janus_session carries only { user_id, issuedAt }; permissions are always loaded from DB.';

COMMENT ON TABLE public.dashboard_user_permissions IS
  'Section grants for non-admin users. Admins bypass this table entirely (is_admin = true).';

-- Example collaborator (V1: no admin UI — SQL only):
--   1) node scripts/hash-dashboard-password.js 'TempPass!23456'
--   2) INSERT INTO public.dashboard_users (email, password_hash, is_admin, active)
--      VALUES ('colaborador@example.com', '<hash>', false, true)
--      RETURNING id;
--   3) INSERT INTO public.dashboard_user_permissions (user_id, section_key) VALUES
--      ('<id>', 'inbox'),
--      ('<id>', 'ga4');

COMMIT;
