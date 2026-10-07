'use strict';

/**
 * Mi Deuda Stage 2 — read model of the ingested Mi Plan opt-in copy (read-only).
 *
 * Rechazados: derived `mi_deuda_optin` (accepted / withdrawn + date) next to the legacy
 * `mi_deuda_status`, which is never written or reinterpreted here. No event ≠ rejected.
 * Bags: DECLARED layer combined with the unchanged BCU bags.
 *
 * Fail-soft: Mi Deuda opt-in data is additive. Any read failure (e.g. tables not migrated yet)
 * yields `available: false` and leaves the existing Rechazados / BCU payloads untouched.
 * The opt-in authorizes Mi Plan → JANUS operation only: third_party_sharing_authorized is
 * always false.
 *
 * Effective CI = event.ci, else resolved_ci of a RESOLVED miplan_optin_ci_reconciliation row
 * (the immutable event keeps ci NULL). PENDING / TERMINAL_UNRESOLVABLE events have no CI: they
 * never produce state or bags and are only counted (declared_layer.ci_reconciliation).
 */

const { RESOLUTION } = require('./creditorCatalog');
const { OPTIN_STATE } = require('./miplanDebtOptinContract');
const { currentStateByCi, compareAuthorityDesc } = require('./miplanDebtOptinState');
const {
  effectiveDeclaredCreditor,
  buildDeclaredLayer,
  combineBagLayers,
  annotateBcuBags,
} = require('./miDeudaDeclaredLayer');

const PAGE_SIZE = 1000;
const IN_CHUNK = 100;

const EVENT_SELECT =
  'event_id, journey_id, seq, state, consent_text_version, origin_diagnosis_id, snapshot_diagnosis_id, ' +
  'miplan_created_at, excluded_count, ci, ci_resolution, received_at';

const DEBT_SELECT =
  'declared_debt_id, optin_event_id, ci, snapshot_diagnosis_id, position, client_debt_id, tipo, ' +
  'creditor_raw, miplan_acreedor_display, miplan_acreedor_normalizado, creditor_normalized_key, ' +
  'ingestion_resolution, ingestion_creditor_id, monto, monto_raw, pago, pago_raw, pago_mensual_actual, ' +
  'pago_mensual_actual_raw, situacion_ui, estado, atraso_tiempo, atraso_tiempo_aprox, ' +
  'ultimo_pago_declarado, ultimo_pago_declarado_raw, debt_confidence';

const RECON_TABLE = 'miplan_optin_ci_reconciliation';
const RECON_SELECT = 'event_id, status, resolved_ci';
const RECON_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RESOLVED: 'RESOLVED',
  TERMINAL: 'TERMINAL_UNRESOLVABLE',
});

const STATE_LABEL = Object.freeze({
  [OPTIN_STATE.OPTED_IN]: 'aceptó',
  [OPTIN_STATE.WITHDRAWN]: 'retiró',
});

function isMissingRelation(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42P01' || code === 'PGRST205') return true;
  return /does not exist|could not find the table/i.test(String(error.message || ''));
}

function readError(error, table) {
  const err = new Error('mi_deuda_optin read failed: ' + table);
  err.code = isMissingRelation(error) ? 'MI_DEUDA_OPTIN_NOT_MIGRATED' : 'MI_DEUDA_OPTIN_READ_FAILED';
  return err;
}

