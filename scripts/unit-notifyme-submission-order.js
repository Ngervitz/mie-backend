'use strict';

/**
 * node scripts/unit-notifyme-submission-order.js
 */

const assert = require('assert');
const {
  isSubmissionOrderDuplicateError,
} = require('../src/services/notifyme-client');

assert.strictEqual(
  isSubmissionOrderDuplicateError({
    code: '23505',
    message: 'duplicate key value violates unique constraint "sms_messages_campaign_submission_order_unique"',
  }),
  true,
);
assert.strictEqual(
  isSubmissionOrderDuplicateError({ code: '23505', message: 'other unique' }),
  false,
);
assert.strictEqual(isSubmissionOrderDuplicateError(null), false);

console.log('unit-notifyme-submission-order: ok');
