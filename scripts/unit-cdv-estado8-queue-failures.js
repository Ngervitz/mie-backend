'use strict';

/**
 * CDV estado-8 queue: technical vs commercial terminal status + error text.
 * node scripts/unit-cdv-estado8-queue-failures.js
 */

const assert = require('assert');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
    sessionSecret: 'test-session',
    cronSecret: null,
  },
};

const {
  formatCdvEstado8QueueError,
  resolveCdvEstado8QueueTerminalStatus,
  isCdvEstado8RetryableFailure,
} = require('../src/lib/cdvEstado8ElmAutomation');
const { CODES } = require('../src/services/elm/constants');

assert.equal(
  formatCdvEstado8QueueError({
    code: 'exception',
    detail: 'elm_claim_process failed: elm_invalid_send_origin',
  }),
  'exception: elm_claim_process failed: elm_invalid_send_origin',
);

assert.equal(
  resolveCdvEstado8QueueTerminalStatus(
    { code: 'exception', detail: 'elm_invalid_send_origin' },
    8,
    8,
  ),
  'failed',
  'technical exhaustion stays failed, not skipped_ineligible',
);

assert.equal(
  resolveCdvEstado8QueueTerminalStatus({ code: CODES.CDV_GRANTED }, 8, 8),
  'skipped_ineligible',
);

assert.equal(resolveCdvEstado8QueueTerminalStatus({ code: CODES.PROCESS_EXISTS }, 1, 8), 'completed');

assert.equal(isCdvEstado8RetryableFailure('exception'), true);
assert.equal(isCdvEstado8RetryableFailure(CODES.CDV_GRANTED), false);

console.log('unit-cdv-estado8-queue-failures: OK');