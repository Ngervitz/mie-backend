'use strict';

/**
 * Single allowlist for email_campaign_recipients.purpose.
 * Do not duplicate purpose strings elsewhere — import from here.
 */

const EMAIL_PURPOSES = Object.freeze({
  RECHAZADOS_SURVEY_INVITE: 'rechazados_survey_invite',
});

const EMAIL_PURPOSE_SET = new Set(Object.values(EMAIL_PURPOSES));

/**
 * @param {unknown} purpose
 * @returns {asserts purpose is string}
 */
function assertValidEmailPurpose(purpose) {
  if (purpose == null || purpose === '') {
    throw new Error('email purpose is required');
  }
  const s = String(purpose).trim();
  if (!EMAIL_PURPOSE_SET.has(s)) {
    throw new Error('invalid email purpose: ' + s);
  }
}

/**
 * @param {unknown} purpose
 * @returns {boolean}
 */
function isValidEmailPurpose(purpose) {
  if (purpose == null || purpose === '') return false;
  return EMAIL_PURPOSE_SET.has(String(purpose).trim());
}

module.exports = {
  EMAIL_PURPOSES,
  EMAIL_PURPOSE_SET,
  assertValidEmailPurpose,
  isValidEmailPurpose,
};
