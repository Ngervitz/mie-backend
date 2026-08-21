/**
 * Dashboard user + permission lookups (always from DB, never from cookie claims).
 */

const supabase = require('../clients/supabase');

/**
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const { data, error } = await supabase
    .from('dashboard_users')
    .select('id, email, password_hash, is_admin, active, created_at, updated_at')
    .eq('email', normalized)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function findUserById(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('dashboard_users')
    .select('id, email, password_hash, is_admin, active, created_at, updated_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
async function listPermissionSectionKeys(userId) {
  const { data, error } = await supabase
    .from('dashboard_user_permissions')
    .select('section_key')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return (data || [])
    .map((row) => row.section_key)
    .filter((k) => typeof k === 'string' && k);
}

/**
 * @param {string} userId
 * @param {string} sectionKey
 * @returns {Promise<boolean>}
 */
async function userHasSectionPermission(userId, sectionKey) {
  const { data, error } = await supabase
    .from('dashboard_user_permissions')
    .select('section_key')
    .eq('user_id', userId)
    .eq('section_key', sectionKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/**
 * @returns {Promise<number>}
 */
async function countUsers() {
  const { count, error } = await supabase
    .from('dashboard_users')
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return typeof count === 'number' ? count : 0;
}

/**
 * @param {{ email: string, passwordHash: string, isAdmin?: boolean }} input
 * @returns {Promise<object>}
 */
async function createUser(input) {
  const email = String(input.email || '').trim().toLowerCase();
  const row = {
    email,
    password_hash: input.passwordHash,
    is_admin: Boolean(input.isAdmin),
    active: true,
  };
  const { data, error } = await supabase
    .from('dashboard_users')
    .insert(row)
    .select('id, email, is_admin, active, created_at, updated_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * @returns {Promise<object[]>}
 */
async function listUsersWithPermissions() {
  const { data: users, error } = await supabase
    .from('dashboard_users')
    .select('id, email, is_admin, active, created_at, updated_at')
    .order('email', { ascending: true });
  if (error) throw new Error(error.message);

  const { data: perms, error: permErr } = await supabase
    .from('dashboard_user_permissions')
    .select('user_id, section_key');
  if (permErr) throw new Error(permErr.message);

  const byUser = new Map();
  for (const row of perms || []) {
    const list = byUser.get(row.user_id) || [];
    list.push(row.section_key);
    byUser.set(row.user_id, list);
  }

  return (users || []).map((u) => ({
    id: u.id,
    email: u.email,
    is_admin: u.is_admin === true,
    active: u.active === true,
    created_at: u.created_at,
    updated_at: u.updated_at,
    permissions: (byUser.get(u.id) || []).slice().sort(),
  }));
}

/**
 * Replace all section permissions for a user (delete + insert).
 * @param {string} userId
 * @param {string[]} sectionKeys
 */
async function replaceUserPermissions(userId, sectionKeys) {
  const { error: delErr } = await supabase
    .from('dashboard_user_permissions')
    .delete()
    .eq('user_id', userId);
  if (delErr) throw new Error(delErr.message);

  const unique = [
    ...new Set(
      (sectionKeys || []).filter((k) => typeof k === 'string' && k.trim()),
    ),
  ];
  if (!unique.length) return [];

  const rows = unique.map((section_key) => ({
    user_id: userId,
    section_key,
  }));
  const { error: insErr } = await supabase
    .from('dashboard_user_permissions')
    .insert(rows);
  if (insErr) throw new Error(insErr.message);
  return unique.slice().sort();
}

/**
 * @param {string} userId
 * @param {{ active?: boolean, is_admin?: boolean }} patch
 * @returns {Promise<object>}
 */
async function updateUser(userId, patch) {
  const row = { updated_at: new Date().toISOString() };
  if (typeof patch.active === 'boolean') row.active = patch.active;
  if (typeof patch.is_admin === 'boolean') row.is_admin = patch.is_admin;

  const { data, error } = await supabase
    .from('dashboard_users')
    .update(row)
    .eq('id', userId)
    .select('id, email, is_admin, active, created_at, updated_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * @param {string} userId
 * @param {string} passwordHash
 * @returns {Promise<object>}
 */
async function setUserPassword(userId, passwordHash) {
  const { data, error } = await supabase
    .from('dashboard_users')
    .update({
      password_hash: passwordHash,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .select('id, email, is_admin, active, updated_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = {
  findUserByEmail,
  findUserById,
  listPermissionSectionKeys,
  userHasSectionPermission,
  countUsers,
  createUser,
  listUsersWithPermissions,
  replaceUserPermissions,
  updateUser,
  setUserPassword,
};
