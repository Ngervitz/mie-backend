/**
 * Full smoke for dashboard auth V1 — matches the 7-step checklist.
 * Requires migration applied + local server (or TEST_BASE_URL).
 *
 *   node scripts/smoke-dashboard-auth-checklist.js
 */

require('dotenv').config();

const { hashPassword } = require('../src/lib/passwordHash');
const supabase = require('../src/clients/supabase');

const PORT = process.env.PORT || '3000';
const BASE = (process.env.TEST_BASE_URL || `http://127.0.0.1:${PORT}`).replace(
  /\/+$/,
  '',
);

const COLLAB_EMAIL = 'smoke-collab-inbox@janus.local';
const COLLAB_PASSWORD = 'SmokeCollab!23456';
const ADMIN_EMAIL = 'smoke-admin@janus.local';
const ADMIN_PASSWORD = 'SmokeAdmin!23456';

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

function decodeCookiePayload(token) {
  const payload = token.split('.')[0];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function upsertUser({ email, password, isAdmin }) {
  const password_hash = await hashPassword(password);
  const { data: existing } = await supabase
    .from('dashboard_users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from('dashboard_users')
      .update({
        password_hash,
        is_admin: isAdmin,
        active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select('id, email, is_admin, active')
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  const { data, error } = await supabase
    .from('dashboard_users')
    .insert({
      email,
      password_hash,
      is_admin: isAdmin,
      active: true,
    })
    .select('id, email, is_admin, active')
    .single();
  if (error) throw new Error(error.message);
  return data;
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
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
}

function step(n, title, ok, detail) {
  console.log(`\n=== STEP ${n}: ${title} ===`);
  console.log(ok ? 'PASS' : 'FAIL');
  console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  if (!ok) throw new Error(`Step ${n} failed`);
}

async function main() {
  console.log('BASE', BASE);

  // Step 1–2: collab with only inbox
  const collab = await upsertUser({
    email: COLLAB_EMAIL,
    password: COLLAB_PASSWORD,
    isAdmin: false,
  });
  await supabase
    .from('dashboard_user_permissions')
    .delete()
    .eq('user_id', collab.id);
  const { error: permErr } = await supabase
    .from('dashboard_user_permissions')
    .insert({ user_id: collab.id, section_key: 'inbox' });
  if (permErr) throw new Error(permErr.message);

  step(1, 'Crear usuario de prueba is_admin=false', true, {
    id: collab.id,
    email: collab.email,
    is_admin: collab.is_admin,
  });
  step(2, "Asignar permiso solo 'inbox'", true, {
    user_id: collab.id,
    section_key: 'inbox',
  });

  // Step 3: login + cookie shape
  const collabLogin = await login(COLLAB_EMAIL, COLLAB_PASSWORD);
  if (collabLogin.status !== 200 || !collabLogin.cookie) {
    step(3, 'Login collab + cookie', false, collabLogin);
  }
  const cookiePayload = decodeCookiePayload(collabLogin.cookie);
  const cookieKeys = Object.keys(cookiePayload).sort();
  const cookieOk =
    cookieKeys.length === 2 &&
    cookieKeys[0] === 'issuedAt' &&
    cookieKeys[1] === 'user_id' &&
    cookiePayload.user_id === collab.id &&
    typeof cookiePayload.issuedAt === 'number';
  step(3, 'Login + cookie { user_id, issuedAt } only', cookieOk, {
    loginStatus: collabLogin.status,
    cookiePayload,
  });

  // Step 4: /api/auth/me
  const me = await authed('/api/auth/me', collabLogin.cookie);
  const meOk =
    me.status === 200 &&
    me.body &&
    me.body.user &&
    me.body.user.is_admin === false &&
    Array.isArray(me.body.permissions) &&
    me.body.permissions.length === 1 &&
    me.body.permissions[0] === 'inbox';
  step(4, 'GET /api/auth/me', meOk, me);

  // Step 5: meta without permission → 403
  const metaDenied = await authed('/api/liquidity-cycle/history', collabLogin.cookie);
  step(
    5,
    "Endpoint 'meta' sin permiso → 403",
    metaDenied.status === 403,
    metaDenied,
  );

  // Step 6: inbox allowed → 200
  const inboxOkRes = await authed(
    '/api/social-comments?status=pending&limit=1',
    collabLogin.cookie,
  );
  step(
    6,
    "Endpoint 'inbox' con permiso → 200",
    inboxOkRes.status === 200,
    {
      status: inboxOkRes.status,
      hasComments: Array.isArray(inboxOkRes.body && inboxOkRes.body.comments),
      total: inboxOkRes.body && inboxOkRes.body.total,
    },
  );

  // Step 7: admin, no permission rows, access everything
  const admin = await upsertUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    isAdmin: true,
  });
  await supabase
    .from('dashboard_user_permissions')
    .delete()
    .eq('user_id', admin.id);

  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (adminLogin.status !== 200 || !adminLogin.cookie) {
    step(7, 'Admin login', false, adminLogin);
  }
  const adminMe = await authed('/api/auth/me', adminLogin.cookie);
  const adminInbox = await authed(
    '/api/social-comments?status=pending&limit=1',
    adminLogin.cookie,
  );
  const adminMeta = await authed('/api/liquidity-cycle/history', adminLogin.cookie);
  const adminGa4 = await authed(
    '/reports/ga4-metrics?from=2026-01-01&to=2026-01-02',
    adminLogin.cookie,
  );

  const adminOk =
    adminMe.status === 200 &&
    adminMe.body &&
    adminMe.body.user &&
    adminMe.body.user.is_admin === true &&
    Array.isArray(adminMe.body.permissions) &&
    adminMe.body.permissions.length === 0 &&
    adminMe.body.access === 'admin_full' &&
    adminInbox.status === 200 &&
    adminMeta.status === 200 &&
    // ga4 may 200 with data or 400/500 if GA4 misconfigured — must NOT be 403
    adminGa4.status !== 403 &&
    adminGa4.status !== 401;

  step(7, 'Admin is_admin=true acceso total sin filas de permisos', adminOk, {
    admin: { id: admin.id, email: admin.email },
    me: adminMe,
    inboxStatus: adminInbox.status,
    metaStatus: adminMeta.status,
    ga4Status: adminGa4.status,
  });

  console.log('\nALL STEPS PASSED');
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
