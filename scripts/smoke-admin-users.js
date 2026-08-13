/**
 * Smoke: admin users API + non-admin 403 + new user login scope.
 * Requires local server + migration.
 *
 *   PORT=3010 node scripts/smoke-admin-users.js
 */

require('dotenv').config();

const { hashPassword } = require('../src/lib/passwordHash');
const supabase = require('../src/clients/supabase');

const PORT = process.env.PORT || '3010';
const BASE = (process.env.TEST_BASE_URL || `http://127.0.0.1:${PORT}`).replace(
  /\/+$/,
  '',
);

const ADMIN_EMAIL = 'smoke-admin@janus.local';
const ADMIN_PASSWORD = 'SmokeAdmin!23456';
const COLLAB_EMAIL = 'smoke-collab-inbox@janus.local';
const COLLAB_PASSWORD = 'SmokeCollab!23456';
const NEW_EMAIL = `smoke-created-${Date.now()}@janus.local`;
const NEW_PASSWORD = 'SmokeCreated!23456';

function parseSetCookie(res) {
  const raw = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie');
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(/,(?=\s*[^;]+=)/);
  for (const line of list) {
    const m = /janus_session=([^;]+)/.exec(line);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function ensureUser(email, password, isAdmin) {
  const password_hash = await hashPassword(password);
  const { data: existing } = await supabase
    .from('dashboard_users')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (existing) {
    await supabase
      .from('dashboard_users')
      .update({
        password_hash,
        is_admin: isAdmin,
        active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return existing.id;
  }
  const { data, error } = await supabase
    .from('dashboard_users')
    .insert({
      email,
      password_hash,
      is_admin: isAdmin,
      active: true,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function login(email, password) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, cookie: parseSetCookie(res) };
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
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

function assert(cond, msg, detail) {
  if (!cond) {
    console.error('FAIL', msg, detail || '');
    process.exit(1);
  }
  console.log('PASS', msg);
}

async function main() {
  console.log('BASE', BASE);
  const adminId = await ensureUser(ADMIN_EMAIL, ADMIN_PASSWORD, true);
  const collabId = await ensureUser(COLLAB_EMAIL, COLLAB_PASSWORD, false);
  await supabase.from('dashboard_user_permissions').delete().eq('user_id', collabId);
  await supabase
    .from('dashboard_user_permissions')
    .insert({ user_id: collabId, section_key: 'inbox' });
  console.log('seeded', { adminId, collabId });

  const collabLogin = await login(COLLAB_EMAIL, COLLAB_PASSWORD);
  assert(collabLogin.status === 200 && collabLogin.cookie, 'collab login');
  const forbidden = await authed('/api/admin/users', collabLogin.cookie);
  assert(
    forbidden.status === 403,
    'non-admin GET /api/admin/users → 403',
    forbidden,
  );

  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert(adminLogin.status === 200 && adminLogin.cookie, 'admin login');
  const list = await authed('/api/admin/users', adminLogin.cookie);
  assert(list.status === 200 && Array.isArray(list.body.users), 'admin list users', list);

  const created = await authed('/api/admin/users', adminLogin.cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: NEW_EMAIL,
      password: NEW_PASSWORD,
      is_admin: false,
      permissions: ['ga4'],
    }),
  });
  assert(created.status === 201 && created.body.user, 'admin create user', created);
  assert(
    Array.isArray(created.body.user.permissions) &&
      created.body.user.permissions.includes('ga4'),
    'created user has ga4',
    created.body.user,
  );

  const newLogin = await login(NEW_EMAIL, NEW_PASSWORD);
  assert(newLogin.status === 200 && newLogin.cookie, 'new user login');
  const me = await authed('/api/auth/me', newLogin.cookie);
  assert(
    me.status === 200 &&
      me.body.user.is_admin === false &&
      Array.isArray(me.body.permissions) &&
      me.body.permissions.length === 1 &&
      me.body.permissions[0] === 'ga4',
    'new user /me permissions = [ga4]',
    me.body,
  );

  const inbox403 = await authed(
    '/api/social-comments?status=pending&limit=1',
    newLogin.cookie,
  );
  assert(inbox403.status === 403, 'new user inbox → 403', inbox403);

  const ga4Ok = await authed(
    '/reports/ga4-metrics?from=2026-01-01&to=2026-01-02',
    newLogin.cookie,
  );
  assert(ga4Ok.status !== 403 && ga4Ok.status !== 401, 'new user ga4 not forbidden', {
    status: ga4Ok.status,
  });

  const patchPerm = await authed(
    `/api/admin/users/${created.body.user.id}/permissions`,
    adminLogin.cookie,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: ['ga4', 'meta'] }),
    },
  );
  assert(
    patchPerm.status === 200 &&
      patchPerm.body.user.permissions.includes('meta'),
    'admin patch permissions',
    patchPerm.body,
  );

  console.log('\nALL ADMIN SMOKE PASSED');
  console.log('created user', NEW_EMAIL);
}

main().catch((err) => {
  console.error('SMOKE FAILED', err && err.message ? err.message : err);
  process.exit(1);
});
