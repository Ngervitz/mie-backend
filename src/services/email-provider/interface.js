/**
 * EmailProvider — domain contract for sending transactional/campaign emails.
 *
 * @typedef {object} EmailSendResult
 * @property {string} providerId
 * @property {string} providerMessageId
 *
 * @typedef {object} EmailSendArgs
 * @property {string} to
 * @property {string} subject
 * @property {string} html
 * @property {string} from
 * @property {string} [idempotencyKey] optional stable provider identity for safe retries
 *
 * @typedef {object} EmailProvider
 * @property {(args: EmailSendArgs) => Promise<EmailSendResult>} send
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
