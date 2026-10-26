'use strict';

/**
 * Pure rules for the affiliate directory.
 * Does not evaluate attribution. Reads stored outcomes only.
 */

const { CODE_RE } = require('./affiliateRedirect');

const CI_MAX = 999999999;
const CHANNELS = Object.freeze(['dashboard', 'presencial']);
const TERMS_RE = /^[A-Za-z0-9._-]{1,64}$/;
const EVIDENCE_MAX = 500;
const LIST_CAP = 200;

const EXCLUSION_OUTCOMES = Object.freeze([
  'excluded_prior_solicitud',
  'click_ci_conflict',
  'other_affiliate',
  'expired',
  'click_after_presentation',
  'ambiguous_fecha_reg',
  'blocked_ambiguous_history',
]);

const OUTCOME_LABELS = Object.freeze({
  attributed: 'Atribuida',
  no_click: 'Sin clic',
  unknown_click: 'Clic desconocido',
  unknown_affiliate: 'Afiliado desconocido',
  no_presentation_at: 'Sin presentation_at',
  no_occurred_at: 'Sin occurred_at',
  click_after_presentation: 'Clic posterior a la presentación',
  expired: 'Fuera de los 30 días',
  no_ci: 'Sin CI',
  click_ci_conflict: 'El clic aparece en otra CI',
  ambiguous_fecha_reg: 'fecha_reg no ordenable',
  blocked_ambiguous_history: 'Historial no ordenable',
  excluded_prior_solicitud: 'Hay una solicitud anterior',
  other_affiliate: 'Otra afiliación',
});

const EXCLUSION_SET = new Set(EXCLUSION_OUTCOMES);

function text(raw) {
  if (raw == null) return '';
  return String(raw).trim();
}

function parseCi(raw) {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    if (raw < 1 || raw > CI_MAX) return null;
    return raw;
  }
  const s = text(raw);
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > CI_MAX) return null;
  return n;
}

/**
 * Stored outcome → display. Missing row is pending, not an exclusion.
 * @param {unknown} outcome
 */
function describeOutcome(outcome) {
  if (outcome == null || outcome === '') {
    return {
      kind: 'pending',
      outcome: null,
      label: 'Sin evaluar',
      detail: 'Sin evaluar',
    };
  }
  const code = String(outcome);
  const label = OUTCOME_LABELS[code] || code;
  if (code === 'attributed') {
    return { kind: 'attributed', outcome: code, label: label, detail: 'REF' };
  }
  if (EXCLUSION_SET.has(code)) {
    return {
      kind: 'excluded',
      outcome: code,
      label: label,
      detail: 'REF · Excluido · ' + label,
    };
  }
  return { kind: 'recorded', outcome: code, label: label, detail: label };
}

/**
 * Compact cell for one person row. Counts attributed solicitudes in the
 * shown set only.
 * @param {{ isAffiliate: boolean, isTest: boolean, status: string|null, attributedCzIds: number[] }} input
 */
function listCell(input) {
  const ids = (input.attributedCzIds || [])
    .map(function (id) {
      return Number(id);
    })
    .filter(function (id) {
      return Number.isSafeInteger(id) && id > 0;
    })
    .sort(function (a, b) {
      return a - b;
    });
  const count = ids.length;
  const parts = [];
  if (input.isAffiliate) {
    if (input.isTest) {
      parts.push('AF: esta CI es un afiliado de prueba.');
    } else if (input.status === 'inactive') {
      parts.push('AF: esta CI es un afiliado inactivo.');
    } else {
      parts.push('AF: esta CI es un afiliado.');
    }
  }
  if (count === 0) {
    parts.push('Ninguna solicitud mostrada está atribuida.');
  } else if (count === 1) {
    parts.push('REF: la solicitud mostrada ' + ids[0] + ' está atribuida.');
  } else {
    parts.push(
      'REF ' + count + ': solicitudes atribuidas entre las mostradas: ' + ids.join(', ') + '.',
    );
  }
  parts.push('No marca al resto de solicitudes de la CI.');
  let ref = null;
  if (count === 1) ref = 'REF';
  else if (count > 1) ref = 'REF ' + count;
  return {
    is_affiliate: input.isAffiliate === true,
    is_test: input.isTest === true,
    status: input.status || null,
    attributed_count: count,
    attributed_cz_ids: ids,
    ref: ref,
    tooltip: parts.join(' '),
  };
}

