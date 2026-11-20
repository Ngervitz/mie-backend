'use strict';

/**
 * CDV estado 8 → ELM automation (pure detection + config). No network.
 * node scripts/unit-cdv-estado8-elm-automation.js
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
  detectEstado8CandidatesFromItems,
} = require('../src/lib/cdvEstado8ElmAutomation');
const { readCdvEstado8ElmConfig } = require('../src/lib/cdvEstado8ElmConfig');
const { TRIGGER_ORIGINS } = require('../src/services/elm/constants');

const ESTADO_8 = 8;

function item(overrides) {
  return Object.assign(
    {
      id: 9001,
      solicitudes_estados_id: 4,
      fechaReg: '2026-11-20T14:00:00',
      historico: [],
    },
    overrides || {},
  );
}

const map = detectEstado8CandidatesFromItems([
  item({
    id: 100,
    solicitudes_estados_id: ESTADO_8,
    fechaReg: '2026-11-20T15:00:00',
  }),
  item({
    id: 200,
    solicitudes_estados_id: ESTADO_8,
    fechaReg: '2026-11-20T16:00:00',
    historico: [{ id: 1, solicitudes_estados_id: ESTADO_8, fechahora: '2026-11-19T10:00:00' }],
  }),
]);

assert.equal(map.size, 2, 'two distinct cz ids');
assert.ok(map.has(100));
assert.ok(map.has(200));
assert.equal(
  Date.parse(map.get(200)),
  Date.parse('2026-11-19T10:00:00'),
  'earliest historico estado 8 wins',
);

const cfgOff = readCdvEstado8ElmConfig({ CDV_ESTADO8_ELM_AUTOMATION_ENABLED: 'false' });
assert.equal(cfgOff.automationEnabled, false);

const cfgOn = readCdvEstado8ElmConfig({ CDV_ESTADO8_ELM_AUTOMATION_ENABLED: 'true' });
assert.equal(cfgOn.automationEnabled, true);
assert.equal(cfgOn.triggerOrigin, 'cdv_estado_8');
assert.ok(TRIGGER_ORIGINS.includes('cdv_estado_8'));

const excluded = new Set(cfgOn.excludedCzSolicitudIds);
assert.equal(excluded.has(1490), true, 'protected id in exclusion list');

console.log('unit-cdv-estado8-elm-automation: OK');