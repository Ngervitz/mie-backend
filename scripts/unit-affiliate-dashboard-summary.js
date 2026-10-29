'use strict';

/**
 * node scripts/unit-affiliate-dashboard-summary.js
 */

const assert = require('assert');
const {
  AFFILIATE_EMAIL_INVITE_CLICKS,
  aggregateAffiliateInviteOutreach,
} = require('../src/lib/affiliateInviteOutreachMetrics');

assert.strictEqual(AFFILIATE_EMAIL_INVITE_CLICKS.measured, false);
assert.strictEqual(AFFILIATE_EMAIL_INVITE_CLICKS.label, 'No medidos');

function chainResult(data) {
  const result = Promise.resolve({ data: data, error: null, count: 0 });
  const chain = {
    select: function () {
      return chain;
    },
    eq: function () {
      return chain;
    },
    in: function () {
      return chain;
    },
    not: function () {
      return chain;
    },
    then: function (onFulfilled, onRejected) {
      return result.then(onFulfilled, onRejected);
    },
  };
  return chain;
}

async function run() {
  const fakeSupabase = {
    from: function (table) {
      if (table === 'sms_campaigns') {
        return chainResult([]);
      }
      if (table === 'sms_messages') {
        return chainResult([]);
      }
      throw new Error('unexpected table ' + table);
    },
  };

  const outreach = await aggregateAffiliateInviteOutreach(
    fakeSupabase,
    async function () {
      return 7;
    },
  );

  assert.strictEqual(outreach.email.invitations_sent, 7);
  assert.strictEqual(outreach.email.invite_clicks.label, 'No medidos');
  assert.strictEqual(outreach.sms.invitations_sent, 0);
  assert.ok(outreach.referral_link_clicks_note.indexOf('affiliate_clicks') >= 0);

  console.log('OK unit-affiliate-dashboard-summary');
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
