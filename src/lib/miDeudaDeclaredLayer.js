'use strict';

/**
 * Mi Deuda Stage 2 — DECLARED bag layer + unknown creditor queue (pure, no I/O).
 *
 * Effective creditor of a declared debt = the creditor_id snapshotted at ingestion, following
 * an explicit single-hop merge at read time. Nothing else: a debt ingested as UNKNOWN stays out
 * of bags even if the catalog would resolve its key today (shown only as a review hint).
 *
 * Bags group people (CI) per creditor_id. One CI counts once per bag; its debts stay separate.
 * "Also in BCU" = same CI + same creditor_id, never "same obligation" (no debt matching).
 */

const {
  CREDITOR_SOURCES,
  RESOLUTION,
  CreditorCatalogIntegrityError,
  effectiveCreditorById,
  resolveCreditor,
} = require('./creditorCatalog');
const { currentStateByCi } = require('./miplanDebtOptinState');

const RAW_EXAMPLES_MAX = 5;

/**
 * @param {object} debt miplan_declared_debts row
 * @param {object} resolver
 * @returns {{ creditor_id: string, display_name: string }|null}
 */
function effectiveDeclaredCreditor(debt, resolver) {
  if (!debt || debt.ingestion_resolution !== RESOLUTION.RESOLVED) return null;
  if (debt.ingestion_creditor_id == null) {
    throw new CreditorCatalogIntegrityError('RESOLVED declared debt without ingestion_creditor_id', {
      declared_debt_id: debt.declared_debt_id,
    });
  }
  const eff = effectiveCreditorById(resolver, debt.ingestion_creditor_id);
  return { creditor_id: eff.creditor_id, display_name: eff.display_name };
}

function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function declaredDebtView(debt, effective) {
  return {
    declared_debt_id: debt.declared_debt_id,
    optin_event_id: debt.optin_event_id,
    snapshot_diagnosis_id: debt.snapshot_diagnosis_id,
    position: debt.position,
    tipo: debt.tipo == null ? null : debt.tipo,
    creditor_raw: debt.creditor_raw == null ? null : debt.creditor_raw,
    miplan_acreedor_display: debt.miplan_acreedor_display == null ? null : debt.miplan_acreedor_display,
    ingestion_resolution: debt.ingestion_resolution,
    ingestion_creditor_id: debt.ingestion_creditor_id == null ? null : debt.ingestion_creditor_id,
    effective_creditor_id: effective ? effective.creditor_id : null,
    effective_creditor_name: effective ? effective.display_name : null,
    monto: toNumberOrNull(debt.monto),
    monto_raw: debt.monto_raw == null ? null : debt.monto_raw,
    pago: toNumberOrNull(debt.pago),
    situacion_ui: debt.situacion_ui == null ? null : debt.situacion_ui,
    estado: debt.estado == null ? null : debt.estado,
  };
}

/**
 * @param {{ events: object[], debts: object[], resolver: object }} input
 */
function buildDeclaredLayer(input) {
  if (!input || !input.resolver) {
    throw new CreditorCatalogIntegrityError('creditor resolver required for declared layer');
  }
  const stateByCi = currentStateByCi(input.events || []);
  const activeEventIds = new Set();
  stateByCi.forEach(function (s) {
    if (s.active) activeEventIds.add(s.event_id);
  });

  /** @type {Map<string, { display_name: string, people: Map<number, object[]> }>} */
  const byCreditor = new Map();
  const unbaggedActive = [];
  let activeDebts = 0;

  (input.debts || []).forEach(function (debt) {
    if (!debt || !activeEventIds.has(debt.optin_event_id)) return;
    const ci = Number(debt.ci);
    if (!Number.isSafeInteger(ci)) return;
    activeDebts += 1;
    const eff = effectiveDeclaredCreditor(debt, input.resolver);
    const view = declaredDebtView(debt, eff);
    if (!eff) {
      unbaggedActive.push(Object.assign({ ci: ci }, view));
      return;
    }
    if (!byCreditor.has(eff.creditor_id)) {
      byCreditor.set(eff.creditor_id, { display_name: eff.display_name, people: new Map() });
    }
    const people = byCreditor.get(eff.creditor_id).people;
    if (!people.has(ci)) people.set(ci, []);
    people.get(ci).push(view);
  });

  byCreditor.forEach(function (b) {
    b.people.forEach(function (list) {
      list.sort(function (x, y) {
        return x.position - y.position;
      });
    });
  });

  let activePeople = 0;
  stateByCi.forEach(function (s) {
    if (s.active) activePeople += 1;
  });

  return {
    state_by_ci: stateByCi,
    active_event_ids: activeEventIds,
    by_creditor: byCreditor,
    unbagged_active_debts: unbaggedActive,
    counts: {
      people_with_state: stateByCi.size,
      people_active: activePeople,
      active_debts: activeDebts,
      active_debts_bagged: activeDebts - unbaggedActive.length,
      active_debts_unbagged: unbaggedActive.length,
    },
  };
}

function compareBags(a, b) {
  return (
    b.people_union - a.people_union ||
    a.display_name.localeCompare(b.display_name) ||
    (a.creditor_id < b.creditor_id ? -1 : a.creditor_id > b.creditor_id ? 1 : 0)
  );
}

/**
 * Combine BCU bags (buildMiDeudaBagModel().bags, unchanged) with the declared layer.
 * @param {{ bcuBags: object[], declaredLayer: ReturnType<typeof buildDeclaredLayer> }} input
 */
