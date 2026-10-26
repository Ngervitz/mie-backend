'use strict';

/**
 * Server-side affiliate public codes for GET /a/:code.
 */

const crypto = require('crypto');
const { CODE_RE } = require('./affiliateRedirect');

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_LEN = 10;
const MAX_GENERATION_ATTEMPTS = 8;

function generateAffiliateCode(len) {
  const n = len == null ? DEFAULT_LEN : Number(len);
  const size = Number.isFinite(n) && n >= 4 && n <= 32 ? Math.floor(n) : DEFAULT_LEN;
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += CHARSET[crypto.randomInt(0, CHARSET.length)];
  }
  if (!CODE_RE.test(out)) {
    throw new Error('generated affiliate code failed format check');
  }
  return out;
}

module.exports = {
  CHARSET,
  DEFAULT_LEN,
  MAX_GENERATION_ATTEMPTS,
  generateAffiliateCode,
};
