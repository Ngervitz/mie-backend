'use strict';

/**
 * Historico tip from CZ /solicitudes payload (freshness tie-break at equal updated_at_src).
 */

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function updatedAtMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object|null|undefined} item CZ API solicitud
 * @returns {{ incoming_hist_max: string|null, incoming_hist_estado_id: number|null }}
 */
function computeIncomingHistoricoTip(item) {
  let maxMs = null;
  let estadoAtMax = null;
  const hist = item && Array.isArray(item.historico) ? item.historico : [];
  for (const row of hist) {
    if (!row) continue;
    const ms = updatedAtMs(row.fechahora);
    if (ms == null) continue;
    if (maxMs == null || ms > maxMs) {
      maxMs = ms;
      estadoAtMax =
        row.solicitudes_estados_id != null
          ? Number(row.solicitudes_estados_id)
          : null;
    }
  }
  return {
    incoming_hist_max: maxMs != null ? new Date(maxMs).toISOString() : null,
    incoming_hist_estado_id: estadoAtMax,
  };
}

/**
 * @param {object} row mapped parent row
 * @param {object} sourceItem
 * @returns {object} row + historico tip fields for RPC jsonb
 */
function toGuardedUpsertPayloadRow(row, sourceItem) {
  const tip = computeIncomingHistoricoTip(sourceItem);
  return Object.assign({}, row, {
    incoming_hist_max: tip.incoming_hist_max,
    incoming_hist_estado_id: tip.incoming_hist_estado_id,
    fecha_nacimiento: row.fecha_nacimiento || null,
    updated_at_src: row.updated_at_src || null,
  });
}

module.exports = {
  updatedAtMs,
  computeIncomingHistoricoTip,
  toGuardedUpsertPayloadRow,
};