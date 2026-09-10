'use strict';

/**
 * Pure Mi Deuda Stage 1E UI helpers (browser + Node unit tests).
 * Presentation only — membership / canonicalization stay in miDeudaBags.js.
 * No DOM / no fetch.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MiDeudaHelpers = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var PROBLEM_KEYS = Object.freeze([
    'moroso_mn',
    'moroso_me',
    'castigado_mn',
    'castigado_me',
  ]);

  /**
   * Monto problemático conocido = sum of known numeric Moroso/Castigado MN|ME.
   * NULL/undefined do not contribute (not treated as zero).
   * Reestructurado is never included.
   * @returns {number|null} null when no numeric known values
   */
  function knownProblematicAmount(bag) {
    var src = bag && typeof bag === 'object' ? bag : {};
    var sum = 0;
    var any = false;
    for (var i = 0; i < PROBLEM_KEYS.length; i++) {
      var v = src[PROBLEM_KEYS[i]];
      if (v == null || v === '') continue;
      var n = Number(v);
      if (!Number.isFinite(n)) continue;
      sum += n;
      any = true;
    }
    return any ? sum : null;
  }

  function compareBagsNeutral(a, b) {
    var pa = Number(a && a.people_count);
    var pb = Number(b && b.people_count);
    var ca = Number.isFinite(pa) ? pa : 0;
    var cb = Number.isFinite(pb) ? pb : 0;
    if (cb !== ca) return cb - ca;
    var na = String(
      (a && a.institution_canonical) != null ? a.institution_canonical : '',
    );
    var nb = String(
      (b && b.institution_canonical) != null ? b.institution_canonical : '',
    );
    return na.localeCompare(nb, 'es', { sensitivity: 'base' });
  }

  /** people_count DESC, institution ASC — never by money. */
  function sortBagsForUi(bags) {
    var list = Array.isArray(bags) ? bags.slice() : [];
    list.sort(compareBagsNeutral);
    return list;
  }

  /**
   * Visible exclusion copy. Counts must be explicit (not a boolean flag).
   * @returns {string|null}
   */
  function exclusionsWarningMessage(unmappedCount, ambiguousCount) {
    var u = Number(unmappedCount) || 0;
    var a = Number(ambiguousCount) || 0;
    if (u <= 0 && a <= 0) return null;
    var parts = [];
    if (u > 0) {
      parts.push(
        u === 1
          ? '1 registro sin institución canónica'
          : u + ' registros sin institución canónica',
      );
    }
    if (a > 0) {
      parts.push(
        a === 1 ? '1 caso ambiguo' : a + ' casos ambiguos',
      );
    }
    var verb = u + a === 1 ? 'excluido' : 'excluidos';
    return 'Hay ' + parts.join(' y ') + ' ' + verb + ' de estas bolsas.';
  }

  function bagsEndpointUrl(apiBase) {
    var base = apiBase == null ? '' : String(apiBase);
    return base + '/rechazados/mi-deuda/bags';
  }

  function formatMoneyUy(value) {
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return (
      '$' +
      n.toLocaleString('es-UY', {
        minimumFractionDigits: n % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      })
    );
  }

  /**
   * Rows for the main institution table (no person identities).
   */
  function buildBagTableRows(bags) {
    return sortBagsForUi(bags).map(function (bag) {
      var src = bag && typeof bag === 'object' ? bag : {};
      return {
        institution_canonical:
          src.institution_canonical != null
            ? String(src.institution_canonical)
            : '—',
        people_count: Number.isFinite(Number(src.people_count))
          ? Number(src.people_count)
          : 0,
        monto_problematico_conocido: knownProblematicAmount(src),
        moroso_mn: src.moroso_mn,
        moroso_me: src.moroso_me,
        castigado_mn: src.castigado_mn,
        castigado_me: src.castigado_me,
        reestructurado_mn: src.reestructurado_mn,
        reestructurado_me: src.reestructurado_me,
      };
    });
  }

  /**
   * Count reestructurado universe rows that are outside bag membership.
   */
  function countReestructuradoOutside(universe) {
    var list = Array.isArray(universe) ? universe : [];
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (row && row.also_bag_member === false) n += 1;
    }
    return n;
  }

  return {
    PROBLEM_KEYS: PROBLEM_KEYS,
    knownProblematicAmount: knownProblematicAmount,
    sortBagsForUi: sortBagsForUi,
    exclusionsWarningMessage: exclusionsWarningMessage,
    bagsEndpointUrl: bagsEndpointUrl,
    formatMoneyUy: formatMoneyUy,
    buildBagTableRows: buildBagTableRows,
    countReestructuradoOutside: countReestructuradoOutside,
  };
});
