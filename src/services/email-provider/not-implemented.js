const { NOT_CONFIGURED_MESSAGE } = require('./interface');

/**
 * Stub adapter used when EMAIL_PROVIDER_MODE is unset / unknown.
 * @implements {import('./interface').EmailProvider}
 */
class NotImplementedEmailProvider {
  async send() {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
}

module.exports = { NotImplementedEmailProvider };
