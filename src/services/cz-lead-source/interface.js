/**
 * CZLeadSource — domain contract for Credizona lead data.
 *
 * The sync job depends ONLY on this contract. It must not know whether
 * data comes from a PHP API, MySQL, or a future adapter.
 *
 * @typedef {object} CZGrantedLoanItem
 * @property {string} cdv_operation_id  LRW / CDV operation id (required; never fabricate from solicitud id)
 * @property {number|string} loan_amount
 * @property {string} granted_at        ISO-8601 timestamptz
 * @property {number} solicitudes_id    Credizona solicitudes.id
 *
 * @typedef {object} CZSolicitudItem
 * @property {number} id
 * @property {number|null} [solicitudes_estados_id]
 * @property {number|null} [usuarios_id]
 * @property {string|null} [fechaReg]   ISO-8601
 * @property {string|null} [lrw_id]
 * @property {object|null} [tracking_data]
 *
 * @typedef {object} CZFetchPage
 * @property {Array} items
 * @property {boolean} hasMore   true when a full PAGE_SIZE page was returned
 * @property {string|null} nextSince  ISO-8601 cursor for the next page (date field of last raw row)
 *
 * @typedef {object} CZLeadSource
 * @property {(args: { since: string|null }) => Promise<CZFetchPage>} fetchGrantedLoans
 * @property {(args: { since: string|null }) => Promise<CZFetchPage>} fetchSolicitudes
 *
 * Contract notes:
 * - `since` is always ISO-8601 (e.g. "2026-08-01T10:00:00Z") or null.
 *   null → adapter uses its default initial window (90 days ago).
 *   Each adapter converts `since` to whatever its driver needs.
 * - Each call returns at most PAGE_SIZE items, ordered ascending by the
 *   relevant date field. nextSince = that field on the last item of the
 *   underlying page (so cursors advance even if some rows are skipped).
 */

const PAGE_SIZE = 500;
const MAX_PAGES_PER_RUN = 20;
const DEFAULT_LOOKBACK_DAYS = 90;

const NOT_CONFIGURED_MESSAGE =
  'CZLeadSource not configured — pending connection method decision';

/**
 * Default since when cursor / caller pass null: now - 90 days (UTC ISO).
 * @returns {string}
 */
function defaultSinceIso() {
  const ms = Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNotConfiguredError(err) {
  return Boolean(
    err &&
      typeof err.message === 'string' &&
      err.message.includes('CZLeadSource not configured'),
  );
}

module.exports = {
  PAGE_SIZE,
  MAX_PAGES_PER_RUN,
  DEFAULT_LOOKBACK_DAYS,
  NOT_CONFIGURED_MESSAGE,
  defaultSinceIso,
  isNotConfiguredError,
};