async function fetchAllPages(queryFn, table) {
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await queryFn(from, from + PAGE_SIZE - 1);
    if (error) throw readError(error, table);
    const chunk = Array.isArray(data) ? data : [];
    out.push.apply(out, chunk);
    if (chunk.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function fetchInChunks(values, fn) {
  const out = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    out.push.apply(out, await fn(values.slice(i, i + IN_CHUNK)));
  }
  return out;
}

/** event_id → resolved CI, from RESOLVED reconciliation rows only. */
function resolvedCiByEvent(reconRows) {
  const map = new Map();
  (reconRows || []).forEach(function (r) {
    if (r && r.status === RECON_STATUS.RESOLVED && r.resolved_ci != null) map.set(r.event_id, Number(r.resolved_ci));
  });
  return map;
}

/** Events with their effective CI (originals never mutated). */
function withEffectiveCi(events, resolvedMap) {
  return (events || []).map(function (e) {
    if (!e || e.ci != null || !resolvedMap.has(e.event_id)) return e;
    return Object.assign({}, e, { ci: resolvedMap.get(e.event_id), ci_source: 'reconciled' });
  });
}

async function fetchAllReconciliation(supabase) {
  return fetchAllPages(function (from, to) {
    return supabase.from(RECON_TABLE).select(RECON_SELECT).range(from, to);
  }, RECON_TABLE);
}

async function fetchEventsByIds(supabase, ids) {
  return fetchInChunks(ids, function (chunk) {
    return fetchAllPages(function (from, to) {
      return supabase.from('miplan_debt_optin_events').select(EVENT_SELECT).in('event_id', chunk).range(from, to);
    }, 'miplan_debt_optin_events');
  });
}

async function fetchEventsForCis(supabase, cis) {
  const direct = await fetchInChunks(cis, function (chunk) {
    return fetchAllPages(function (from, to) {
      return supabase.from('miplan_debt_optin_events').select(EVENT_SELECT).in('ci', chunk).range(from, to);
    }, 'miplan_debt_optin_events');
  });
  const recon = await fetchInChunks(cis, function (chunk) {
    return fetchAllPages(function (from, to) {
      return supabase.from(RECON_TABLE).select(RECON_SELECT).in('resolved_ci', chunk).range(from, to);
    }, RECON_TABLE);
  });
  const resolved = resolvedCiByEvent(recon);
  const have = new Set(direct.map(function (e) { return e.event_id; }));
  const missing = Array.from(resolved.keys()).filter(function (id) { return !have.has(id); });
  const late = missing.length ? await fetchEventsByIds(supabase, missing) : [];
  return withEffectiveCi(direct.concat(late), resolved);
}

async function fetchAllEventsWithCi(supabase, reconRows) {
  const rows = await fetchAllPages(function (from, to) {
    return supabase.from('miplan_debt_optin_events').select(EVENT_SELECT).range(from, to);
  }, 'miplan_debt_optin_events');
  const recon = reconRows || await fetchAllReconciliation(supabase);
  return withEffectiveCi(rows, resolvedCiByEvent(recon)).filter(function (e) {
    return e && e.ci != null;
  });
}

function reconciliationCounts(reconRows) {
  const counts = { pending: 0, resolved: 0, terminal_unresolvable: 0 };
  (reconRows || []).forEach(function (r) {
    if (r.status === RECON_STATUS.PENDING) counts.pending += 1;
    else if (r.status === RECON_STATUS.RESOLVED) counts.resolved += 1;
    else if (r.status === RECON_STATUS.TERMINAL) counts.terminal_unresolvable += 1;
  });
  return counts;
}

async function fetchDebtsForEvents(supabase, eventIds) {
  return fetchInChunks(eventIds, function (chunk) {
    return fetchAllPages(function (from, to) {
      return supabase.from('miplan_declared_debts').select(DEBT_SELECT).in('optin_event_id', chunk).range(from, to);
    }, 'miplan_declared_debts');
  });
}

/** @param {ReturnType<typeof currentStateByCi> extends Map<any, infer V> ? V : never} s */
function formatMiDeudaOptin(s) {
  if (!s) return null;
  return {
    state: s.state,
    label: STATE_LABEL[s.state] || s.state,
    active: s.active === true,
    at: s.at,
    event_id: s.event_id,
    consent_text_version: s.consent_text_version == null ? null : s.consent_text_version,
    journeys: s.journeys,
    third_party_sharing_authorized: false,
  };
}

function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function detailDebtView(debt, resolver) {
  let effective = null;
  if (resolver) effective = effectiveDeclaredCreditor(debt, resolver);
  return {
    declared_debt_id: debt.declared_debt_id,
    position: debt.position,
    tipo: debt.tipo == null ? null : debt.tipo,
    creditor_raw: debt.creditor_raw == null ? null : debt.creditor_raw,
    miplan_acreedor_display: debt.miplan_acreedor_display == null ? null : debt.miplan_acreedor_display,
    creditor_normalized_key: debt.creditor_normalized_key == null ? null : debt.creditor_normalized_key,
    ingestion_resolution: debt.ingestion_resolution,
    unknown: debt.ingestion_resolution !== RESOLUTION.RESOLVED,
    effective_creditor_id: effective ? effective.creditor_id : null,
    effective_creditor_name: effective ? effective.display_name : null,
    monto: toNumberOrNull(debt.monto),
    monto_raw: debt.monto_raw == null ? null : debt.monto_raw,
    pago: toNumberOrNull(debt.pago),
    pago_mensual_actual: toNumberOrNull(debt.pago_mensual_actual),
    situacion_ui: debt.situacion_ui == null ? null : debt.situacion_ui,
    estado: debt.estado == null ? null : debt.estado,
    atraso_tiempo: debt.atraso_tiempo == null ? null : debt.atraso_tiempo,
    atraso_tiempo_aprox: debt.atraso_tiempo_aprox == null ? null : debt.atraso_tiempo_aprox,
    ultimo_pago_declarado: toNumberOrNull(debt.ultimo_pago_declarado),
    debt_confidence: debt.debt_confidence == null ? null : debt.debt_confidence,
  };
}

function historyView(e) {
  return {
    event_id: e.event_id,
    journey_id: e.journey_id,
    seq: e.seq,
    state: e.state,
    label: STATE_LABEL[e.state] || e.state,
    at: e.miplan_created_at,
    snapshot_diagnosis_id: e.snapshot_diagnosis_id,
    excluded_count: e.excluded_count == null ? null : e.excluded_count,
    consent_text_version: e.consent_text_version == null ? null : e.consent_text_version,
    ci_reconciled: e.ci_source === 'reconciled',
  };
}

/**
 * Attach `mi_deuda_optin` to Rechazados list rows (null = no Mi Plan opt-in event).
 * @returns {Promise<{ rows: object[], available: boolean, error_code: string|null }>}
 */
async function attachMiDeudaOptinToListRows(supabase, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const cis = [];
  const seen = new Set();
  list.forEach(function (r) {
    const ci = r && r.ci != null ? Number(r.ci) : NaN;
    if (!Number.isSafeInteger(ci) || ci <= 0 || seen.has(ci)) return;
    seen.add(ci);
    cis.push(ci);
  });
  let states = new Map();
  try {
    if (cis.length) states = currentStateByCi(await fetchEventsForCis(supabase, cis));
  } catch (err) {
    list.forEach(function (r) {
      r.mi_deuda_optin = null;
    });
    return { rows: list, available: false, error_code: (err && err.code) || 'MI_DEUDA_OPTIN_READ_FAILED' };
  }
  list.forEach(function (r) {
    r.mi_deuda_optin = formatMiDeudaOptin(states.get(Number(r.ci)) || null);
  });
  return { rows: list, available: true, error_code: null };
}

/**
 * Detail block for one CI: current state, history, latest authorized snapshot with its debts.
 * @param {object} supabase
 * @param {number} ci
 * @param {{ loadCatalog?: Function }} [opts]
 */
async function loadMiDeudaOptinDetail(supabase, ci, opts) {
  try {
    const events = await fetchEventsForCis(supabase, [ci]);
    const state = currentStateByCi(events).get(Number(ci)) || null;
    const sorted = events.slice().sort(compareAuthorityDesc);
    const latestOptIn = sorted.find(function (e) {
      return e.state === OPTIN_STATE.OPTED_IN;
    }) || null;
    let snapshot = null;
    if (latestOptIn) {
      const debts = (await fetchDebtsForEvents(supabase, [latestOptIn.event_id])).sort(function (a, b) {
        return a.position - b.position;
      });
      let resolver = null;
      let catalogAvailable = false;
      if (opts && opts.loadCatalog) {
        try {
          resolver = await opts.loadCatalog(supabase);
          catalogAvailable = true;
        } catch (_e) {
          resolver = null;
        }
      }
      snapshot = {
        event_id: latestOptIn.event_id,
        snapshot_diagnosis_id: latestOptIn.snapshot_diagnosis_id,
        at: latestOptIn.miplan_created_at,
        excluded_count: latestOptIn.excluded_count,
        feeds_bags: !!(state && state.active && state.event_id === latestOptIn.event_id),
        catalog_available: catalogAvailable,
        debts: debts.map(function (d) {
          return detailDebtView(d, resolver);
        }),
      };
    }
    return {
      available: true,
      current: formatMiDeudaOptin(state),
      snapshot: snapshot,
      history: sorted.map(historyView),
      third_party_sharing_authorized: false,
    };
  } catch (err) {
    return {
      available: false,
      error_code: (err && err.code) || 'MI_DEUDA_OPTIN_READ_FAILED',
      third_party_sharing_authorized: false,
    };
  }
}

function declaredBagView(c) {
  return {
    creditor_id: c.creditor_id,
    display_name: c.display_name,
    people_bcu: c.people_bcu,
    people_declared: c.people_declared,
    people_both: c.people_both,
    people_union: c.people_union,
    declared_debts_count: c.declared_debts_count,
    members: c.members
      .filter(function (m) {
        return m.in_declared;
      })
      .map(function (m) {
        return { ci: m.ci, also_in_bcu: m.in_bcu, declared_debts: m.declared_debts };
      }),
  };
}

/**
 * Add the DECLARED layer to an already formatted BCU bags payload (loadMiDeudaBags output).
 * BCU bags keep every existing field (people_count stays BCU); counters are additive.
 * On any failure the BCU payload is returned unchanged with declared_layer.available=false.
 *
 * @param {object} supabase
 * @param {object} bcuData formatMiDeudaBagsResponse(...) + creditor_catalog
 * @param {object} resolver catalog resolver already loaded for the BCU bags
 */
async function addDeclaredLayerToBags(supabase, bcuData, resolver) {
  try {
    const reconRows = await fetchAllReconciliation(supabase);
    const events = await fetchAllEventsWithCi(supabase, reconRows);
    const ciByEvent = new Map(events.map(function (e) { return [e.event_id, e.ci]; }));
    const activeIds = [];
    currentStateByCi(events).forEach(function (s) {
      if (s.active) activeIds.push(s.event_id);
    });
    const debts = (activeIds.length ? await fetchDebtsForEvents(supabase, activeIds) : []).map(function (d) {
      return d.ci != null ? d : Object.assign({}, d, { ci: ciByEvent.get(d.optin_event_id) });
    });
    const layer = buildDeclaredLayer({ events: events, debts: debts, resolver: resolver });
    const combined = combineBagLayers({ bcuBags: bcuData.bags || [], declaredLayer: layer });
    return Object.assign({}, bcuData, {
      bags: annotateBcuBags(bcuData.bags || [], combined),
      declared_layer: {
        available: true,
        counts: layer.counts,
        bags: combined
          .filter(function (c) {
            return c.people_declared > 0;
          })
          .map(declaredBagView),
        unbagged_active_debts_count: layer.unbagged_active_debts.length,
        ci_reconciliation: reconciliationCounts(reconRows),
        third_party_sharing_authorized: false,
      },
    });
  } catch (err) {
    return Object.assign({}, bcuData, {
      declared_layer: {
        available: false,
        error_code: (err && err.code) || 'MI_DEUDA_OPTIN_READ_FAILED',
        third_party_sharing_authorized: false,
      },
    });
  }
}

module.exports = {
  EVENT_SELECT,
  DEBT_SELECT,
  isMissingRelation,
  formatMiDeudaOptin,
  attachMiDeudaOptinToListRows,
  loadMiDeudaOptinDetail,
  addDeclaredLayerToBags,
  fetchAllEventsWithCi,
  fetchAllReconciliation,
  fetchDebtsForEvents,
  resolvedCiByEvent,
  withEffectiveCi,
  reconciliationCounts,
};
