const { NOT_CONFIGURED_MESSAGE } = require('./interface');

/**
 * Stub adapter used when CZ_SOURCE_MODE is unset / unknown,
 * or when a concrete adapter lacks credentials.
 * @implements {import('./interface').CZLeadSource}
 */
class NotImplementedCZLeadSource {
  async fetchGrantedLoans() {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }

  async fetchSolicitudes() {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
}

module.exports = { NotImplementedCZLeadSource };
