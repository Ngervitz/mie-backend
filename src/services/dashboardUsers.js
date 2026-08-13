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

module.exports = {
  findUserByEmail,
  findUserById,
  listPermissionSectionKeys,
  userHasSectionPermission,
  countUsers,
  createUser,
};
