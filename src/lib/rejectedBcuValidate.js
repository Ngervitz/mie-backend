'use strict';

/**
 * Pure validation for POST /rechazados/:ci/bcu-snapshots.
 * No I/O.
 */

const { BCU_CATEGORIES } = require('./rejectedOps');

const PERIOD_LABEL_MAX = 100;
const INSTITUTION_NAME_MAX = 200;
const BALANCE_KEYS = Object.freeze([
  'vigente_mn',
  'vigente_me',
  'moroso_mn',
  'moroso_me',
  'castigado_mn',
  'castigado_me',
  'contingencias_mn',
  'contingencias_me',
]);

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isValidCalendarDate(raw) {
  if (typeof raw !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function parsePeriodLabel(raw) {
  if (raw == null || typeof raw !== 'string') {
    throw httpError(400, 'period_label inválido');
  }
  const s = raw.trim();
  if (!s) throw httpError(400, 'period_label inválido');
  if (s.length > PERIOD_LABEL_MAX) throw httpError(400, 'period_label inválido');
  return s;
}

function parseConsultedOnInput(raw) {
  if (raw == null || typeof raw !== 'string') {
    throw httpError(400, 'consulted_on inválido');
  }
  const s = raw.trim();
  if (!isValidCalendarDate(s)) {
    throw httpError(400, 'consulted_on inválido');
  }
  return s;
}

function parseInstitutionsInput(raw) {
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) throw httpError(400, 'institutions inválido');
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw httpError(400, 'institutions inválido');
    }
  }
  if (!Array.isArray(value)) {
    throw httpError(400, 'institutions inválido');
  }
  if (!value.length) {
    throw httpError(400, 'institutions inválido');
  }
  return value.map(function (item, index) {
    return parseInstitution(item, index);
  });
}

function parseInstitution(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw httpError(400, 'institutions inválido');
  }
  const name = parseInstitutionName(item.institution_name);
  const category = parseCategory(item.category);
  const balances = {};
  for (let i = 0; i < BALANCE_KEYS.length; i += 1) {
    const key = BALANCE_KEYS[i];
    balances[key] = parseBalance(item[key]);
  }
  return Object.assign(
    {
      institution_name: name,
      category: category,
      sort_order: index,
    },
    balances,
  );
}

function parseInstitutionName(raw) {
  if (raw == null || typeof raw !== 'string') {
    throw httpError(400, 'institution_name inválido');
  }
  const s = raw.trim();
  if (!s || s.length > INSTITUTION_NAME_MAX) {
    throw httpError(400, 'institution_name inválido');
  }
  return s;
}

function parseCategory(raw) {
  if (raw == null) throw httpError(400, 'category inválida');
  const s = String(raw).trim();
  if (!BCU_CATEGORIES.includes(s)) {
    throw httpError(400, 'category inválida');
  }
  return s;
}

/**
 * Missing/empty → 0. Accept integers and decimal strings.
 * Reject NaN, Infinity, negatives, scientific notation, booleans, objects.
 */
function parseBalance(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'boolean') {
    throw httpError(400, 'saldo inválido');
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw httpError(400, 'saldo inválido');
    }
    return raw;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '') return 0;
    if (!/^\d+(\.\d+)?$/.test(s)) {
      throw httpError(400, 'saldo inválido');
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) {
      throw httpError(400, 'saldo inválido');
    }
    return n;
  }
  throw httpError(400, 'saldo inválido');
}

function parseCreatedBy(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  ) {
    return null;
  }
  return s;
}

function parseSnapshotPayload(body) {
  const source = body && typeof body === 'object' ? body : {};
  return {
    period_label: parsePeriodLabel(source.period_label),
    consulted_on: parseConsultedOnInput(source.consulted_on),
    institutions: parseInstitutionsInput(source.institutions),
  };
}

module.exports = {
  PERIOD_LABEL_MAX,
  INSTITUTION_NAME_MAX,
  BALANCE_KEYS,
  httpError,
  isValidCalendarDate,
  parsePeriodLabel,
  parseConsultedOnInput,
  parseInstitutionsInput,
  parseBalance,
  parseCategory,
  parseCreatedBy,
  parseSnapshotPayload,
};
