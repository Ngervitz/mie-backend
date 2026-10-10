'use strict';

/**
 * ELM KPIs over every elm_lead_processes row (read-only, pure). Never mixed with CDV.
 *
 * One row per solicitud (UNIQUE cz_solicitud_id): technical retries reuse the row and postbacks
 * only update it, so counting rows never double counts.
 *
 *   flow     what happened to the processes started in the window (created_at), even if the
 *            state changed later: started, S1 executed, S1 favorable, aceptados S2, definitive
 *            rejections, confirmed grants (disbursed_at).
 *   current  where those processes are now (commercial state, src/services/elm/classification.js).
 *
 * "Aceptados S2" (referred_s2) are leads ELM received and assigned to Copanel (Aceptado ELM),
 * not credit approvals; a later grant still counts there and in `granted`.
 */

const { TRIGGER_ORIGINS } = require('./constants');
const { classifyElmProcess, COMMERCIAL } = require('./classification');

function emptyFlow() {
  return {
    started: 0,
    s1_executed: 0,
    s1_favorable: 0,
    referred_s2: 0,
    rejected_definitive: 0,
    granted: 0,
    pending_or_review: 0,
    distinct_ci_started: 0,
    distinct_ci_referred: 0,
  };
}

function emptyCurrent() {
  const out = {};
  for (const k of Object.values(COMMERCIAL)) out[k] = 0;
  return out;
}

function inWindow(iso, fromMs, toMs) {
  const t = iso ? Date.parse(String(iso)) : NaN;
  if (fromMs != null && (!Number.isFinite(t) || t < fromMs)) return false;
  if (toMs != null && (!Number.isFinite(t) || t > toMs)) return false;
  return true;
}

function msOrNull(iso) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object[]} processes list projection rows
 * @param {{
 *   from?: string|null, to?: string|null, nowMs?: number,
 *   projectedByCz?: Map<number, number>,
 *   postReferralRejectionStatuses?: readonly string[],
 * }} [options]
 */
function computeElmKpis(processes, options) {
  const opts = options || {};
  const fromMs = msOrNull(opts.from);
  const toMs = msOrNull(opts.to);
  const projected = opts.projectedByCz || new Map();
  const segments = ['total'].concat(TRIGGER_ORIGINS);
  const flow = {};
  const current = {};
  const ciSets = {};
  for (const s of segments) {
    flow[s] = emptyFlow();
    current[s] = emptyCurrent();
    ciSets[s] = { started: new Set(), referred: new Set() };
  }

  for (const p of processes || []) {
    if (!p || !inWindow(p.created_at, fromMs, toMs)) continue;
    const origin = TRIGGER_ORIGINS.includes(p.trigger_origin) ? p.trigger_origin : null;
    const czId = Number(p.cz_solicitud_id);
    const c = classifyElmProcess(p, {
      nowMs: opts.nowMs,
      postReferralRejectionStatuses: opts.postReferralRejectionStatuses || [],
      projectedEstado: projected.has(czId) ? projected.get(czId) : null,
    });
    const referred =
      Boolean(p.referred_at) || c.state === COMMERCIAL.REFERRED || c.state === COMMERCIAL.GRANTED;
    const targets = origin ? ['total', origin] : ['total'];
    for (const s of targets) {
      const f = flow[s];
      f.started += 1;
      if (p.s1_started_at || (p.s1_status && p.s1_status !== 'not_started')) f.s1_executed += 1;
      if (p.s1_status === 'eligible') f.s1_favorable += 1;
      if (referred) f.referred_s2 += 1;
      if (c.state === COMMERCIAL.REJECTED) f.rejected_definitive += 1;
      if (c.state === COMMERCIAL.GRANTED) f.granted += 1;
      if (c.state === COMMERCIAL.IN_EVALUATION || c.state === COMMERCIAL.REVIEW) {
        f.pending_or_review += 1;
      }
      current[s][c.state] += 1;
      if (p.ci != null) {
        ciSets[s].started.add(String(p.ci));
        if (referred) ciSets[s].referred.add(String(p.ci));
      }
    }
  }
  for (const s of segments) {
    flow[s].distinct_ci_started = ciSets[s].started.size;
    flow[s].distinct_ci_referred = ciSets[s].referred.size;
  }
  return {
    window: { from: opts.from || null, to: opts.to || null, by: 'process_created_at' },
    flow: flow,
    current: current,
  };
}

module.exports = { computeElmKpis };
