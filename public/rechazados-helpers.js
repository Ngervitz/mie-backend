'use strict';

/**
 * Pure Rechazados V0 UI helpers (browser + Node unit tests).
 * No DOM / no fetch.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RechazadosHelpers = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var OPS_STATUS_LABELS = Object.freeze({
    bcu_pending: 'BCU pendiente',
    retry_eligible: 'Elegible retry',
    reconsultable: 'Reconsultable',
    no_auto_reconsult: 'Sin reconsulta automática',
    undefined_case: 'Caso no definido',
  });

  var FILTERS = Object.freeze([
    { key: null, label: 'Todos' },
    { key: 'bcu_pending', label: 'BCU pendiente' },
    { key: 'retry_eligible', label: 'Elegible retry' },
    { key: 'reconsultable', label: 'Reconsultable' },
    { key: 'no_auto_reconsult', label: 'Sin reconsulta automática' },
    { key: 'undefined_case', label: 'Caso no definido' },
  ]);

  var BCU_CATEGORIES = Object.freeze(['1C', '2A', '2B', '3', '4', '5']);
  var ALLOWED_MIME = Object.freeze({
    'image/jpeg': true,
    'image/png': true,
    'image/webp': true,
    'application/pdf': true,
  });
  var MAX_FILE_BYTES = 10 * 1024 * 1024;

  function opsStatusLabel(status) {
    if (status == null || status === '') return '—';
    return OPS_STATUS_LABELS[status] || String(status);
  }

  function formatPersonName(nombre, apellido) {
    var parts = [];
    if (nombre != null && String(nombre).trim()) parts.push(String(nombre).trim());
    if (apellido != null && String(apellido).trim()) {
      parts.push(String(apellido).trim());
    }
    return parts.length ? parts.join(' ') : '—';
  }

  function formatScore(score) {
    if (score == null || score === '') return '—';
    var n = Number(score);
    if (!Number.isFinite(n)) return '—';
    return String(score);
  }

  function formatWorstBcu(cat) {
    if (cat == null || cat === '') return '—';
    return String(cat);
  }

  function todayYmdMontevideo(nowMs) {
    var d = nowMs != null ? new Date(nowMs) : new Date();
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
  }

  function formatCalendarDateUy(ymd) {
    if (ymd == null || ymd === '') return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
    if (!m) return String(ymd);
    return m[3] + '/' + m[2] + '/' + m[1];
  }

  /**
   * Display next_review_on. Does not recalculate the date.
   * @returns {{ text: string, overdue: boolean }}
   */
  function formatNextReviewOn(ymd, nowMs) {
    if (ymd == null || ymd === '') {
      return { text: '—', overdue: false };
    }
    var s = String(ymd).trim();
    var label = formatCalendarDateUy(s);
    var today = todayYmdMontevideo(nowMs);
    var overdue = /^\d{4}-\d{2}-\d{2}$/.test(s) && s < today;
    return {
      text: overdue ? label + ' · vencida' : label,
      overdue: overdue,
    };
  }

  function formatTsUy(raw) {
    if (raw == null || raw === '') return '—';
    var t = Date.parse(String(raw));
    if (!Number.isFinite(t)) return String(raw);
    return new Date(t).toLocaleString('es-UY', {
      timeZone: 'America/Montevideo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function buildListUrl(base, status) {
    var root = String(base || '') + '/rechazados';
    if (status == null || status === '' || status === 'all') return root;
    return root + '?status=' + encodeURIComponent(String(status));
  }

  function emptyInstitution() {
    return {
      institution_name: '',
      category: '1C',
      vigente_mn: '',
      vigente_me: '',
      moroso_mn: '',
      moroso_me: '',
      castigado_mn: '',
      castigado_me: '',
      contingencias_mn: '',
      contingencias_me: '',
    };
  }

  function balanceOrZero(raw) {
    if (raw == null || raw === '') return 0;
    var n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  /**
   * @returns {{ ok: true, institutions: object[] } | { ok: false, error: string }}
   */
  function serializeInstitutions(rows) {
    if (!Array.isArray(rows) || !rows.length) {
      return { ok: false, error: 'Agregá al menos una institución' };
    }
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      var name =
        row.institution_name != null ? String(row.institution_name).trim() : '';
      if (!name) {
        return {
          ok: false,
          error: 'Completá el nombre de la institución #' + (i + 1),
        };
      }
      var cat =
        row.category != null ? String(row.category).trim() : '';
      if (BCU_CATEGORIES.indexOf(cat) === -1) {
        return {
          ok: false,
          error: 'Categoría inválida en institución #' + (i + 1),
        };
      }
      var item = {
        institution_name: name,
        category: cat,
      };
      var keys = [
        'vigente_mn',
        'vigente_me',
        'moroso_mn',
        'moroso_me',
        'castigado_mn',
        'castigado_me',
        'contingencias_mn',
        'contingencias_me',
      ];
      for (var k = 0; k < keys.length; k += 1) {
        var bal = balanceOrZero(row[keys[k]]);
        if (bal == null) {
          return {
            ok: false,
            error: 'Saldo inválido en institución #' + (i + 1),
          };
        }
        item[keys[k]] = bal;
      }
      out.push(item);
    }
    return { ok: true, institutions: out };
  }

  function validateSelectedFile(file) {
    if (!file) return { ok: true, file: null };
    var mime = String(file.type || '')
      .toLowerCase()
      .split(';')[0]
      .trim();
    if (!ALLOWED_MIME[mime]) {
      return { ok: false, error: 'Archivo no permitido (JPEG, PNG, WEBP o PDF)' };
    }
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, error: 'El archivo supera 10 MB' };
    }
    return { ok: true, file: file };
  }

  function formatFileSize(bytes) {
    var n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return String(n) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function canRemoveInstitution(count) {
    return Number(count) > 1;
  }

  return {
    OPS_STATUS_LABELS: OPS_STATUS_LABELS,
    FILTERS: FILTERS,
    BCU_CATEGORIES: BCU_CATEGORIES,
    ALLOWED_MIME: ALLOWED_MIME,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    opsStatusLabel: opsStatusLabel,
    formatPersonName: formatPersonName,
    formatScore: formatScore,
    formatWorstBcu: formatWorstBcu,
    todayYmdMontevideo: todayYmdMontevideo,
    formatCalendarDateUy: formatCalendarDateUy,
    formatNextReviewOn: formatNextReviewOn,
    formatTsUy: formatTsUy,
    buildListUrl: buildListUrl,
    emptyInstitution: emptyInstitution,
    serializeInstitutions: serializeInstitutions,
    validateSelectedFile: validateSelectedFile,
    formatFileSize: formatFileSize,
    canRemoveInstitution: canRemoveInstitution,
  };
});
