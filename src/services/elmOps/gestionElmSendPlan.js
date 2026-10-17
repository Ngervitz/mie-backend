'use strict';

/**
 * Pure plan for Gestión ELM «Enviar a ELM»: which path applies and what the operator must confirm.
 * No I/O, no ELM calls.
 */

const { S1, S2, CODES } = require('../elm/constants');
const { HOLD } = require('../../lib/rejectedElmResendGuard');
const {
  S1_SUBCLASS,
  classifyS1Unknown,
  existingRetryApplies,
  isS1UnknownLike,
} = require('./s1UnknownClassify');

const SEND_MODES = Object.freeze({
  FULL: 'full',
  RESUME_S2: 'resume_s2',
  RETRY_S1: 'retry_s1',
  RETRY_S2: 'retry_s2',
  ADMIN_PROVIDER_RESEND: 'admin_provider_resend',
});

const BLOCK_CODES = Object.freeze({
  RECONCILE: 'gestion_send_reconcile_required',
  DEFINITIVE: 'gestion_send_use_close_reject',
  UNCERTAIN: 'gestion_send_uncertain',
  FULL_RESEND: 'elm_gestion_full_resend_unavailable',
  MISSING_FIELDS: CODES.MISSING_REQUIRED_FIELDS,
  MOBILE: CODES.MOBILEPHONE_NEEDS_CORRECTION,
  NOT_READY: 'elm_send_not_ready',
});

function lastSendAt(process) {
  if (!process) return null;
  const candidates = [
    process.s2_completed_at,
    process.s2_started_at,
    process.s1_started_at,
    process.created_at,
  ];
  let best = null;
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    const t = Date.parse(String(raw));
    if (Number.isFinite(t) && (best == null || t > best.ms)) best = { ms: t, iso: String(raw) };
  }
  return best ? best.iso : null;
}

function holdBypassable(hold, opts) {
  if (!hold || !hold.reason) return true;
  const o = opts || {};
  if (o.gestionAuthorized !== true) return false;
  return hold.reason === HOLD.RECENT_SEND || hold.reason === HOLD.MONTHLY_QUOTA;
}

/**
 * @param {{
 *   czId: number,
 *   ci: number|null,
 *   process: object|null,
 *   bag: object,
 *   readiness: { ready: boolean, reasons?: string[] },
 *   hold: object|null,
 *   eligibility: { eligible: boolean, blockers?: object[] },
 *   gestionAuthorized?: boolean,
 *   retrySafeS2?: boolean,
 *   s2ExpectedAttempts?: number|null,
 * }} input
 */
function planGestionSend(input) {
  const src = input || {};
  const czId = Number(src.czId);
  const process = src.process || null;
  const bag = src.bag || {};
  const warnings = [];
  const duplicateWarning =
    'ELM puede tratar este envío como duplicado si la misma persona recibió otro lead recientemente. ' +
    'Confirme solo si ELM autorizó el reenvío.';

  if (!src.readiness || src.readiness.ready !== true) {
    return {
      can_send: false,
      code: BLOCK_CODES.NOT_READY,
      reasons: (src.readiness && src.readiness.reasons) || [],
    };
  }

  if (isS1UnknownLike(bag)) {
    const subclass = classifyS1Unknown(bag);
    if (subclass === S1_SUBCLASS.UNCERTAIN) {
      return { can_send: false, code: BLOCK_CODES.RECONCILE, subclass: subclass };
    }
    if (subclass === S1_SUBCLASS.DEFINITIVE_REJECT) {
      return { can_send: false, code: BLOCK_CODES.DEFINITIVE, subclass: subclass };
    }
  }

  const hold = src.hold || null;
  if (hold && !holdBypassable(hold, { gestionAuthorized: src.gestionAuthorized === true })) {
    return {
      can_send: false,
      code: hold.reason,
      hold: hold,
      warnings: [duplicateWarning],
    };
  }
  if (hold && holdBypassable(hold, { gestionAuthorized: src.gestionAuthorized === true })) {
    warnings.push(duplicateWarning);
  }

  const elig = src.eligibility || { eligible: false, blockers: [] };
  const s1 = process && process.s1_status ? process.s1_status : null;
  const s2 = process && process.s2_status ? process.s2_status : null;

  if (!process) {
    if (!elig.eligible) {
      const b = (elig.blockers && elig.blockers[0]) || { code: CODES.SOLICITUD_NOT_FOUND };
      return {
        can_send: false,
        code: b.code,
        fields: b.fields || null,
        blockers: elig.blockers || [],
      };
    }
    return {
      can_send: true,
      mode: SEND_MODES.FULL,
      steps: ['s1', 's2'],
      s1_status: 'not_started',
      s2_status: 'not_started',
      last_send_at: null,
      warnings: warnings,
      duplicate_warning: duplicateWarning,
      expected_attempts: null,
    };
  }

  if (s1 === S1.ELIGIBLE && (s2 === S2.NOT_STARTED || !s2)) {
    const blockers = (elig.blockers || []).filter(function (b) {
      return b.code !== CODES.PROCESS_EXISTS;
    });
    if (blockers.length) {
      const b = blockers[0];
      return { can_send: false, code: b.code, fields: b.fields || null, blockers: blockers };
    }
    return {
      can_send: true,
      mode: SEND_MODES.RESUME_S2,
      steps: ['s2'],
      s1_status: s1,
      s2_status: s2 || S2.NOT_STARTED,
      last_send_at: lastSendAt(process),
      warnings: warnings,
      duplicate_warning: duplicateWarning,
      expected_attempts: null,
      process_id: process.id,
    };
  }

  if (existingRetryApplies(bag)) {
    const attempts = Number(process.s1_attempts);
    if (!Number.isInteger(attempts) || attempts < 1) {
      return { can_send: false, code: CODES.INVALID_CONTEXT };
    }
    return {
      can_send: true,
      mode: SEND_MODES.RETRY_S1,
      steps: ['s1', 's2'],
      s1_status: s1,
      s2_status: s2,
      last_send_at: lastSendAt(process),
      warnings: warnings,
      duplicate_warning: duplicateWarning,
      expected_attempts: attempts,
      process_id: process.id,
    };
  }

  if (
    s1 === S1.ELIGIBLE &&
    s2 === S2.TECHNICAL_ERROR &&
    src.retrySafeS2 === true &&
    src.s2ExpectedAttempts != null
  ) {
    return {
      can_send: true,
      mode: SEND_MODES.RETRY_S2,
      steps: ['s2'],
      s1_status: s1,
      s2_status: s2,
      last_send_at: lastSendAt(process),
      warnings: warnings,
      duplicate_warning: duplicateWarning,
      expected_attempts: Number(src.s2ExpectedAttempts),
      process_id: process.id,
    };
  }

  if (s1 === S1.IN_FLIGHT || s2 === S2.IN_FLIGHT) {
    return {
      can_send: false,
      code: CODES.ADMIN_PROVIDER_RESEND_NOT_ALLOWED,
      reason: 'in_flight',
      warnings: warnings,
    };
  }
  const blockers = (elig.blockers || []).filter(function (b) {
    return b.code !== CODES.PROCESS_EXISTS;
  });
  if (blockers.length) {
    const b = blockers[0];
    return { can_send: false, code: b.code, fields: b.fields || null, blockers: blockers };
  }
  warnings.push(
    'Reenvío completo autorizado por ELM: se archiva el ciclo anterior en el mismo proceso ' +
    'y se reserva un único cupo CI antes de S1+S2. Requiere referencia ELM al confirmar.',
  );
  return {
    can_send: true,
    mode: SEND_MODES.ADMIN_PROVIDER_RESEND,
    steps: ['s1', 's2'],
    s1_status: s1,
    s2_status: s2,
    last_send_at: lastSendAt(process),
    warnings: warnings,
    duplicate_warning: duplicateWarning,
    expected_updated_at: process.updated_at || null,
    requires_provider_reference: true,
    process_id: process.id,
  };
}

