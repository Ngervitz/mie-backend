'use strict';

/**
 * Mi Deuda — Stage 1C read-only bag model (no I/O, no persistence).
 *
 * Reuses Rechazados snapshot ordering via sortSnapshotsDesc from rejectedOpsRead.
 * Canonicalization is an explicit approved map only — unknown raw → UNMAPPED.
 */

const { sortSnapshotsDesc } = require('./rejectedOpsRead');

const MAP_STATUS = Object.freeze({
  MAPPED: 'MAPPED',
  UNMAPPED: 'UNMAPPED',
  REVIEW_NEEDED: 'REVIEW_NEEDED',
});

const BAG_EXCLUSION = Object.freeze({
  AMBIGUOUS_CONSOLIDATION: 'AMBIGUOUS_CONSOLIDATION',
  UNMAPPED: 'UNMAPPED',
  REVIEW_NEEDED: 'REVIEW_NEEDED',
  NOT_MEMBER: 'NOT_MEMBER',
});

/**
 * Approved raw → canonical mappings (Stage 1B + closed decisions).
 * No fuzzy rules. No general SA→S.A. Unknown raw stays UNMAPPED.
 */
const APPROVED_RAW_TO_CANONICAL = Object.freeze({
  'CASH S.A.': 'CASH S.A.',
  'SOCUR S.A.': 'SOCUR S.A.',
  'Banco Santander S.A.': 'Banco Santander S.A.',
  'OCA S.A.': 'OCA S.A.',
  'RETOP S.A.': 'RETOP S.A.',
  'BAUTZEN S.A.': 'BAUTZEN S.A.',
  'Scotiabank Uruguay S.A.': 'Scotiabank Uruguay S.A.',
  'Floder S.A.': 'Floder S.A.',
  'PASS CARD S.A.': 'PASS CARD S.A.',
  ANDA: 'ANDA',
  'Banco Bilbao Vizcaya Argentaria Uruguay S.A.':
    'Banco Bilbao Vizcaya Argentaria Uruguay S.A.',
  'FUCAC VERDE COOPERATIVA DE AHORRO Y CRÉDITO':
    'FUCAC VERDE COOPERATIVA DE AHORRO Y CRÉDITO',
  'Cooperativa de Ahorro y Crédito FUCEREP':
    'Cooperativa de Ahorro y Crédito FUCEREP',
  // Case-only merges (approved)
  'Banco de la República Oriental del Uruguay':
    'Banco de la República Oriental del Uruguay',
  'BANCO DE LA REPÚBLICA ORIENTAL DEL URUGUAY':
    'Banco de la República Oriental del Uruguay',
  'Administradora de Soluciones Integrales S.A.':
    'Administradora de Soluciones Integrales S.A.',
  'ADMINISTRADORA DE SOLUCIONES INTEGRALES S.A.':
    'Administradora de Soluciones Integrales S.A.',
  // Punctual human decision (not a general SA rule)
  'Banco Itaú Uruguay SA': 'Banco Itaú Uruguay S.A.',
});

function canonicalizeInstitutionName(rawName) {
  if (rawName == null || String(rawName).trim() === '') {
    return {
      status: MAP_STATUS.UNMAPPED,
      raw_name: rawName == null ? null : String(rawName),
      canonical_name: null,
      reason: 'EMPTY_RAW',
    };
  }
  const raw = String(rawName);
  if (Object.prototype.hasOwnProperty.call(APPROVED_RAW_TO_CANONICAL, raw)) {
    return {
      status: MAP_STATUS.MAPPED,
      raw_name: raw,
      canonical_name: APPROVED_RAW_TO_CANONICAL[raw],
      reason: 'APPROVED_MAP',
    };
  }
  return {
    status: MAP_STATUS.UNMAPPED,
    raw_name: raw,
    canonical_name: null,
    reason: 'REVIEW_NEEDED',
  };
}

/**
 * Membership V2: any of moroso/castigado/colocacion_vencida MN|ME strictly > 0.
 * NULL ≠ 0. Does not sum MN+ME. Ignores category, vigente, and reestructurado.
 */
function isBagMember(row) {
  return (
    isPositiveAmount(row && row.moroso_mn) ||
    isPositiveAmount(row && row.moroso_me) ||
    isPositiveAmount(row && row.castigado_mn) ||
    isPositiveAmount(row && row.castigado_me) ||
    isPositiveAmount(row && row.colocacion_vencida_mn) ||
    isPositiveAmount(row && row.colocacion_vencida_me)
  );
}

