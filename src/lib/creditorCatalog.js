'use strict';

/**
 * Mi Deuda — canonical creditor catalog (pure, no I/O).
 *
 * RAW VALUE ≠ NORMALIZED KEY ≠ CREDITOR ID ≠ DISPLAY NAME.
 * Resolution is exact on (source, creditor_key_v1(raw)). No fuzzy matching.
 *
 * creditor_key_v1 is FROZEN: any change to its steps ships as creditor_key_v2 plus a
 * re-key of creditor_aliases, never in place. Independent from Mi Plan Financial Identity.
 */

const CREDITOR_KEY_VERSION = 'creditor_key_v1';

const CREDITOR_SOURCES = Object.freeze({
  BCU: 'bcu',
  MIPLAN_DECLARED: 'miplan_declared',
});

const CREDITOR_STATUS = Object.freeze({
  ACTIVE: 'active',
  MERGED: 'merged',
  RETIRED: 'retired',
});

const ALIAS_STATUS = Object.freeze({
  APPROVED: 'approved',
  AMBIGUOUS: 'ambiguous',
  DISABLED: 'disabled',
});

const RESOLUTION = Object.freeze({
  EMPTY: 'EMPTY',
  RESOLVED: 'RESOLVED',
  UNKNOWN_REVIEWED: 'UNKNOWN_REVIEWED',
  UNKNOWN: 'UNKNOWN',
});

const KEY_FORMAT_RE = /^[a-z0-9]+( [a-z0-9]+)*$/;

/** Catalog rows could not be turned into a trustworthy resolver. */
class CreditorCatalogIntegrityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CreditorCatalogIntegrityError';
    this.code = 'CREDITOR_CATALOG_INTEGRITY';
    this.details = details || null;
  }
}

/**
 * creditor_key_v1: NFKC → NFD without diacritics → lowercase → delete "." →
 * [^a-z0-9]+ → " " → trim/collapse. Empty → null.
 * @param {unknown} raw
 * @returns {string|null}
 */
function creditorKeyV1(raw) {
  if (raw == null) return null;
  let s = String(raw);
  s = s.normalize('NFKC');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/\./g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  s = s.trim().replace(/ {2,}/g, ' ');
  return s === '' ? null : s;
}

function isSource(v) {
  return v === CREDITOR_SOURCES.BCU || v === CREDITOR_SOURCES.MIPLAN_DECLARED;
}

/**
 * Build an in-memory resolver from catalog rows. Throws CreditorCatalogIntegrityError on any
 * row the DB constraints should have prevented, or on a merge that is not a single hop to a
 * non-merged creditor. Disabled aliases are ignored (history only).
 *
 * @param {{ creditors: object[], aliases: object[] }} catalog
 */
