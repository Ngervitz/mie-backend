'use strict';

const assert = require('assert');
const {
  computeIncomingHistoricoTip,
  updatedAtMs,
} = require('../src/lib/czFunnelSolicitudesUpsertFreshness');

assert.strictEqual(updatedAtMs('2026-11-24T12:00:00Z'), Date.parse('2026-11-24T12:00:00Z'));

const tip = computeIncomingHistoricoTip({
  historico: [
    { solicitudes_estados_id: 7, fechahora: '2026-11-24T12:00:01Z' },
    { solicitudes_estados_id: 8, fechahora: '2026-11-24T12:00:05Z' },
  ],
});
assert.strictEqual(tip.incoming_hist_estado_id, 8);
assert.ok(tip.incoming_hist_max && tip.incoming_hist_max.includes('12:00:05'));

assert.deepStrictEqual(
  computeIncomingHistoricoTip({ historico: [] }),
  { incoming_hist_max: null, incoming_hist_estado_id: null },
);

console.log('unit-cz-funnel-solicitudes-upsert-freshness: OK');