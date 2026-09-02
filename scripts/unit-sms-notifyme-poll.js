'use strict';

/**
 * node scripts/unit-sms-notifyme-poll.js
 *
 * Unit tests for NotifyMe auto-poll selection + shared helper + job lock.
 * No real NotifyMe / SOAP calls.
 */

const assert = require('assert');
const {
  CANDIDATE_CAMPAIGN_STATUSES,
  AUTO_POLL_CUTOFF_HOURS,
  selectStatusPollUniqueIds,
  selectResponsePollUniqueIds,
  isCampaignEligibleForAutoPoll,
  autoPollCutoffIso,
  pollCampaignNotifyme,
} = require('../src/lib/smsNotifymePoll');
const {
  runSmsNotifymePoll,
  JOB_NAME,
} = require('../src/jobs/smsNotifymePoll');

assert.deepStrictEqual(CANDIDATE_CAMPAIGN_STATUSES, [
  'sending',
  'sent',
  'partial_error',
]);
assert.strictEqual(AUTO_POLL_CUTOFF_HOURS, 72);

const NOW = new Date('2026-09-02T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function hoursAgo(h) {
  return new Date(NOW.getTime() - h * HOUR).toISOString();
}

// --- selection: status poll skips DELIVERED when requested ---
{
  const messages = [
    { unique_id: '1001', status: 'pending' },
    { unique_id: '1002', status: 'DELIVERED' },
    { unique_id: '1003', status: 'PENDING' },
  ];
  assert.deepStrictEqual(selectStatusPollUniqueIds(messages, true), [
    '1001',
    '1003',
  ]);
  assert.deepStrictEqual(selectStatusPollUniqueIds(messages, false), [
    '1001',
    '1002',
    '1003',
  ]);
}

// --- responses always include DELIVERED ---
{
  const messages = [
    { unique_id: '1001', status: 'pending' },
    { unique_id: '1002', status: 'DELIVERED' },
  ];
  assert.deepStrictEqual(selectResponsePollUniqueIds(messages), [
    '1001',
    '1002',
  ]);
}

// --- campaign eligibility ---
{
  assert.strictEqual(
    isCampaignEligibleForAutoPoll(
      { id: 'a', status: 'sent', created_at: hoursAgo(1) },
      NOW,
    ),
    true,
    '1: sent + pending window → candidate',
  );
  assert.strictEqual(
    isCampaignEligibleForAutoPoll(
      { id: 'b', status: 'sending', created_at: hoursAgo(1) },
      NOW,
    ),
    true,
    '5: sending → candidate',
  );
  assert.strictEqual(
    isCampaignEligibleForAutoPoll(
      { id: 'c', status: 'partial_error', created_at: hoursAgo(2) },
      NOW,
    ),
    true,
    '4: partial_error → candidate',
  );
  assert.strictEqual(
    isCampaignEligibleForAutoPoll(
      { id: 'd', status: 'error', created_at: hoursAgo(1) },
      NOW,
    ),
    false,
    '3: error + pending must NOT poll',
  );
  assert.strictEqual(
    isCampaignEligibleForAutoPoll(
      { id: 'e', status: 'sent', created_at: hoursAgo(80) },
      NOW,
    ),
    false,
    '6: outside 72h cutoff → not candidate',
  );
  assert.strictEqual(
    isCampaignEligibleForAutoPoll(
      { id: 'f', status: 'sent', created_at: hoursAgo(71) },
      NOW,
    ),
    true,
    'inside 72h → candidate',
  );
}

{
  const cutoff = autoPollCutoffIso(NOW, 72);
  assert.strictEqual(cutoff, new Date(NOW.getTime() - 72 * HOUR).toISOString());
}

