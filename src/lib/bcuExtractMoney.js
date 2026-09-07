'use strict';

/**
 * Deterministic BCU money → integer cents (BigInt).
 * No float epsilon comparisons. No silent rounding past 2 decimal places.
 *
 * Origin-agnostic: works on any number|null from a bcu_v1-shaped payload.
 */

const { REASON } = require('./bcuExtractContract');

/**
 * @typedef {{ ok: true, cents: bigint }} MoneyCentsOk
 * @typedef {{ ok: false, reason: string }} MoneyCentsErr
 * @typedef {MoneyCentsOk | MoneyCentsErr} MoneyCentsResult
 */

/**
 * Convert a non-null monetary amount to integer cents via decimal string + BigInt.
 * Rejects >2 fractional digits (no silent round).
 *
 * @param {unknown} value
 * @returns {MoneyCentsResult}
 */
function moneyToCents(value) {
  if (value === null) {
    return { ok: false, reason: REASON.AMOUNT_UNSUPPORTED_TYPE };
  }
  if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'object') {
    return { ok: false, reason: REASON.AMOUNT_UNSUPPORTED_TYPE };
  }
  if (typeof value !== 'number') {
    return { ok: false, reason: REASON.AMOUNT_UNSUPPORTED_TYPE };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, reason: REASON.AMOUNT_NOT_FINITE };
  }
  if (value < 0) {
    return { ok: false, reason: REASON.AMOUNT_NEGATIVE };
  }

  // Canonical decimal string without scientific notation.
  const raw = Object.is(value, -0) ? '0' : String(value);
  if (/[eE]/.test(raw)) {
    return { ok: false, reason: REASON.AMOUNT_PRECISION_INVALID };
  }

  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!m) {
    return { ok: false, reason: REASON.AMOUNT_PRECISION_INVALID };
  }

  const whole = m[1];
  const frac = m[2] || '';
  if (frac.length > 2) {
    return { ok: false, reason: REASON.AMOUNT_PRECISION_INVALID };
  }

  const frac2 = (frac + '00').slice(0, 2);
  try {
    const cents = BigInt(whole) * 100n + BigInt(frac2);
    return { ok: true, cents: cents };
  } catch (_e) {
    return { ok: false, reason: REASON.AMOUNT_PRECISION_INVALID };
  }
}

/**
 * null → { kind: 'null' }; numeric → cents or error.
 * @param {unknown} value
 * @returns {{ kind: 'null' } | { kind: 'cents', cents: bigint } | { kind: 'error', reason: string }}
 */
function moneySlot(value) {
  if (value === null || value === undefined) {
    return { kind: 'null' };
  }
  const r = moneyToCents(value);
  if (!r.ok) {
    return { kind: 'error', reason: r.reason };
  }
  return { kind: 'cents', cents: r.cents };
}

/**
 * @param {{ mn?: unknown, me?: unknown }|null|undefined} pair
 */
function moneyPairSlots(pair) {
  const p = pair && typeof pair === 'object' ? pair : { mn: null, me: null };
  return {
    mn: moneySlot(p.mn),
    me: moneySlot(p.me),
  };
}

module.exports = {
  moneyToCents,
  moneySlot,
  moneyPairSlots,
};