function acceptanceFrom(body) {
  const channel = text(body && body.acceptance_channel);
  const terms = text(body && body.terms_version);
  const evidence = text(body && body.acceptance_evidence);
  if (!channel && !terms && !evidence) return { present: false };
  if (!CHANNELS.includes(channel)) {
    return { error: 'Canal de aceptación inválido' };
  }
  if (!TERMS_RE.test(terms)) {
    return { error: 'Versión de bases inválida' };
  }
  if (!evidence || evidence.length > EVIDENCE_MAX) {
    return { error: 'Falta la evidencia de aceptación' };
  }
  return {
    present: true,
    acceptance_channel: channel,
    terms_version: terms,
    acceptance_evidence: evidence,
  };
}

/**
 * Build an insert row. Real affiliates need a CI and full acceptance.
 * Test affiliates stay valid without either. This function does not check
 * that the CI exists in cz_funnel_solicitudes.
 * @param {object} body
 * @param {string} acceptedAt ISO timestamp from the server
 */
function planAffiliateInsert(body, acceptedAt) {
  const code = text(body && body.code);
  if (!CODE_RE.test(code)) {
    return { ok: false, error: 'Código inválido' };
  }
  const isTest = body && body.is_test === true;
  const ci = body && body.ci != null && text(body.ci) !== '' ? parseCi(body.ci) : null;
  if (body && body.ci != null && text(body.ci) !== '' && ci == null) {
    return { ok: false, error: 'CI inválida' };
  }
  const acceptance = acceptanceFrom(body);
  if (acceptance.error) return { ok: false, error: acceptance.error };

  if (!isTest) {
    if (ci == null) return { ok: false, error: 'La CI es obligatoria' };
    if (!acceptance.present) {
      return { ok: false, error: 'Falta la aceptación documentada' };
    }
  }

  const row = {
    code: code,
    status: 'active',
    is_test: isTest,
    ci: ci,
    accepted_at: null,
    acceptance_channel: null,
    terms_version: null,
    acceptance_evidence: null,
  };
  if (acceptance.present) {
    row.accepted_at = acceptedAt;
    row.acceptance_channel = acceptance.acceptance_channel;
    row.terms_version = acceptance.terms_version;
    row.acceptance_evidence = acceptance.acceptance_evidence;
  }
  return { ok: true, row: row };
}

function splitAttributions(rows) {
  const attributed = [];
  const excluded = [];
  const recorded = [];
  (rows || []).forEach(function (row) {
    const described = describeOutcome(row.outcome);
    const item = {
      cz_id: Number(row.cz_id),
      ci: row.ci == null ? null : Number(row.ci),
      outcome: described.outcome,
      label: described.label,
      detail: described.detail,
      presentation_at: row.presentation_at || null,
      evaluated_at: row.evaluated_at || null,
    };
    if (described.kind === 'attributed') attributed.push(item);
    else if (described.kind === 'excluded') excluded.push(item);
    else recorded.push(item);
  });
  return {
    attributed: attributed.slice(0, LIST_CAP),
    excluded: excluded.slice(0, LIST_CAP),
    recorded: recorded.slice(0, LIST_CAP),
    attributed_count: attributed.length,
    excluded_count: excluded.length,
    recorded_count: recorded.length,
  };
}

module.exports = {
  CI_MAX,
  CHANNELS,
  EXCLUSION_OUTCOMES,
  LIST_CAP,
  parseCi,
  describeOutcome,
  listCell,
  planAffiliateInsert,
  splitAttributions,
};