(async function run() {
  // --- pollCampaignNotifyme: skip delivered for status, always responses ---
  {
    const campaign = {
      id: 'camp-sent',
      status: 'sent',
      created_at: hoursAgo(1),
      name: 't',
      total_messages: 2,
    };
    const messages = [
      { unique_id: '2001', campaign_id: 'camp-sent', status: 'pending', submission_order: 0 },
      { unique_id: '2002', campaign_id: 'camp-sent', status: 'DELIVERED', submission_order: 1 },
    ];
    let statusCalls = [];
    let responseCalls = [];
    let loadCount = 0;

    const fakeSb = {
      from: function (table) {
        return {
          select: function () {
            return {
              eq: function (_col, id) {
                return {
                  limit: async function () {
                    assert.strictEqual(table, 'sms_campaigns');
                    assert.strictEqual(id, 'camp-sent');
                    return { data: [campaign], error: null };
                  },
                  order: async function () {
                    loadCount += 1;
                    assert.strictEqual(table, 'sms_messages');
                    return { data: messages, error: null };
                  },
                };
              },
            };
          },
        };
      },
    };

    const result = await pollCampaignNotifyme('camp-sent', {
      skipDeliveredForStatus: true,
      supabase: fakeSb,
      pollStatusFn: async function (ids) {
        statusCalls.push(ids.slice());
        return { requested: ids.length, returned: ids.length, updated: 1 };
      },
      pollResponsesFn: async function (ids) {
        responseCalls.push(ids.slice());
        return { requested: ids.length, returned: 0, updated: 0 };
      },
    });

    assert.deepStrictEqual(statusCalls[0], ['2001'], '2: DELIVERED not status-polled');
    assert.deepStrictEqual(responseCalls[0], ['2001', '2002'], '10: responses include all');
    assert.strictEqual(result.status_poll.requested, 1);
    assert.strictEqual(result.response_poll.requested, 2);
    assert.ok(loadCount >= 2);
  }

  // --- manual-style: does not skip DELIVERED for status ---
  {
    const campaign = {
      id: 'camp-manual',
      status: 'sent',
      created_at: hoursAgo(1),
      name: 'm',
      total_messages: 2,
    };
    const messages = [
      { unique_id: '3001', campaign_id: 'camp-manual', status: 'pending', submission_order: 0 },
      { unique_id: '3002', campaign_id: 'camp-manual', status: 'DELIVERED', submission_order: 1 },
    ];
    let statusCalls = [];
    const fakeSb = {
      from: function (table) {
        return {
          select: function () {
            return {
              eq: function () {
                return {
                  limit: async function () {
                    return { data: [campaign], error: null };
                  },
                  order: async function () {
                    return { data: messages, error: null };
                  },
                };
              },
            };
          },
        };
      },
    };
    await pollCampaignNotifyme('camp-manual', {
      skipDeliveredForStatus: false,
      supabase: fakeSb,
      pollStatusFn: async function (ids) {
        statusCalls.push(ids.slice());
        return { requested: ids.length, returned: ids.length, updated: 0 };
      },
      pollResponsesFn: async function (ids) {
        return { requested: ids.length, returned: 0, updated: 0 };
      },
    });
    assert.deepStrictEqual(
      statusCalls[0],
      ['3001', '3002'],
      '9: manual helper polls all for status',
    );
  }

  // --- job: lock acquired → runs candidates ---
  {
    const polled = [];
    const result = await runSmsNotifymePoll({
      acquireLockFn: async function () {
        return true;
      },
      releaseLockFn: async function () {
        return true;
      },
      listCampaignsFn: async function () {
        return [
          { id: 'ok-1', status: 'sent', created_at: hoursAgo(1) },
          { id: 'ok-2', status: 'partial_error', created_at: hoursAgo(2) },
        ];
      },
      pollCampaignFn: async function (id) {
        polled.push(id);
        return {
          status_poll: { requested: 3, returned: 3, updated: 2 },
          response_poll: { requested: 5, returned: 0, updated: 0 },
        };
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.jobName, JOB_NAME);
    assert.strictEqual(result.campaignsConsidered, 2);
    assert.strictEqual(result.campaignsPolled, 2);
    assert.deepStrictEqual(polled, ['ok-1', 'ok-2']);
    assert.strictEqual(result.statusRequested, 6);
    assert.strictEqual(result.responseRequested, 10);
  }

  // --- job: lock not acquired → skipped ---
  {
    let listed = false;
    const result = await runSmsNotifymePoll({
      acquireLockFn: async function () {
        return false;
      },
      releaseLockFn: async function () {
        throw new Error('should not release');
      },
      listCampaignsFn: async function () {
        listed = true;
        return [];
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'lock_not_acquired');
    assert.strictEqual(listed, false, '8: must not list when lock missing');
  }

  // --- error campaign never appears in list filter (pure eligibility) ---
  {
    const errorCamp = {
      id: '411cc02d-407b-4bba-89c8-11656fe65414',
      status: 'error',
      created_at: hoursAgo(1),
      total_messages: 500,
    };
    assert.strictEqual(
      isCampaignEligibleForAutoPoll(errorCamp, NOW),
      false,
      'failed 500 campaign stays out of auto poll',
    );
  }

  // --- all DELIVERED: status poll skipped, responses still run ---
  {
    const campaign = {
      id: 'camp-all-del',
      status: 'sent',
      created_at: hoursAgo(1),
      name: 'd',
      total_messages: 2,
    };
    const messages = [
      { unique_id: '4001', status: 'DELIVERED', submission_order: 0 },
      { unique_id: '4002', status: 'DELIVERED', submission_order: 1 },
    ];
    let statusCalled = false;
    let responseIds = null;
    const fakeSb = {
      from: function () {
        return {
          select: function () {
            return {
              eq: function () {
                return {
                  limit: async function () {
                    return { data: [campaign], error: null };
                  },
                  order: async function () {
                    return { data: messages, error: null };
                  },
                };
              },
            };
          },
        };
      },
    };
    const result = await pollCampaignNotifyme('camp-all-del', {
      skipDeliveredForStatus: true,
      supabase: fakeSb,
      pollStatusFn: async function () {
        statusCalled = true;
        return { requested: 1, returned: 1, updated: 0 };
      },
      pollResponsesFn: async function (ids) {
        responseIds = ids.slice();
        return { requested: ids.length, returned: 0, updated: 0 };
      },
    });
    assert.strictEqual(statusCalled, false, 'all DELIVERED → no status SOAP');
    assert.deepStrictEqual(responseIds, ['4001', '4002']);
    assert.strictEqual(result.status_poll.requested, 0);
  }

  console.log('OK unit-sms-notifyme-poll');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
