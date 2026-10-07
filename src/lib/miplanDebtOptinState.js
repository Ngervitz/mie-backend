'use strict';

/**
 * Mi Deuda Stage 2 — current opt-in state derived from ingested events (pure, no I/O).
 *
 * Authority comes from the ORIGINAL Mi Plan event, never from arrival order:
 *   1. Per journey: the event with the highest seq (Mi Plan's append-only chain).
 *   2. Per CI, across its journeys: the journey head with the greatest Mi Plan created_at
 *      (clock_timestamp() of Mi Plan's single database, compared at microsecond precision);
 *      exact tie → the greater event_id (lowercase uuid string; stable, carries no meaning).
 *   received_at (JANUS arrival) is never read. Events whose CI is null are ignored here; callers
 *   pass the effective CI (event ci, else a RESOLVED reconciliation).
 * opted_in → active opportunity; withdrawn → inactive. History is never dropped; only the current
 * event's snapshot feeds bags. "No event" is not "rejected".
 */

const { OPTIN_STATE } = require('./miplanDebtOptinContract');

const TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * Epoch microseconds of a timestamptz text (as PostgREST / Postgres render it). null if invalid.
 * @param {unknown} ts
 * @returns {bigint|null}
 */
function createdAtMicros(ts) {
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isFinite(ms) ? BigInt(ms) * 1000n : null;
  }
  const m = TS_RE.exec(String(ts == null ? '' : ts));
  if (!m) return null;
  let offset = m[4];
  if (offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    offset = offset[0] + digits.slice(0, 2) + ':' + (digits.slice(2) || '00');
  }
  const ms = Date.parse(m[1] + 'T' + m[2] + offset);
  if (!Number.isFinite(ms)) return null;
  return BigInt(ms) * 1000n + BigInt((m[3] || '').padEnd(6, '0'));
}

/** Most authoritative first. Invalid timestamps rank last (the contract rejects them anyway). */
function compareAuthorityDesc(a, b) {
  const ta = createdAtMicros(a.miplan_created_at);
  const tb = createdAtMicros(b.miplan_created_at);
  if (ta !== tb) {
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta > tb ? -1 : 1;
  }
  const ea = String(a.event_id).toLowerCase();
  const eb = String(b.event_id).toLowerCase();
  return ea < eb ? 1 : ea > eb ? -1 : 0;
}

/**
 * @param {object[]} events rows of miplan_debt_optin_events
 * @returns {Map<string, object>} journey_id → head event
 */
function currentEventByJourney(events) {
  const heads = new Map();
  (events || []).forEach(function (e) {
    if (!e || !e.journey_id) return;
    const prev = heads.get(e.journey_id);
    if (!prev || Number(e.seq) > Number(prev.seq)) heads.set(e.journey_id, e);
  });
  return heads;
}

/**
 * @param {object[]} events
 * @returns {Map<number, { ci: number, state: string, active: boolean, event_id: string,
 *   journey_id: string, snapshot_diagnosis_id: string, at: string, journeys: number }>}
 */
function currentStateByCi(events) {
  const byCi = new Map();
  currentEventByJourney(events).forEach(function (head) {
    if (head.ci == null) return;
    const ci = Number(head.ci);
    if (!Number.isSafeInteger(ci)) return;
    if (!byCi.has(ci)) byCi.set(ci, []);
    byCi.get(ci).push(head);
  });
  const out = new Map();
  byCi.forEach(function (heads, ci) {
    const sorted = heads.slice().sort(compareAuthorityDesc);
    const cur = sorted[0];
    out.set(ci, {
      ci: ci,
      state: cur.state,
      active: cur.state === OPTIN_STATE.OPTED_IN,
      event_id: cur.event_id,
      journey_id: cur.journey_id,
      snapshot_diagnosis_id: cur.snapshot_diagnosis_id,
      consent_text_version: cur.consent_text_version == null ? null : cur.consent_text_version,
      at: cur.miplan_created_at,
      journeys: heads.length,
    });
  });
  return out;
}

/** Event ids whose snapshot currently authorizes operation (one per CI at most). */
function activeOptinEventIds(events) {
  const ids = new Set();
  currentStateByCi(events).forEach(function (s) {
    if (s.active) ids.add(s.event_id);
  });
  return ids;
}

module.exports = {
  createdAtMicros,
  compareAuthorityDesc,
  currentEventByJourney,
  currentStateByCi,
  activeOptinEventIds,
};
