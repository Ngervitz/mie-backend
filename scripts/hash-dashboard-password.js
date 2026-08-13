/**
 * Hash a password for manual SQL inserts into dashboard_users.
 * Usage: node scripts/hash-dashboard-password.js 'tu-password'
 */

const { hashPassword } = require('../src/lib/passwordHash');

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error("Usage: node scripts/hash-dashboard-password.js 'password'");
    process.exit(1);
  }
  const hash = await hashPassword(password);
  console.log(hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
