/**
 * Password hashing for dashboard_users.
 * No prior hash library in the repo — bcryptjs (pure JS) chosen for bcrypt compatibility
 * without native build deps on Railway/Windows.
 */

const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;

/**
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}

/**
 * @param {string} password
 * @param {string} passwordHash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, passwordHash) {
  if (!passwordHash || typeof passwordHash !== 'string') return false;
  return bcrypt.compare(String(password), passwordHash);
}

module.exports = {
  hashPassword,
  verifyPassword,
  BCRYPT_ROUNDS,
};
