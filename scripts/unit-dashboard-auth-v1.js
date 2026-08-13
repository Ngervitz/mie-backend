/**
 * Offline unit checks for dashboard auth V1 (no HTTP server / no DB).
 * Run: node scripts/unit-dashboard-auth-v1.js
 */

require('dotenv').config();
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'unit-test-session-secret-not-for-prod';
}
if (!process.env.APIFY_TOKEN) process.env.APIFY_TOKEN = 'unit-test';
if (!process.env.APIFY_ACTOR_ID) process.env.APIFY_ACTOR_ID = 'unit-test';

const assert = require('assert');
const {
  createSessionToken,
  verifySessionToken,
  authConfigured,
} = require('../src/middleware/auth');
const {
  resolveSectionForPath,
  SECTION_KEYS,
} = require('../src/middleware/dashboardSections');
const { hashPassword, verifyPassword } = require('../src/lib/passwordHash');

async function main() {
  assert.strictEqual(authConfigured(), true);

  const userId = '11111111-1111-1111-1111-111111111111';
  const token = createSessionToken(userId);
  const parsed = verifySessionToken(token);
  assert.ok(parsed);
  assert.strictEqual(parsed.userId, userId);
  assert.ok(typeof parsed.issuedAt === 'number');

  // Cookie must NOT encode permissions / is_admin
  const payload = JSON.parse(
    Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
  );
  assert.deepStrictEqual(Object.keys(payload).sort(), ['issuedAt', 'user_id']);

  assert.strictEqual(resolveSectionForPath('/api/social-comments'), 'inbox');
  assert.strictEqual(
    resolveSectionForPath('/api/social-comments/9/reply'),
    'inbox',
  );
  assert.strictEqual(
    resolveSectionForPath('/api/social-conversations/3/send'),
    'inbox',
  );
  assert.strictEqual(resolveSectionForPath('/reports/ga4-metrics'), 'ga4');
  assert.strictEqual(resolveSectionForPath('/sms/campaigns'), 'sms');
  assert.strictEqual(resolveSectionForPath('/email/campaigns'), 'email');
  assert.strictEqual(
    resolveSectionForPath('/ai-visibility/prompts'),
    'ai-visibility',
  );
  assert.strictEqual(SECTION_KEYS.length, 9);

  const hash = await hashPassword('UnitTest!password1');
  assert.ok(await verifyPassword('UnitTest!password1', hash));
  assert.ok(!(await verifyPassword('wrong', hash)));

  console.log('OK unit-dashboard-auth-v1');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
