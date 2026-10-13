'use strict';

/**
 * ELM gate for the Rechazados survey circuit (STEP 1/2/3 → encuesta → Mi Plan).
 *
 * A CI is held while any of its ELM processes is not definitively closed: in evaluation,
 * referred ("Preaprobado ELM"), granted, technical error or ambiguous result. Automatic-circuit
 * solicitudes still open in CZ (projected 12/13/14/15/16) and fallback requests not finalized
 * hold it too. A definitive ELM rejection (or an ops closure without loan) does not hold: the
 * existing circuit continues with its own episode rules (one survey per CI for life, STEP per
 * episode, attempts per campaign + cz_solicitud_id). Nothing here creates or restarts invites.
 *
 * Reads only; errors propagate so callers fail closed (no invite when ELM state is unknown).
 */

const {
  PROCESS_TABLE,
  PROCESS_LIST_SELECT,
  CZ_STATE_TABLE,
} = require('../services/elm/repository');
const {
  classifyElmProcess,
  blocksSurveyInvite,
  readPostReferralRejectionStatuses,
} = require('../services/elm/classification');

const OPEN_PROJECTED_ESTADOS = Object.freeze([12, 13, 14, 15, 16]);
const FALLBACK_TABLE = 'provider_fallback_requests';
const IN_CHUNK = 200;
const ELM_GATE_TABLES = Object.freeze([PROCESS_TABLE, CZ_STATE_TABLE, FALLBACK_TABLE]);

/** ELM rows of the given CIs (processes, C1 projected estados, open fallback requests). */
async function readElmRowsByCis(supabase, cis) {
  const processes = [];
  const states = [];
  const openRequests = [];
  for (let i = 0; i < cis.length; i += IN_CHUNK) {
    const chunk = cis.slice(i, i + IN_CHUNK);
    const [pr, st, rq] = await Promise.all([
      supabase.from(PROCESS_TABLE).select(PROCESS_LIST_SELECT).in('ci', chunk),
      supabase.from(CZ_STATE_TABLE).select('cz_solicitud_id, ci, projected_estado').in('ci', chunk),
      supabase
        .from(FALLBACK_TABLE)
        .select('cz_solicitud_id, ci, exec_status, outcome, finalized_at')
        .in('ci', chunk)
        .is('finalized_at', null),
    ]);
    if (pr.error) throw new Error(PROCESS_TABLE + ' read failed: ' + pr.error.message);
    if (st.error) throw new Error(CZ_STATE_TABLE + ' read failed: ' + st.error.message);
    if (rq.error) throw new Error(FALLBACK_TABLE + ' read failed: ' + rq.error.message);
    processes.push(...(pr.data || []));
    states.push(...(st.data || []));
    openRequests.push(...(rq.data || []));
  }
  return { processes: processes, states: states, openRequests: openRequests };
}

/**
 * Pure: which CIs are held, given their ELM rows.
 * @returns {Map<number, { cz_solicitud_id: number, state: string, source: string }>}
 */
function computeElmSurveyBlocks(input) {
  const out = new Map();
  const projected = new Map();
  for (const s of input.states || []) {
    projected.set(Number(s.cz_solicitud_id), Number(s.projected_estado));
  }
  function hold(ci, czId, state, source) {
    const key = Number(ci);
    if (!Number.isSafeInteger(key) || out.has(key)) return;
    out.set(key, { cz_solicitud_id: Number(czId), state: state, source: source });
  }
  for (const p of input.processes || []) {
    const czId = Number(p.cz_solicitud_id);
    const c = classifyElmProcess(p, {
      nowMs: input.nowMs,
      postReferralRejectionStatuses: input.postReferralRejectionStatuses || [],
      projectedEstado:
        p.trigger_origin === 'cz_automatic' && projected.has(czId) ? projected.get(czId) : null,
    });
    if (blocksSurveyInvite(c)) hold(p.ci, czId, c.state, 'elm_process');
  }
  for (const s of input.states || []) {
    if (OPEN_PROJECTED_ESTADOS.includes(Number(s.projected_estado))) {
      hold(s.ci, s.cz_solicitud_id, 'cz_estado_' + Number(s.projected_estado), 'cz_automatic');
    }
  }
  for (const r of input.openRequests || []) {
    hold(r.ci, r.cz_solicitud_id, 'queued', 'fallback_request');
  }
  return out;
}

/**
 * @param {object} supabase
 * @param {number[]} cis
 * @param {{ nowMs?: number, postReferralRejectionStatuses?: string[] }} [opts]
 * @returns {Promise<Map<number, object>>}
 */
async function loadElmSurveyBlocksByCi(supabase, cis, opts) {
  const o = opts || {};
  const list = Array.from(
    new Set(
      (cis || []).map(Number).filter(function (n) {
        return Number.isSafeInteger(n) && n > 0;
      }),
    ),
  );
  if (!list.length) return new Map();
  const rows = await readElmRowsByCis(supabase, list);
  return computeElmSurveyBlocks({
    processes: rows.processes,
    states: rows.states,
    openRequests: rows.openRequests,
    nowMs: o.nowMs != null ? o.nowMs : Date.now(),
    postReferralRejectionStatuses:
      o.postReferralRejectionStatuses || readPostReferralRejectionStatuses(),
  });
}

module.exports = {
  ELM_GATE_TABLES,
  OPEN_PROJECTED_ESTADOS,
  readElmRowsByCis,
  computeElmSurveyBlocks,
  loadElmSurveyBlocksByCi,
};
