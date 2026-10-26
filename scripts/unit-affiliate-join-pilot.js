'use strict';

/**
 * node scripts/unit-affiliate-join-pilot.js
 */

const assert = require('assert');
const {
  readAffiliateJoinPilotCi,
  isCiAllowedForAffiliateJoin,
} = require('../src/lib/affiliateJoinPilot');
const {
  parseArgvCi,
  assertValidPhone,
  buildJoinUrl,
  validateCiForPilotInvite,
} = require('./issue-affiliate-pilot-invite');
const {
  startLocalAffiliateJoinServer,
} = require('./affiliate-join-local-server');

const PILOT_CI = 42424242;
const OTHER_CI = 51515151;

async function post(base, path, body, headers) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_e) {
    json = null;
  }
  return { status: res.status, body: json };
}

function mockStoreForPilot() {
  const { createAffiliateJoinStore } = require('./affiliate-join-local-store');
  const store = createAffiliateJoinStore();
  store.addSolicitud({ ci: PILOT_CI, celular: '099111222' });
  store.addSolicitud({ ci: OTHER_CI, celular: '099333444' });
  return store;
}

async function main() {
  delete process.env.AFFILIATE_JOIN_PILOT_CI;
  assert.strictEqual(readAffiliateJoinPilotCi(), null);
  assert.strictEqual(isCiAllowedForAffiliateJoin(PILOT_CI), true);

  process.env.AFFILIATE_JOIN_PILOT_CI = String(PILOT_CI);
  assert.strictEqual(readAffiliateJoinPilotCi(), PILOT_CI);
  assert.strictEqual(isCiAllowedForAffiliateJoin(PILOT_CI), true);
  assert.strictEqual(isCiAllowedForAffiliateJoin(OTHER_CI), false);
  delete process.env.AFFILIATE_JOIN_PILOT_CI;

  assert.strictEqual(parseArgvCi(['node', 'script', '12345678']), 12345678);
  assert.throws(function () {
    parseArgvCi(['node', 'script']);
  });
  assert.throws(function () {
    assertValidPhone('123');
  });
  assert.ok(buildJoinUrl('abc').indexOf('join?t=abc') !== -1);

  const storeValidate = mockStoreForPilot();
  await validateCiForPilotInvite(storeValidate, PILOT_CI);
  let threwAffiliate = false;
  storeValidate.tables.affiliates.push({
    id: '00000000-0000-4000-8000-000000000001',
    code: 'ABCD12',
    status: 'active',
    is_test: false,
    ci: PILOT_CI,
  });
  try {
    await validateCiForPilotInvite(storeValidate, PILOT_CI);
  } catch (e) {
    threwAffiliate = e.message.indexOf('ya es afiliada') !== -1;
  }
  assert.ok(threwAffiliate);

  process.env.AFFILIATE_JOIN_ENABLED = 'true';
  process.env.AFFILIATE_JOIN_PILOT_CI = String(PILOT_CI);

  const store = mockStoreForPilot();
  const h = await startLocalAffiliateJoinServer({ joinEnabled: true, store: store });
  const base = h.base;
  const pilotInvite = store.addInvite({ ci: PILOT_CI });
  const otherInvite = store.addInvite({ ci: OTHER_CI });

  const allowed = await post(base, '/invite/validate', { t: pilotInvite.raw });
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(allowed.body.ok, true);

  const blocked = await post(base, '/invite/validate', { t: otherInvite.raw });
  assert.strictEqual(blocked.status, 403);
  assert.deepStrictEqual(blocked.body, { ok: false });

  await h.close();
  delete process.env.AFFILIATE_JOIN_PILOT_CI;
  delete process.env.AFFILIATE_JOIN_ENABLED;

  console.log('unit-affiliate-join-pilot: ok');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
