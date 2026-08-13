/**
 * Manual smoke test for dashboard auth V1.
 *
 * Prerequisites:
 *   1. Apply migrations/20260813_dashboard_users_permissions.sql in Supabase
 *   2. Server running locally (npm run dev) with SESSION_SECRET + Supabase env
 *   3. Optional: DASHBOARD_LOGIN_PASSWORD for bootstrap if no users yet
 *
 * Usage:
 *   node scripts/test-dashboard-auth-v1.js
 *
 * Env overrides:
 *   TEST_BASE_URL (default http://127.0.0.1:PORT)
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD
 *   TEST_COLLAB_EMAIL / TEST_COLLAB_PASSWORD
 *   TEST_BOOTSTRAP_PASSWORD (= DASHBOARD_LOGIN_PASSWORD when bootstrapping)
 */

require('dotenv').config();

const { hashPassword } = require('../src/lib/passwordHash');
const supabase = require('../src/clients/supabase');

const PORT = process.env.PORT || '3000';
const BASE = (process.env.TEST_BASE_URL || `http://127.0.0.1:${PORT}`).replace(
  /\/+$/,
  '',
);
const ADMIN_EMAIL = (
  process.env.TEST_ADMIN_EMAIL || 'admin-test@janus.local'
).toLowerCase();
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'TestAdmin!23456';
const COLLAB_EMAIL = (
  process.env.TEST_COLLAB_EMAIL || 'collab-inbox-none@janus.local'
).toLowerCase();
const COLLAB_PASSWORD = process.env.TEST_COLLAB_PASSWORD || 'TestCollab!23456';
const BOOTSTRAP_PASSWORD =
  process.env.TEST_BOOTSTRAP_PASSWORD ||
  process.env.DASHBOARD_LOGIN_PASSWORD ||
  '';

function parseSetCookie(res) {
  const raw = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie');
  if (!raw) return null;
  const first = Array.isArray(raw) ? raw[0] : String(raw).split(',')[0];
  const m = /janus_session=([^;]+)/.exec(first);
  return m ? decodeURIComponent(m[1]) : null;
}

async function ensureUsers() {
  const { count, error } = await supabase
    .from('dashboard_users')
    .select('id', { count: 'exact', head: true });
  if (error) {
    throw new Error(
      `dashboard_users not readable (apply migration?): ${error.message}`,
    );
  }

  if ((count || 0) === 0) {
    if (!BOOTSTRAP_PASSWORD) {
      throw new Error(
        'No users and no DASHBOARD_LOGIN_PASSWORD / TEST_BOOTSTRAP_PASSWORD for bootstrap',
      );
    }
    const boot = await fetch(`${BASE}/admin/bootstrap-first-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        bootstrapPassword: BOOTSTRAP_PASSWORD,
      }),
    });
    const bootBody = await boot.json().catch(() => ({}));
    if (!boot.ok) {
      throw new Error(`bootstrap failed ${boot.status}: ${JSON.stringify(bootBody)}`);
    }
    console.log('bootstrap ok', bootBody.user);
  }

  // Ensure admin email exists (may already be another admin).
  let { data: admin } = await supabase
    .from('dashboard_users')
    .select('id, email, is_admin, active')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle();

  if (!admin) {
    const password_hash = await hashPassword(ADMIN_PASSWORD);
    const { data, error: insErr } = await supabase
      .from('dashboard_users')
      .insert({
        email: ADMIN_EMAIL,
        password_hash,
        is_admin: true,
        active: true,
      })
      .select('id, email, is_admin, active')
      .single();
    if (insErr) throw new Error(insErr.message);
    admin = data;
  }

  let { data: collab } = await supabase
    .from('dashboard_users')
    .select('id, email, is_admin, active')
    .eq('email', COLLAB_EMAIL)
    .maybeSingle();

  if (!collab) {
    const password_hash = await hashPassword(COLLAB_PASSWORD);
    const { data, error: insErr } = await supabase
      .from('dashboard_users')
      .insert({
        email: COLLAB_EMAIL,
        password_hash,
        is_admin: false,
        active: true,
      })
      .select('id, email, is_admin, active')
      .single();
    if (insErr) throw new Error(insErr.message);
    collab = data;
  } else if (collab.is_admin) {
    await supabase
      .from('dashboard_users')
      .update({ is_admin: false, updated_at: new Date().toISOString() })
      .eq('id', collab.id);
    collab.is_admin = false;
  }

  // Collab: only ga4 (+ maybe meta) — explicitly NO inbox
  await supabase
    .from('dashboard_user_permissions')
    .delete()
    .eq('user_id', collab.id);
  const { error: permErr } = await supabase
    .from('dashboard_user_permissions')
    .insert([
      { user_id: collab.id, section_key: 'ga4' },
      { user_id: collab.id, section_key: 'meta' },
    ]);
  if (permErr) throw new Error(permErr.message);

  return { admin, collab };
}

async function login(email, password) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  const cookie = parseSetCookie(res);
  return { status: res.status, body, cookie };
}

async function authed(path, cookie, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
      Cookie: `janus_session=${encodeURIComponent(cookie)}`,
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  console.log('BASE', BASE);
  const users = await ensureUsers();
  console.log('users ready', {
    admin: users.admin.email,
    collab: users.collab.email,
  });

  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log('admin login', adminLogin.status, adminLogin.body);
  if (adminLogin.status !== 200 || !adminLogin.cookie) {
    throw new Error('admin login failed');
  }

  const adminMe = await authed('/api/auth/me', adminLogin.cookie);
  console.log('admin /me', adminMe.status, JSON.stringify(adminMe.body));

  const collabLogin = await login(COLLAB_EMAIL, COLLAB_PASSWORD);
  console.log('collab login', collabLogin.status, collabLogin.body);
  if (collabLogin.status !== 200 || !collabLogin.cookie) {
    throw new Error('collab login failed');
  }

  const collabMe = await authed('/api/auth/me', collabLogin.cookie);
  console.log('collab /me', collabMe.status, JSON.stringify(collabMe.body));

  const inboxGet = await authed('/api/social-comments?status=pending&limit=1', collabLogin.cookie);
  console.log('collab inbox GET', inboxGet.status, JSON.stringify(inboxGet.body));

  const inboxPost = await authed('/api/social-comments/1/reply', collabLogin.cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyText: 'x', repliedBy: 'user:test' }),
  });
  console.log('collab inbox POST reply', inboxPost.status, JSON.stringify(inboxPost.body));

  const ga4 = await authed('/reports/ga4-metrics?from=2026-01-01&to=2026-01-02', collabLogin.cookie);
  console.log('collab ga4 (allowed)', ga4.status);

  if (collabMe.status !== 200) throw new Error('/me failed for collab');
  if (!Array.isArray(collabMe.body.permissions)) throw new Error('permissions missing');
  if (collabMe.body.permissions.includes('inbox')) {
    throw new Error('collab should not have inbox permission');
  }
  if (inboxGet.status !== 403) {
    throw new Error(`expected inbox GET 403, got ${inboxGet.status}`);
  }
  if (inboxPost.status !== 403) {
    throw new Error(`expected inbox POST 403, got ${inboxPost.status}`);
  }

  console.log('\nOK — login, /me, and inbox 403 checks passed');
}

main().catch((err) => {
  console.error('FAIL', err && err.message ? err.message : err);
  process.exit(1);
});
