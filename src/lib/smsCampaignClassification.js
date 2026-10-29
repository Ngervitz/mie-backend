'use strict';

/**
 * SMS campaign vertical + purpose taxonomy (aligned with email recipient purposes where sensible).
 * Email purposes live on email_campaign_recipients; SMS purposes on sms_campaigns.
 */

const SMS_VERTICALS = Object.freeze([
  'loans',
  'affiliates',
  'insurance',
  'ecommerce',
]);

const SMS_VERTICAL_SET = new Set(SMS_VERTICALS);

/** Default for legacy / loan reactivation campaigns. */
const SMS_DEFAULT_VERTICAL = 'loans';

const SMS_PURPOSES = Object.freeze({
  LOAN_REACTIVATION: 'loan_reactivation',
  AFFILIATE_PROGRAM_INVITE: 'affiliate_program_invite',
  /** Internal/engine SMS tests — spend counts, JT commercial metrics excluded. */
  TEST: 'test',
  /** Affiliate OTP/welcome and other non-marketing SMS buckets. */
  TRANSACTIONAL: 'transactional',
  /** @deprecated use TRANSACTIONAL — kept for parse compatibility only */
  AFFILIATE_OTP: 'affiliate_otp',
  INSURANCE_OUTREACH: 'insurance_outreach',
  ECOMMERCE_OUTREACH: 'ecommerce_outreach',
});

const SMS_PURPOSE_SET = new Set(Object.values(SMS_PURPOSES));

const SMS_DEFAULT_PURPOSE = SMS_PURPOSES.LOAN_REACTIVATION;

const SMS_VERTICAL_LABELS = Object.freeze({
  loans: 'Préstamos',
  affiliates: 'Afiliados',
  insurance: 'Seguros',
  ecommerce: 'E-commerce',
});

const SMS_PURPOSE_LABELS = Object.freeze({
  loan_reactivation: 'Reactivación préstamos',
  affiliate_program_invite: 'Invitación programa afiliados',
  test: 'Prueba motor SMS',
  transactional: 'Transaccional',
  affiliate_otp: 'Transaccional (OTP afiliados)',
  insurance_outreach: 'Seguros',
  ecommerce_outreach: 'E-commerce',
});

/**
 * @param {unknown} raw
 * @returns {{ ok: true, vertical: string }|{ ok: false, error: string }}
 */
function parseSmsVertical(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { ok: true, vertical: SMS_DEFAULT_VERTICAL };
  }
  const v = String(raw).trim().toLowerCase();
  if (!SMS_VERTICAL_SET.has(v)) {
    return { ok: false, error: 'invalid_sms_vertical:' + v };
  }
  return { ok: true, vertical: v };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, purpose: string }|{ ok: false, error: string }}
 */
function parseSmsPurpose(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { ok: true, purpose: SMS_DEFAULT_PURPOSE };
  }
  const p = String(raw).trim().toLowerCase();
  if (p === 'affiliate_otp') {
    return { ok: true, purpose: SMS_PURPOSES.TRANSACTIONAL };
  }
  if (!SMS_PURPOSE_SET.has(p)) {
    return { ok: false, error: 'invalid_sms_purpose:' + p };
  }
  return { ok: true, purpose: p };
}

/**
 * Resolve vertical + purpose for POST /sms/campaigns with defaults.
 * @param {{ vertical?: unknown, purpose?: unknown }} body
 */
function resolveSmsCampaignClassification(body) {
  const v = parseSmsVertical(body && body.vertical);
  if (!v.ok) return v;
  const p = parseSmsPurpose(body && body.purpose);
  if (!p.ok) return p;
  if (v.vertical === 'affiliates' && p.purpose === SMS_PURPOSES.LOAN_REACTIVATION) {
    return {
      ok: false,
      error: 'affiliates_vertical_requires_non_loan_purpose',
    };
  }
  if (v.vertical === 'loans' && p.purpose === SMS_PURPOSES.AFFILIATE_PROGRAM_INVITE) {
    return {
      ok: false,
      error: 'affiliate_invite_purpose_requires_affiliates_vertical',
    };
  }
  if (
    v.vertical !== 'affiliates' &&
    (p.purpose === SMS_PURPOSES.TRANSACTIONAL || p.purpose === SMS_PURPOSES.AFFILIATE_OTP)
  ) {
    return {
      ok: false,
      error: 'transactional_purpose_requires_affiliates_vertical',
    };
  }
  return { ok: true, vertical: v.vertical, purpose: p.purpose };
}

function labelSmsVertical(vertical) {
  const key = vertical == null ? '' : String(vertical);
  return SMS_VERTICAL_LABELS[key] || key || '—';
}

function labelSmsPurpose(purpose) {
  const key = purpose == null ? '' : String(purpose);
  return SMS_PURPOSE_LABELS[key] || key || '—';
}

module.exports = {
  SMS_VERTICALS,
  SMS_VERTICAL_SET,
  SMS_DEFAULT_VERTICAL,
  SMS_PURPOSES,
  SMS_PURPOSE_SET,
  SMS_DEFAULT_PURPOSE,
  SMS_VERTICAL_LABELS,
  SMS_PURPOSE_LABELS,
  parseSmsVertical,
  parseSmsPurpose,
  resolveSmsCampaignClassification,
  labelSmsVertical,
  labelSmsPurpose,
};