function isPositiveAmount(v) {
  if (v == null || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function hasPositiveReestructurado(row) {
  return (
    isPositiveAmount(row && row.creditos_reestructurados_mn) ||
    isPositiveAmount(row && row.creditos_reestructurados_me) ||
    isPositiveAmount(row && row.reestructurado_mn) ||
    isPositiveAmount(row && row.reestructurado_me)
  );
}

function reestructuradoSides(row) {
  const mn =
    row.creditos_reestructurados_mn != null
      ? row.creditos_reestructurados_mn
      : row.reestructurado_mn;
  const me =
    row.creditos_reestructurados_me != null
      ? row.creditos_reestructurados_me
      : row.reestructurado_me;
  return { mn: mn != null ? Number(mn) : null, me: me != null ? Number(me) : null };
}

/**
 * Select current snapshot per CI using Rechazados ordering.
 * @param {object[]} snapshots
 * @returns {Map<number, object>} ci → snapshot
 */
function selectCurrentSnapshotsByCi(snapshots) {
  const byCi = new Map();
  (snapshots || []).forEach(function (s) {
    const ci = Number(s && s.ci);
    if (!Number.isFinite(ci)) return;
    if (!byCi.has(ci)) byCi.set(ci, []);
    byCi.get(ci).push(s);
  });
  const current = new Map();
  byCi.forEach(function (list, ci) {
    const sorted = sortSnapshotsDesc(list);
    if (sorted.length) current.set(ci, sorted[0]);
  });
  return current;
}

function indexInstitutionsBySnapshotId(institutions) {
  const map = new Map();
  (institutions || []).forEach(function (row) {
    const id = row && row.snapshot_id;
    if (id == null) return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  });
  return map;
}

function sumNonNull(acc, v) {
  if (v == null || v === '') return acc;
  const n = Number(v);
  if (!Number.isFinite(n)) return acc;
  return acc + n;
}

/**
 * Build read-only Mi Deuda bag model from snapshots + institutions.
 *
 * @param {{ snapshots: object[], institutions: object[] }} input
 */
function buildMiDeudaBagModel(input) {
  const snapshots = (input && input.snapshots) || [];
  const institutions = (input && input.institutions) || [];
  const currentByCi = selectCurrentSnapshotsByCi(snapshots);
  const instBySnap = indexInstitutionsBySnapshotId(institutions);

  const currentSnapshotIds = new Set();
  currentByCi.forEach(function (snap) {
    currentSnapshotIds.add(snap.id);
  });

  // Guard: only rows whose snapshot_id is a selected current snapshot.
  const personaInstitutionRows = [];
  currentByCi.forEach(function (snap, ci) {
    const rows = instBySnap.get(snap.id) || [];
    rows.forEach(function (row) {
      if (!currentSnapshotIds.has(row.snapshot_id)) return;
      const mapped = canonicalizeInstitutionName(row.institution_name);
      const member = isBagMember(row);
      const reest = reestructuradoSides(row);
      personaInstitutionRows.push({
        ci: ci,
        snapshot_id: snap.id,
        raw_name: row.institution_name,
        category: row.category != null ? String(row.category) : null,
        map_status: mapped.status,
        map_reason: mapped.reason,
        canonical_name: mapped.canonical_name,
        is_member: member,
        moroso_mn: row.moroso_mn != null ? Number(row.moroso_mn) : null,
        moroso_me: row.moroso_me != null ? Number(row.moroso_me) : null,
        castigado_mn: row.castigado_mn != null ? Number(row.castigado_mn) : null,
        castigado_me: row.castigado_me != null ? Number(row.castigado_me) : null,
        colocacion_vencida_mn:
          row.colocacion_vencida_mn != null
            ? Number(row.colocacion_vencida_mn)
            : null,
        colocacion_vencida_me:
          row.colocacion_vencida_me != null
            ? Number(row.colocacion_vencida_me)
            : null,
        reestructurado_mn: reest.mn,
        reestructurado_me: reest.me,
        has_reestructurado: hasPositiveReestructurado(row),
      });
    });
  });

  // Detect ambiguous consolidations: same CI + same canonical from >1 mapped raw rows
  const groupKeyCounts = new Map();
  personaInstitutionRows.forEach(function (r) {
    if (r.map_status !== MAP_STATUS.MAPPED || !r.canonical_name) return;
    const k = r.ci + '\0' + r.canonical_name;
    if (!groupKeyCounts.has(k)) groupKeyCounts.set(k, []);
    groupKeyCounts.get(k).push(r);
  });

  const ambiguousKeys = new Set();
  const ambiguousCases = [];
  groupKeyCounts.forEach(function (rows, k) {
    if (rows.length > 1) {
      ambiguousKeys.add(k);
      ambiguousCases.push({
        flag: BAG_EXCLUSION.AMBIGUOUS_CONSOLIDATION,
        ci: rows[0].ci,
        canonical_name: rows[0].canonical_name,
        raw_rows: rows.map(function (r) {
          return {
            raw_name: r.raw_name,
            category: r.category,
            moroso_mn: r.moroso_mn,
            moroso_me: r.moroso_me,
            castigado_mn: r.castigado_mn,
            castigado_me: r.castigado_me,
            colocacion_vencida_mn: r.colocacion_vencida_mn,
            colocacion_vencida_me: r.colocacion_vencida_me,
            reestructurado_mn: r.reestructurado_mn,
            reestructurado_me: r.reestructurado_me,
          };
        }),
      });
    }
  });

  const unmappedRows = personaInstitutionRows.filter(function (r) {
    return r.map_status !== MAP_STATUS.MAPPED;
  });

  // Bag members eligible for aggregate
  const bagMemberRows = [];
  personaInstitutionRows.forEach(function (r) {
    if (!r.is_member) return;
    if (r.map_status !== MAP_STATUS.MAPPED) return;
    const k = r.ci + '\0' + r.canonical_name;
    if (ambiguousKeys.has(k)) return;
    bagMemberRows.push(r);
  });

  const bagsMap = new Map();
  bagMemberRows.forEach(function (r) {
    if (!bagsMap.has(r.canonical_name)) {
      bagsMap.set(r.canonical_name, {
        institution_canonical: r.canonical_name,
        people: new Set(),
        moroso_mn: 0,
        moroso_me: 0,
        castigado_mn: 0,
        castigado_me: 0,
        colocacion_vencida_mn: 0,
        colocacion_vencida_me: 0,
        reestructurado_mn: 0,
        reestructurado_me: 0,
        members: [],
      });
    }
    const b = bagsMap.get(r.canonical_name);
    b.people.add(r.ci);
    b.moroso_mn = sumNonNull(b.moroso_mn, r.moroso_mn);
    b.moroso_me = sumNonNull(b.moroso_me, r.moroso_me);
    b.castigado_mn = sumNonNull(b.castigado_mn, r.castigado_mn);
    b.castigado_me = sumNonNull(b.castigado_me, r.castigado_me);
    b.colocacion_vencida_mn = sumNonNull(
      b.colocacion_vencida_mn,
      r.colocacion_vencida_mn,
    );
    b.colocacion_vencida_me = sumNonNull(
      b.colocacion_vencida_me,
      r.colocacion_vencida_me,
    );
    b.reestructurado_mn = sumNonNull(b.reestructurado_mn, r.reestructurado_mn);
    b.reestructurado_me = sumNonNull(b.reestructurado_me, r.reestructurado_me);
    b.members.push({
      ci: r.ci,
      raw_name: r.raw_name,
      category: r.category,
      moroso_mn: r.moroso_mn,
      moroso_me: r.moroso_me,
      castigado_mn: r.castigado_mn,
      castigado_me: r.castigado_me,
      colocacion_vencida_mn: r.colocacion_vencida_mn,
      colocacion_vencida_me: r.colocacion_vencida_me,
      reestructurado_mn: r.reestructurado_mn,
      reestructurado_me: r.reestructurado_me,
    });
  });

  const bags = Array.from(bagsMap.values())
    .map(function (b) {
      return {
        institution_canonical: b.institution_canonical,
        people_count: b.people.size,
        moroso_mn: b.moroso_mn,
        moroso_me: b.moroso_me,
        castigado_mn: b.castigado_mn,
        castigado_me: b.castigado_me,
        colocacion_vencida_mn: b.colocacion_vencida_mn,
        colocacion_vencida_me: b.colocacion_vencida_me,
        reestructurado_mn: b.reestructurado_mn,
        reestructurado_me: b.reestructurado_me,
        members: b.members,
      };
    })
    .sort(function (a, b) {
      return (
        b.people_count - a.people_count ||
        a.institution_canonical.localeCompare(b.institution_canonical)
      );
    });

  const reestructuradoUniverse = personaInstitutionRows
    .filter(function (r) {
      return r.has_reestructurado;
    })
    .map(function (r) {
      const k = r.ci + '\0' + (r.canonical_name || '');
      const ambiguous = r.map_status === MAP_STATUS.MAPPED && ambiguousKeys.has(k);
      return {
        ci: r.ci,
        raw_name: r.raw_name,
        canonical_name: r.canonical_name,
        map_status: r.map_status,
        category: r.category,
        reestructurado_mn: r.reestructurado_mn,
        reestructurado_me: r.reestructurado_me,
        also_bag_member: r.is_member === true,
        ambiguous_consolidation: ambiguous,
      };
    });

  return {
    current_snapshots_by_ci: currentByCi,
    current_snapshot_ids: Array.from(currentSnapshotIds),
    persona_institution_rows: personaInstitutionRows,
    counts: {
      persona_x_institution_raw: personaInstitutionRows.length,
      membership_true: personaInstitutionRows.filter(function (r) {
        return r.is_member;
      }).length,
      membership_false: personaInstitutionRows.filter(function (r) {
        return !r.is_member;
      }).length,
      bag_members_after_exclusions: bagMemberRows.length,
      ambiguous_consolidation: ambiguousCases.length,
      unmapped: unmappedRows.length,
    },
    ambiguous_cases: ambiguousCases,
    unmapped_rows: unmappedRows,
    bags: bags,
    reestructurado_universe: reestructuradoUniverse,
  };
}

module.exports = {
  MAP_STATUS,
  BAG_EXCLUSION,
  APPROVED_RAW_TO_CANONICAL,
  canonicalizeInstitutionName,
  isBagMember,
  isPositiveAmount,
  hasPositiveReestructurado,
  selectCurrentSnapshotsByCi,
  buildMiDeudaBagModel,
  sortSnapshotsDesc,
};
