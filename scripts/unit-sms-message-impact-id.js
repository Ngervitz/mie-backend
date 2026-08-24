'use strict';

/**
 * node scripts/unit-sms-message-impact-id.js
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
  },
};
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {},
};

const {
  validateMessagesInput,
  buildDataSmsPayload,
  NotifymeError,
} = require('../src/services/notifyme-client');

const impactId = '11111111-1111-4111-8111-111111111111';
const normalized = validateMessagesInput([
  {
    phone: '099111111',
    text: 'hola https://example.com/s/AbC234',
    marketing_impact_id: impactId,
    contact_id: '22222222-2222-4222-8222-222222222222',
  },
  {
    phone: '099222222',
    text: 'hola',
  },
]);

assert.strictEqual(normalized[0].marketing_impact_id, impactId);
assert.strictEqual(normalized[1].marketing_impact_id, null);

const soap = buildDataSmsPayload([
  {
    phone: '099111111',
    text: 'hola',
    unique_id: '123',
    marketing_impact_id: impactId,
  },
]);
assert.strictEqual(soap[0].phone, '099111111');
assert.strictEqual(soap[0].text, 'hola');
assert.strictEqual(soap[0].uniqueId, '123');
assert.strictEqual(Object.prototype.hasOwnProperty.call(soap[0], 'marketing_impact_id'), false);

let threw = false;
try {
  validateMessagesInput([
    { phone: '099111111', text: 'hola', marketing_impact_id: 'not-a-uuid' },
  ]);
} catch (err) {
  threw = true;
  assert.ok(err instanceof NotifymeError);
}
assert.ok(threw);

console.log('OK unit-sms-message-impact-id');