function buildCreditorResolver(catalog) {
  if (!catalog || !Array.isArray(catalog.creditors) || !Array.isArray(catalog.aliases)) {
    throw new CreditorCatalogIntegrityError('catalog rows missing');
  }

  const creditorsById = new Map();
  catalog.creditors.forEach(function (c) {
    const id = c && c.creditor_id != null ? String(c.creditor_id) : '';
    if (!id) throw new CreditorCatalogIntegrityError('creditor without creditor_id');
    if (creditorsById.has(id)) {
      throw new CreditorCatalogIntegrityError('duplicate creditor_id', { creditor_id: id });
    }
    const status = c.status;
    if (
      status !== CREDITOR_STATUS.ACTIVE &&
      status !== CREDITOR_STATUS.MERGED &&
      status !== CREDITOR_STATUS.RETIRED
    ) {
      throw new CreditorCatalogIntegrityError('invalid creditor status', { creditor_id: id });
    }
    const mergedInto =
      c.merged_into_creditor_id != null ? String(c.merged_into_creditor_id) : null;
    if ((status === CREDITOR_STATUS.MERGED) !== (mergedInto != null)) {
      throw new CreditorCatalogIntegrityError('merged status/target mismatch', {
        creditor_id: id,
      });
    }
    if (typeof c.display_name !== 'string' || c.display_name.trim() === '') {
      throw new CreditorCatalogIntegrityError('creditor without display_name', {
        creditor_id: id,
      });
    }
    creditorsById.set(id, {
      creditor_id: id,
      slug: c.slug != null ? String(c.slug) : null,
      display_name: c.display_name,
      status: status,
      merged_into_creditor_id: mergedInto,
    });
  });

  // Single hop: merged → existing, different, non-merged creditor.
  const effectiveById = new Map();
  creditorsById.forEach(function (c, id) {
    if (c.status !== CREDITOR_STATUS.MERGED) {
      effectiveById.set(id, c);
      return;
    }
    const target = creditorsById.get(c.merged_into_creditor_id);
    if (!target || target.creditor_id === id || target.status === CREDITOR_STATUS.MERGED) {
      throw new CreditorCatalogIntegrityError('merge target invalid (missing, self or chained)', {
        creditor_id: id,
        merged_into_creditor_id: c.merged_into_creditor_id,
      });
    }
    effectiveById.set(id, target);
  });

  const activeAliases = new Map();
  catalog.aliases.forEach(function (a) {
    if (!a || !isSource(a.source)) {
      throw new CreditorCatalogIntegrityError('alias with invalid source', { id: a && a.id });
    }
    if (typeof a.normalized_key !== 'string' || !KEY_FORMAT_RE.test(a.normalized_key)) {
      throw new CreditorCatalogIntegrityError('alias with invalid normalized_key', { id: a.id });
    }
    if (a.status === ALIAS_STATUS.DISABLED) return;
    if (a.status !== ALIAS_STATUS.APPROVED && a.status !== ALIAS_STATUS.AMBIGUOUS) {
      throw new CreditorCatalogIntegrityError('alias with invalid status', { id: a.id });
    }
    const slot = a.source + '\0' + a.normalized_key;
    if (activeAliases.has(slot)) {
      throw new CreditorCatalogIntegrityError('duplicate active alias for (source, key)', {
        source: a.source,
        normalized_key: a.normalized_key,
      });
    }
    if (a.status === ALIAS_STATUS.APPROVED) {
      const target = a.creditor_id != null ? String(a.creditor_id) : null;
      if (!target || !effectiveById.has(target)) {
        throw new CreditorCatalogIntegrityError('approved alias without valid creditor', {
          id: a.id,
        });
      }
      activeAliases.set(slot, {
        status: ALIAS_STATUS.APPROVED,
        alias_id: a.id != null ? String(a.id) : null,
        alias_creditor_id: target,
      });
    } else {
      if (a.creditor_id != null) {
        throw new CreditorCatalogIntegrityError('ambiguous alias must not target a creditor', {
          id: a.id,
        });
      }
      activeAliases.set(slot, {
        status: ALIAS_STATUS.AMBIGUOUS,
        alias_id: a.id != null ? String(a.id) : null,
        alias_creditor_id: null,
      });
    }
  });

  return Object.freeze({
    key_version: CREDITOR_KEY_VERSION,
    creditor_count: creditorsById.size,
    active_alias_count: activeAliases.size,
    _aliases: activeAliases,
    _effective: effectiveById,
  });
}

/**
 * @param {ReturnType<typeof buildCreditorResolver>} resolver
 * @param {string} source
 * @param {unknown} raw
 */
function resolveCreditor(resolver, source, raw) {
  if (!resolver || !resolver._aliases || !resolver._effective) {
    throw new CreditorCatalogIntegrityError('resolver required');
  }
  if (!isSource(source)) {
    throw new CreditorCatalogIntegrityError('unknown source', { source: source });
  }
  const rawOut = raw == null ? null : String(raw);
  const key = creditorKeyV1(raw);
  if (key == null) {
    return {
      resolution: RESOLUTION.EMPTY,
      source: source,
      raw: rawOut,
      normalized_key: null,
      creditor_id: null,
      display_name: null,
      alias_id: null,
    };
  }
  const alias = resolver._aliases.get(source + '\0' + key);
  if (!alias) {
    return {
      resolution: RESOLUTION.UNKNOWN,
      source: source,
      raw: rawOut,
      normalized_key: key,
      creditor_id: null,
      display_name: null,
      alias_id: null,
    };
  }
  if (alias.status === ALIAS_STATUS.AMBIGUOUS) {
    return {
      resolution: RESOLUTION.UNKNOWN_REVIEWED,
      source: source,
      raw: rawOut,
      normalized_key: key,
      creditor_id: null,
      display_name: null,
      alias_id: alias.alias_id,
    };
  }
  const effective = resolver._effective.get(alias.alias_creditor_id);
  return {
    resolution: RESOLUTION.RESOLVED,
    source: source,
    raw: rawOut,
    normalized_key: key,
    creditor_id: effective.creditor_id,
    display_name: effective.display_name,
    alias_id: alias.alias_id,
  };
}

module.exports = {
  CREDITOR_KEY_VERSION,
  CREDITOR_SOURCES,
  CREDITOR_STATUS,
  ALIAS_STATUS,
  RESOLUTION,
  KEY_FORMAT_RE,
  CreditorCatalogIntegrityError,
  creditorKeyV1,
  buildCreditorResolver,
  resolveCreditor,
};