function combineBagLayers(input) {
  const bcuBags = (input && input.bcuBags) || [];
  const declared = input && input.declaredLayer;
  const byCreditor = new Map();

  function slot(creditorId, displayName) {
    if (!byCreditor.has(creditorId)) {
      byCreditor.set(creditorId, { creditor_id: creditorId, display_name: displayName, members: new Map() });
    }
    return byCreditor.get(creditorId);
  }
  function member(bag, ci) {
    if (!bag.members.has(ci)) {
      bag.members.set(ci, { ci: ci, in_bcu: false, in_declared: false, declared_debts: [], bcu_rows: [] });
    }
    return bag.members.get(ci);
  }

  bcuBags.forEach(function (b) {
    const bag = slot(b.creditor_id, b.institution_canonical);
    (b.members || []).forEach(function (row) {
      const m = member(bag, Number(row.ci));
      m.in_bcu = true;
      m.bcu_rows.push(row);
    });
  });
  if (declared) {
    declared.by_creditor.forEach(function (d, creditorId) {
      const bag = slot(creditorId, d.display_name);
      d.people.forEach(function (debts, ci) {
        const m = member(bag, ci);
        m.in_declared = true;
        m.declared_debts = debts.slice();
      });
    });
  }

  return Array.from(byCreditor.values())
    .map(function (bag) {
      const members = Array.from(bag.members.values()).sort(function (a, b) {
        return a.ci - b.ci;
      });
      let bcu = 0;
      let dec = 0;
      let both = 0;
      members.forEach(function (m) {
        if (m.in_bcu) bcu += 1;
        if (m.in_declared) dec += 1;
        if (m.in_bcu && m.in_declared) both += 1;
      });
      return {
        creditor_id: bag.creditor_id,
        display_name: bag.display_name,
        people_bcu: bcu,
        people_declared: dec,
        people_both: both,
        people_union: members.length,
        declared_debts_count: members.reduce(function (acc, m) {
          return acc + m.declared_debts.length;
        }, 0),
        members: members,
      };
    })
    .sort(compareBags);
}

/**
 * Additive counters on existing BCU bags; people_count keeps its BCU meaning.
 * Returns new objects (input bags untouched).
 */
function annotateBcuBags(bcuBags, combined) {
  const byId = new Map(
    (combined || []).map(function (c) {
      return [c.creditor_id, c];
    }),
  );
  return (bcuBags || []).map(function (b) {
    const c = byId.get(b.creditor_id);
    return Object.assign({}, b, {
      people_bcu: b.people_count,
      people_declared: c ? c.people_declared : 0,
      people_both: c ? c.people_both : 0,
      people_union: c ? c.people_union : b.people_count,
    });
  });
}

/**
 * Review queue of declared debts not resolved at ingestion, grouped by (source, normalized_key).
 * `current_catalog_hint` is what the catalog says TODAY: a hint only, it never re-buckets a debt.
 *
 * @param {{ debts: object[], events?: object[], resolver: object }} input
 */
function buildUnknownCreditorQueue(input) {
  if (!input || !input.resolver) {
    throw new CreditorCatalogIntegrityError('creditor resolver required for unknown queue');
  }
  const activeIds = new Set();
  currentStateByCi(input.events || []).forEach(function (s) {
    if (s.active) activeIds.add(s.event_id);
  });
  const groups = new Map();
  (input.debts || []).forEach(function (debt) {
    if (!debt || debt.ingestion_resolution === RESOLUTION.RESOLVED) return;
    const key = debt.creditor_normalized_key == null ? null : String(debt.creditor_normalized_key);
    const slotKey = CREDITOR_SOURCES.MIPLAN_DECLARED + '\0' + (key == null ? '' : key);
    if (!groups.has(slotKey)) {
      groups.set(slotKey, {
        source: CREDITOR_SOURCES.MIPLAN_DECLARED,
        normalized_key: key,
        ingestion_resolutions: new Set(),
        occurrences: 0,
        active_occurrences: 0,
        cis: new Set(),
        raw_examples: [],
        display_hints: [],
      });
    }
    const g = groups.get(slotKey);
    g.occurrences += 1;
    if (activeIds.has(debt.optin_event_id)) g.active_occurrences += 1;
    g.ingestion_resolutions.add(debt.ingestion_resolution);
    if (debt.ci != null) g.cis.add(Number(debt.ci));
    if (debt.creditor_raw != null && g.raw_examples.length < RAW_EXAMPLES_MAX &&
        g.raw_examples.indexOf(debt.creditor_raw) === -1) {
      g.raw_examples.push(debt.creditor_raw);
    }
    [debt.miplan_acreedor_display, debt.miplan_acreedor_normalizado].forEach(function (h) {
      if (h != null && g.display_hints.length < RAW_EXAMPLES_MAX && g.display_hints.indexOf(h) === -1) {
        g.display_hints.push(h);
      }
    });
  });

  return Array.from(groups.values())
    .map(function (g) {
      const hint = resolveCreditor(input.resolver, CREDITOR_SOURCES.MIPLAN_DECLARED, g.normalized_key);
      return {
        source: g.source,
        normalized_key: g.normalized_key,
        ingestion_resolutions: Array.from(g.ingestion_resolutions).sort(),
        occurrences: g.occurrences,
        active_occurrences: g.active_occurrences,
        distinct_ci: g.cis.size,
        raw_examples: g.raw_examples,
        display_hints: g.display_hints,
        current_catalog_hint: {
          resolution: hint.resolution,
          creditor_id: hint.creditor_id,
          display_name: hint.display_name,
        },
      };
    })
    .sort(function (a, b) {
      return (
        b.occurrences - a.occurrences ||
        String(a.normalized_key || '').localeCompare(String(b.normalized_key || ''))
      );
    });
}

module.exports = {
  effectiveDeclaredCreditor,
  buildDeclaredLayer,
  combineBagLayers,
  annotateBcuBags,
  buildUnknownCreditorQueue,
};
