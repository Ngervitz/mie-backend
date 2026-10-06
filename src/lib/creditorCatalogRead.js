'use strict';

/**
 * Mi Deuda — load the canonical creditor catalog once and build the in-memory resolver.
 * Any read error or integrity problem → CreditorCatalogLoadError (callers fail closed;
 * there is no fallback to the legacy map).
 */

const { buildCreditorResolver } = require('./creditorCatalog');

const PAGE_SIZE = 1000;

const CREDITOR_SELECT = 'creditor_id, slug, display_name, status, merged_into_creditor_id';
const ALIAS_SELECT = 'id, source, normalized_key, creditor_id, status';

class CreditorCatalogLoadError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CreditorCatalogLoadError';
    this.code = 'CREDITOR_CATALOG_UNAVAILABLE';
    this.details = details || null;
  }
}

async function fetchAllPages(supabase, table, columns) {
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new CreditorCatalogLoadError(table + ' read failed', {
        table: table,
        cause_code: error.code || null,
        cause_message: error.message || null,
      });
    }
    if (!Array.isArray(data)) {
      throw new CreditorCatalogLoadError(table + ' read returned no rows array', { table: table });
    }
    out.push.apply(out, data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

/**
 * @param {object} supabase service-role client
 * @returns {Promise<ReturnType<typeof buildCreditorResolver>>}
 */
async function loadCreditorCatalog(supabase) {
  let creditors;
  let aliases;
  try {
    creditors = await fetchAllPages(supabase, 'creditors', CREDITOR_SELECT);
    aliases = await fetchAllPages(supabase, 'creditor_aliases', ALIAS_SELECT);
  } catch (err) {
    if (err instanceof CreditorCatalogLoadError) throw err;
    throw new CreditorCatalogLoadError('creditor catalog read threw', {
      cause_message: err && err.message ? err.message : null,
    });
  }
  try {
    return buildCreditorResolver({ creditors: creditors, aliases: aliases });
  } catch (err) {
    throw new CreditorCatalogLoadError('creditor catalog integrity check failed', {
      cause_code: err && err.code ? err.code : null,
      cause_message: err && err.message ? err.message : null,
      cause_details: err && err.details ? err.details : null,
    });
  }
}

module.exports = {
  CREDITOR_SELECT,
  ALIAS_SELECT,
  CreditorCatalogLoadError,
  loadCreditorCatalog,
};
