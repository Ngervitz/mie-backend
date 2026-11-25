'use strict';

/**
 * Minimal in-memory stand-in for cz_funnel_upsert_solicitudes_guarded (unit tests only).
 */

function historicoTip(historicoById, czId) {
  let maxMs = null;
  let estado = null;
  for (const row of historicoById.values()) {
    if (Number(row.cz_solicitud_id) !== Number(czId)) continue;
    const ms = Date.parse(String(row.fechahora_src || ''));
    if (!Number.isFinite(ms)) continue;
    if (maxMs == null || ms > maxMs) {
      maxMs = ms;
      estado =
        row.solicitudes_estados_id != null ? Number(row.solicitudes_estados_id) : null;
    }
  }
  return { maxMs, estado };
}

function shouldApply(existing, incoming, exTip, inTip) {
  const exMs = Date.parse(String(existing.updated_at_src || ''));
  const inMs = Date.parse(String(incoming.updated_at_src || ''));
  if (!Number.isFinite(exMs)) return true;
  if (!Number.isFinite(inMs)) return true;
  if (inMs > exMs) return true;
  if (inMs < exMs) return false;
  if (inTip.maxMs != null && (exTip.maxMs == null || inTip.maxMs > exTip.maxMs)) return true;
  if (
    inTip.maxMs != null &&
    exTip.maxMs != null &&
    inTip.maxMs === exTip.maxMs &&
    inTip.estado != null &&
    exTip.estado != null &&
    inTip.estado < exTip.estado
  ) {
    return false;
  }
  if (inTip.estado !== exTip.estado && inTip.maxMs === exTip.maxMs) return true;
  const inE = incoming.solicitudes_estados_id;
  const exE = existing.solicitudes_estados_id;
  if (inE != null && exE != null && inE < exE) return false;
  return inE !== exE;
}

function handleGuardedUpsertRpc(args, solicitudesById, historicoById) {
  const rows = Array.isArray(args && args.p_rows) ? args.p_rows : [];
  let applied = 0;
  let skipped = 0;
  for (const r of rows) {
    const czId = Number(r.cz_id);
    const existing = solicitudesById.get(czId);
    const inTip = {
      maxMs: r.incoming_hist_max ? Date.parse(String(r.incoming_hist_max)) : null,
      estado:
        r.incoming_hist_estado_id != null ? Number(r.incoming_hist_estado_id) : null,
    };
    const exTip = historicoTip(historicoById, czId);
    if (existing && !shouldApply(existing, r, exTip, inTip)) {
      skipped += 1;
      continue;
    }
    solicitudesById.set(czId, Object.assign({}, r));
    applied += 1;
  }
  return { applied, skipped };
}

module.exports = {
  handleGuardedUpsertRpc,
};