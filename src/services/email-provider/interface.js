/**
 * EmailProvider — domain contract for sending transactional/campaign emails.
 *
 * @typedef {object} EmailSendResult
 * @property {string} providerId
 * @property {string} providerMessageId
 *
 * @typedef {object} EmailProvider
 * @property {(args: { to: string, subject: string, html: string, from: string }) => Promise<EmailSendResult>} send
 */

const NOT_CONFIGURED_MESSAGE =
  'EmailProvider not configured — pending connection method decision';

function isNotConfiguredError(err) {
  return !!(
    err &&
    err.message &&
    err.message.includes('EmailProvider not configured')
  );
}

module.exports = {
  NOT_CONFIGURED_MESSAGE,
  isNotConfiguredError,
};