/** Gestión row: no send button (use close / retry / reconcile instead). */
const SEND_ROW_HIDDEN_CODES = new Set([
  BLOCK_CODES.RECONCILE,
  BLOCK_CODES.DEFINITIVE,
  BLOCK_CODES.UNCERTAIN,
]);

/**
 * Row action for «Enviar a ELM»: enabled when send is allowed; disabled when preview-only (blocked).
 * @returns {object|null}
 */
function sendRowActionFromPlan(plan) {
  const p = plan && plan.can_send != null ? plan : plan && plan.plan;
  if (!p || typeof p !== 'object') return null;
  if (SEND_ROW_HIDDEN_CODES.has(p.code)) return null;
  if (p.can_send === true) {
    const act = sendActionFromPlan(p);
    return act ? Object.assign({ enabled: true }, act) : null;
  }
  if (!p.code && !p.hold) return null;
  return {
    id: 'send_elm',
    label: 'Enviar a ELM',
    enabled: false,
    block_code: p.code || (p.hold && p.hold.reason) || null,
    explanation: 'Ver confirmación: este envío está bloqueado hasta resolver el motivo indicado.',
    mode: p.mode || null,
    s1_status: p.s1_status || null,
    s2_status: p.s2_status || null,
  };
}

function sendActionFromPlan(plan) {
  const p = plan && plan.can_send != null ? plan : plan && plan.plan;
  if (!p || p.can_send !== true) return null;
  plan = p;
  return {
    id: 'send_elm',
    label: 'Enviar a ELM',
    enabled: true,
    explanation:
      plan.mode === SEND_MODES.RESUME_S2
        ? 'Completa el paso 2 con el celular y datos actuales del funnel.'
        : plan.mode === SEND_MODES.RETRY_S1
          ? 'Reintenta el paso 1 (ELM no recibió el lead) y continúa con paso 2 si corresponde.'
          : plan.mode === SEND_MODES.RETRY_S2
            ? 'Reintenta el paso 2 técnico con el payload congelado.'
            : plan.mode === SEND_MODES.ADMIN_PROVIDER_RESEND
              ? 'Reenvío completo S1+S2 autorizado por ELM (mismo proceso, historial archivado).'
              : 'Envía paso 1 y paso 2 a ELM (proceso nuevo).',
    requires_confirm: true,
    mode: plan.mode,
    expected_attempts: plan.expected_attempts,
    duplicate_warning: plan.duplicate_warning,
    last_send_at: plan.last_send_at,
    s1_status: plan.s1_status,
    s2_status: plan.s2_status,
  };
}

module.exports = {
  SEND_MODES,
  BLOCK_CODES,
  planGestionSend,
  sendActionFromPlan,
  sendRowActionFromPlan,
  lastSendAt,
  holdBypassable,
};
