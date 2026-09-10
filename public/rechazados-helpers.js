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
  var EXTRACT_ALLOWED_MIME = Object.freeze({
    'image/jpeg': true,
    'image/png': true,
    'image/webp': true,
  });
  var MAX_FILE_BYTES = 10 * 1024 * 1024;
  var EXTRACT_RUBRO_KEYS = Object.freeze([
    'vigente',
    'vigente_no_autoliquidable',
    'moroso',
    'castigado_por_atraso',
    'contingencias',
    'creditos_reestructurados',
  ]);
  var BCU_EXTRACT_POLL_MS = 3000;
  var BCU_EXTRACT_POLL_MAX_MS = 90000;

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

  /**
   * Visual CSS modifier for BCU category badges (presentation only).
   * Known: is-bcu-1c|2a|2b|3|4|5. Null/unknown → is-bcu-pending (neutral).
   * @returns {string}
   */
  function bcuCategoryBadgeClass(cat) {
    if (cat == null || cat === '') return 'is-bcu-pending';
    var key = String(cat).trim().toUpperCase();
    if (key === '1C') return 'is-bcu-1c';
    if (key === '2A') return 'is-bcu-2a';
    if (key === '2B') return 'is-bcu-2b';
    if (key === '3') return 'is-bcu-3';
    if (key === '4') return 'is-bcu-4';
    if (key === '5') return 'is-bcu-5';
    return 'is-bcu-pending';
  }

  /**
   * Visual tone for raw score_v2 only (not segment A/B/C).
   * @returns {'success'|'warn'|'danger'|null}
   */
  function scoreTone(score) {
    if (score == null || score === '') return null;
    var n = Number(score);
    if (!Number.isFinite(n)) return null;
    if (n >= 20 && n <= 30) return 'success';
    if (n >= 10 && n <= 19) return 'warn';
    if (n >= 0 && n <= 9) return 'danger';
    return null;
  }

  /**
   * List/detail presentation descriptors (no DOM).
   */
  function scoreCell(score) {
    if (score == null || score === '') {
      return {
        kind: 'cta',
        label: 'Encuestar',
        enabled: false,
        action: null,
      };
    }
    var n = Number(score);
    if (!Number.isFinite(n)) {
      return {
        kind: 'cta',
        label: 'Encuestar',
        enabled: false,
        action: null,
      };
    }
    return {
      kind: 'text',
      label: String(score),
      tone: scoreTone(n),
    };
  }

  function miPlanCell(status) {
    var s = status != null ? String(status) : 'not_invited';
    if (s === 'invited') return { kind: 'text', label: 'Invitado' };
    if (s === 'active') return { kind: 'text', label: 'Activo' };
    return {
      kind: 'cta',
      label: 'Invitar',
      enabled: false,
      action: null,
    };
  }

  function miDeudaCell(status, inviteExpired) {
    var s = status != null ? String(status) : 'not_invited';
    if (s === 'opt_in_accepted') return { kind: 'text', label: 'Aceptó' };
    if (s === 'opt_in_rejected') return { kind: 'text', label: 'Rechazó' };
    if (s === 'invite_sent') {
      if (inviteExpired === true) {
        return {
          kind: 'cta',
          label: 'Reinvitar',
          enabled: false,
          action: null,
          btnTone: 'warn',
        };
      }
      return { kind: 'text', label: 'Enviado' };
    }
    return {
      kind: 'cta',
      label: 'Invitar',
      enabled: false,
      action: null,
    };
  }

  function worstBcuCell(cat) {
    if (cat == null || cat === '') {
      return {
        kind: 'badge',
        label: 'Pendiente',
        badgeClass: bcuCategoryBadgeClass(null),
      };
    }
    return {
      kind: 'badge',
      label: String(cat),
      badgeClass: bcuCategoryBadgeClass(cat),
    };
  }

  function retryReviewCell(opsStatus, nextReviewOn, nowMs) {
    var status = opsStatus != null ? String(opsStatus) : '';
    if (status === 'retry_eligible') {
      return {
        kind: 'cta',
        label: 'Reintentar',
        enabled: false,
        action: null,
        btnTone: 'action',
      };
    }
    if (status === 'reconsultable') {
      var info = formatNextReviewOn(nextReviewOn, nowMs);
      return {
        kind: 'text',
        label: info.text,
        overdue: info.overdue,
      };
    }
    if (status === 'no_auto_reconsult') {
      return { kind: 'text', label: 'Sin revisión auto' };
    }
    if (status === 'bcu_pending') {
      return { kind: 'text', label: '—' };
    }
    if (status === 'undefined_case') {
      return { kind: 'text', label: 'Caso indefinido' };
    }
    return { kind: 'text', label: '—' };
  }

  function miPlanLabel(status) {
    return miPlanCell(status).label;
  }

  function miDeudaLabel(status, inviteExpired) {
    return miDeudaCell(status, inviteExpired).label;
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

  function formatRejectedAtDateCell(raw) {
    if (raw == null || raw === '') {
      return { text: '—', title: '' };
    }
    var full = formatTsUy(raw);
    var t = Date.parse(String(raw));
    if (!Number.isFinite(t)) {
      return { text: String(raw), title: String(raw) };
    }
    var ymd = new Date(t).toLocaleDateString('en-CA', {
      timeZone: 'America/Montevideo',
    });
    return {
      text: formatCalendarDateUy(ymd),
      title: full === '—' ? String(raw) : full,
    };
  }

  function outreachStatusTone(label) {
    var s = label != null ? String(label) : '';
    if (s === 'Activo' || s === 'Aceptó') return 'positive';
    if (s === 'Invitado' || s === 'Enviado') return 'info';
    if (s === 'Rechazó') return 'negative';
    return null;
  }

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
      var cat = row.category != null ? String(row.category).trim() : '';
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

  function moneyCell(v) {
    if (v == null || v === '') return '—';
    return String(v);
  }

  /**
   * Snapshot institutions table money display: nearest-integer rounding, no decimals.
   * Presentation only — does not mutate stored values. NULL/empty → —.
   */
  function formatMoneyUyInteger(v) {
    if (v == null || v === '') return '—';
    var n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return String(Math.round(n));
  }

  function moneyPairNull() {
    return { mn: null, me: null };
  }

  function emptyExtractInstitution() {
    return {
      institution_name_raw: '',
      category: null,
      vigente: moneyPairNull(),
      vigente_no_autoliquidable: moneyPairNull(),
      moroso: moneyPairNull(),
      castigado_por_atraso: moneyPairNull(),
      contingencias: moneyPairNull(),
      creditos_reestructurados: moneyPairNull(),
    };
  }

  function emptyExtractSummary() {
    var out = {};
    for (var i = 0; i < EXTRACT_RUBRO_KEYS.length; i += 1) {
      out[EXTRACT_RUBRO_KEYS[i]] = moneyPairNull();
    }
    return out;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeMoneyPair(pair) {
    var src = pair && typeof pair === 'object' ? pair : {};
    function side(raw) {
      if (raw === null || raw === undefined || raw === '') return null;
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      var n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return n;
    }
    return { mn: side(src.mn), me: side(src.me) };
  }

  function extractionToReviewed(extraction) {
    var src =
      extraction && typeof extraction === 'object' ? cloneJson(extraction) : {};
    var institutions = Array.isArray(src.institutions) ? src.institutions : [];
    var mapped = [];
    for (var i = 0; i < institutions.length; i += 1) {
      var inst = institutions[i] || {};
      var row = {
        institution_name_raw:
          inst.institution_name_raw != null
            ? String(inst.institution_name_raw)
            : '',
        category: inst.category != null ? inst.category : null,
      };
      for (var r = 0; r < EXTRACT_RUBRO_KEYS.length; r += 1) {
        var key = EXTRACT_RUBRO_KEYS[r];
        row[key] = normalizeMoneyPair(inst[key]);
      }
      mapped.push(row);
    }
    var summarySrc =
      src.summary && typeof src.summary === 'object' ? src.summary : {};
    var summary = {};
    for (var s = 0; s < EXTRACT_RUBRO_KEYS.length; s += 1) {
      var sk = EXTRACT_RUBRO_KEYS[s];
      summary[sk] = normalizeMoneyPair(summarySrc[sk]);
    }
    var reviewSrc =
      src.review && typeof src.review === 'object' ? src.review : {};
    return {
      extraction_contract_version:
        src.extraction_contract_version != null
          ? src.extraction_contract_version
          : 'bcu_v1',
      currency_view_selected:
        src.currency_view_selected != null
          ? src.currency_view_selected
          : 'MN_PESOS_ME_PESOS',
      period: src.period != null ? src.period : null,
      document_ci_raw:
        src.document_ci_raw != null ? src.document_ci_raw : null,
      institutions: mapped,
      summary: summary,
      review: {
        warnings: Array.isArray(reviewSrc.warnings)
          ? reviewSrc.warnings.slice()
          : [],
        illegible_fields: Array.isArray(reviewSrc.illegible_fields)
          ? reviewSrc.illegible_fields.slice()
          : [],
      },
    };
  }

  function moneyModeFromValue(v) {
    if (v === null || v === undefined || v === '') return 'null';
    if (typeof v === 'number' && Number.isFinite(v) && v === 0) return 'zero';
    return 'value';
  }

  function moneyValueFromMode(mode, rawInput) {
    if (mode === 'null') return null;
    if (mode === 'zero') return 0;
    if (rawInput === '' || rawInput == null) return NaN;
    var n = Number(rawInput);
    return n;
  }

  /**
   * Compact Stage 5.1 tri-state: [input] [—].
   * — active → null; input 0 → 0; input >0 → value. Never coerce null→0.
   */
  function moneyValueFromCompact(isNullActive, rawInput) {
    if (isNullActive) return null;
    if (rawInput === '' || rawInput == null) return NaN;
    var n = Number(rawInput);
    return n;
  }

  var FINDING_REASON_LABELS = Object.freeze({
    SUMMARY_DETAIL_NOT_COMPARABLE: 'Resumen y detalle no son comparables',
    SUMMARY_DETAIL_MISMATCH: 'Resumen no coincide con el detalle',
    RUBRO_ORPHAN_INCONSISTENT_SUPPORT: 'Rubros sin respaldo consistente',
    RUBRO_ORPHAN_SUMMARY_WITHOUT_INST: 'Resumen sin respaldo en instituciones',
    CI_MISSING: 'Falta CI en el documento',
    CI_MISMATCH: 'CI del documento no coincide',
    CURRENCY_VIEW_MISSING: 'Falta vista de moneda',
    CURRENCY_VIEW_INVALID: 'Vista de moneda inválida',
    EXTRACTION_MISSING: 'Extracción ausente',
    EXTRACTION_NOT_OBJECT: 'Extracción inválida',
    EXTRACTION_CONTRACT_INVALID: 'Contrato de extracción inválido',
    STRUCTURE_INSTITUTIONS_NOT_ARRAY: 'Instituciones inválidas',
    STRUCTURE_INSTITUTION_INVALID: 'Institución inválida',
    STRUCTURE_EMPTY_INSTITUTIONS: 'Sin instituciones',
  });

  var CLASSIFICATION_LABELS = Object.freeze({
    HUMAN_REVIEW: 'Requiere revisión',
    REVIEW_READY: 'Lista para revisar',
    EXTRACTION_FAILED: 'Extracción fallida',
  });

  var EXTRACT_RUBRO_LABELS = Object.freeze({
    vigente: 'Vigente',
    vigente_no_autoliquidable: 'Vig. no autoliquidable',
    moroso: 'Moroso',
    castigado_por_atraso: 'Castigado por atraso',
    contingencias: 'Contingencias',
    creditos_reestructurados: 'Créditos reestructurados',
  });

  function findingReasonLabel(code) {
    if (code == null || code === '') return 'Observación';
    var key = String(code);
    if (FINDING_REASON_LABELS[key]) return FINDING_REASON_LABELS[key];
    return key.replace(/_/g, ' ');
  }

  function classificationLabel(classification) {
    if (classification == null || classification === '') return '—';
    var key = String(classification);
    return CLASSIFICATION_LABELS[key] || key;
  }

  /** YYYYMM or YYYY-MM → MM/YYYY; otherwise passthrough. */
  function formatPeriodLabelUy(period) {
    if (period == null || period === '') return '—';
    var s = String(period).trim();
    var compact = /^(\d{4})(\d{2})$/.exec(s);
    if (compact) return compact[2] + '/' + compact[1];
    var dashed = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
    if (dashed) return dashed[2] + '/' + dashed[1];
    return s;
  }

  /**
   * Parse finding path like "vigente.mn". No institution index exists in payload.
   * @returns {{ rubro: string, side: string, path: string }|null}
   */
  function parseMoneyFindingPath(path) {
    if (path == null || path === '') return null;
    var m = /^([a-z0-9_]+)\.(mn|me)$/i.exec(String(path).trim());
    if (!m) return null;
    var rubro = m[1].toLowerCase();
    var side = m[2].toLowerCase();
    if (EXTRACT_RUBRO_KEYS.indexOf(rubro) === -1) return null;
    return { rubro: rubro, side: side, path: rubro + '.' + side };
  }

  function formatFindingPathLabel(path) {
    var parsed = parseMoneyFindingPath(path);
    if (parsed) {
      var rubroLabel = EXTRACT_RUBRO_LABELS[parsed.rubro] || parsed.rubro;
      return rubroLabel + ' · ' + parsed.side.toUpperCase();
    }
    if (path == null || path === '') return null;
    return String(path);
  }

  /**
   * Group equivalent findings by reason_code. Does not invent institutions.
   */
  function groupFindingsForUi(findings) {
    var list = Array.isArray(findings) ? findings : [];
    var order = [];
    var groups = Object.create(null);
    for (var i = 0; i < list.length; i += 1) {
      var f = list[i] || {};
      var code =
        f.reason_code != null && String(f.reason_code).trim()
          ? String(f.reason_code)
          : 'UNKNOWN';
      if (!groups[code]) {
        groups[code] = {
          reason_code: code,
          label: findingReasonLabel(code),
          severity: f.severity != null ? String(f.severity) : 'info',
          count: 0,
          paths: [],
          pathSeen: Object.create(null),
        };
        order.push(code);
      }
      var g = groups[code];
      g.count += 1;
      if (String(f.severity) === 'blocker') g.severity = 'blocker';
      if (f.path != null && String(f.path).trim() !== '') {
        var p = String(f.path);
        if (!g.pathSeen[p]) {
          g.pathSeen[p] = true;
          g.paths.push(p);
        }
      }
    }
    return order.map(function (code) {
      var g = groups[code];
      return {
        reason_code: g.reason_code,
        label: g.label,
        severity: g.severity,
        count: g.count,
        paths: g.paths.slice(),
      };
    });
  }

  /** Map of "rubro.side" → true for deterministic field highlight. */
  function highlightPathMapFromFindings(findings) {
    var map = Object.create(null);
    var list = Array.isArray(findings) ? findings : [];
    for (var i = 0; i < list.length; i += 1) {
      var parsed = parseMoneyFindingPath(list[i] && list[i].path);
      if (parsed) map[parsed.path] = true;
    }
    return map;
  }

  function isMoneyPathHighlighted(map, rubro, side) {
    if (!map) return false;
    return !!map[String(rubro) + '.' + String(side)];
  }

  /**
   * Show cell if non-null (incl. explicit 0) or highlighted by finding path.
   * Null without highlight → hidden initially.
   */
  function shouldShowMoneyCell(value, highlighted) {
    if (highlighted) return true;
    return value !== null && value !== undefined;
  }

  function shouldExpandExtractSummary(findings) {
    var list = Array.isArray(findings) ? findings : [];
    for (var i = 0; i < list.length; i += 1) {
      var f = list[i] || {};
      var code = f.reason_code != null ? String(f.reason_code) : '';
      if (
        code.indexOf('SUMMARY_DETAIL_') === 0 ||
        code.indexOf('RUBRO_ORPHAN_') === 0
      ) {
        return true;
      }
      if (parseMoneyFindingPath(f.path)) return true;
    }
    return false;
  }

  function extractRubroLabel(rubro) {
    if (rubro == null) return '';
    var key = String(rubro);
    return EXTRACT_RUBRO_LABELS[key] || key;
  }

  function digitsOnly(value) {
    return String(value == null ? '' : value).replace(/\D/g, '');
  }

  function documentCiMatchesExpected(documentCiRaw, expectedCi) {
    var exp = digitsOnly(expectedCi);
    var raw = digitsOnly(documentCiRaw);
    if (!exp) {
      return { ok: false, label: 'Sin CI de referencia' };
    }
    if (!raw) {
      return { ok: false, label: 'Falta CI en documento' };
    }
    var ok = raw === exp || raw.slice(-exp.length) === exp;
    return { ok: ok, label: ok ? 'coincide' : 'no coincide' };
  }

  function isPeriodValidYyyymm(period) {
    if (period == null || period === '') return false;
    var s = String(period).trim();
    var m = /^(\d{4})(\d{2})$/.exec(s);
    if (!m) {
      m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
    }
    if (!m) return false;
    var month = Number(m[2]);
    return month >= 1 && month <= 12;
  }

  function currencyViewQuickStatus(view) {
    var v = view != null ? String(view) : '';
    if (v === 'MN_PESOS_ME_PESOS') {
      return { ok: true, label: 'Pesos' };
    }
    if (!v) {
      return { ok: false, label: 'Sin moneda' };
    }
    return { ok: false, label: v };
  }

  /** Format amount for quick cards (es-UY). null → — */
  function formatMoneyUyQuick(value) {
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

  function moneyPairsEqual(a, b) {
    var pa = a && typeof a === 'object' ? a : {};
    var pb = b && typeof b === 'object' ? b : {};
    return pa.mn === pb.mn && pa.me === pb.me;
  }

  function moneyPairHasPositive(pair) {
    var p = pair && typeof pair === 'object' ? pair : {};
    var mn = p.mn;
    var me = p.me;
    return (typeof mn === 'number' && mn > 0) || (typeof me === 'number' && me > 0);
  }

  /**
   * Quick-view money display: omit ME=0; null pair → —; MN=0 alone → $0.
   */
  function formatQuickMoneyPair(pair) {
    var p = pair && typeof pair === 'object' ? pair : {};
    var mn = p.mn;
    var me = p.me;
    if (mn == null && me == null) return '—';
    if (mn == null && me === 0) return '—';
    var parts = [];
    if (mn != null) parts.push(formatMoneyUyQuick(mn));
    if (me != null && me !== 0) {
      parts.push(formatMoneyUyQuick(me) + ' ME');
    }
    return parts.length ? parts.join(' · ') : '—';
  }

  /**
   * Compact institution rows for quick authorize (presentation only).
   * Does not mutate data. Skips vigente_no_autoliquidable when equal to vigente.
   */
  function institutionQuickRows(inst) {
    var rows = [];
    var src = inst && typeof inst === 'object' ? inst : {};
    function pushRow(key, label, pair, opts) {
      var o = opts || {};
      var p = pair && typeof pair === 'object' ? pair : { mn: null, me: null };
      if (o.onlyIfPositive && !moneyPairHasPositive(p)) return;
      if (!o.always && p.mn == null && p.me == null) return;
      rows.push({
        key: key,
        label: label,
        display: formatQuickMoneyPair(p),
      });
    }
    pushRow('vigente', 'Vigente', src.vigente, { always: true });
    if (!moneyPairsEqual(src.vigente, src.vigente_no_autoliquidable)) {
      pushRow(
        'vigente_no_autoliquidable',
        'Vig. no autoliquidable',
        src.vigente_no_autoliquidable,
        { always: true },
      );
    }
    pushRow('moroso', 'Moroso', src.moroso, { always: true });
    pushRow('castigado_por_atraso', 'Castigado', src.castigado_por_atraso, {
      always: true,
    });
    pushRow('contingencias', 'Contingencias', src.contingencias, {
      onlyIfPositive: true,
    });
    pushRow(
      'creditos_reestructurados',
      'Reestructurado',
      src.creditos_reestructurados,
      { onlyIfPositive: true },
    );
    return rows;
  }

  /**
   * Extraction findings for quick view.
   * Persisted ORPHAN/NOT_COMPARABLE are historical extraction notes — not
   * treated as definitive current confirm blockers (Stage 4 revalidates live).
   */
  function extractionObservationsForUi(findings) {
    var groups = groupFindingsForUi(findings);
    return groups.map(function (g) {
      var code = g.reason_code;
      var isOrphan = code.indexOf('RUBRO_ORPHAN_') === 0;
      var isNc = code === 'SUMMARY_DETAIL_NOT_COMPARABLE';
      var title = g.label;
      var detail = '';
      var confirmHint = '';
      if (isNc) {
        title = 'Totales no completamente comparables';
        detail =
          'Hay campos sin dato por institución, aunque los valores informados pueden coincidir con el total.';
        confirmHint =
          'No bloquea por sí solo en la vista rápida; la validación final ocurre al confirmar.';
      } else if (isOrphan) {
        detail =
          'Etiqueta histórica de la extracción. La confirmación revalida con las reglas actuales.';
        confirmHint =
          'No tratar este registro persistido como blocker definitivo.';
      }
      var showAsCurrentBlocker =
        g.severity === 'blocker' && !isOrphan && !isNc;
      return {
        reason_code: code,
        title: title,
        detail: detail,
        confirmHint: confirmHint,
        count: g.count,
        paths: g.paths.slice(),
        tone: showAsCurrentBlocker ? 'blocker' : 'warning',
        showAsCurrentBlocker: showAsCurrentBlocker,
      };
    });
  }

  function validateReviewedUx(reviewed) {
    if (!reviewed || typeof reviewed !== 'object') {
      return { ok: false, error: 'Extracción inválida' };
    }
    var list = reviewed.institutions;
    if (!Array.isArray(list) || !list.length) {
      return { ok: false, error: 'Agregá al menos una institución' };
    }
    var seen = Object.create(null);
    for (var i = 0; i < list.length; i += 1) {
      var inst = list[i] || {};
      var name =
        inst.institution_name_raw != null
          ? String(inst.institution_name_raw).trim()
          : '';
      if (!name) {
        return {
          ok: false,
          error: 'Completá el nombre de la institución #' + (i + 1),
        };
      }
      var dupKey = name.toLowerCase();
      if (seen[dupKey]) {
        return {
          ok: false,
          error: 'Institución duplicada: ' + name,
        };
      }
      seen[dupKey] = true;

      if (inst.category == null || inst.category === '') {
        return {
          ok: false,
          error: 'Indicá la categoría de la institución #' + (i + 1),
        };
      }
      if (BCU_CATEGORIES.indexOf(String(inst.category)) === -1) {
        return {
          ok: false,
          error: 'Categoría inválida en institución #' + (i + 1),
        };
      }

      for (var r = 0; r < EXTRACT_RUBRO_KEYS.length; r += 1) {
        var pair = inst[EXTRACT_RUBRO_KEYS[r]];
        var sides = ['mn', 'me'];
        for (var si = 0; si < sides.length; si += 1) {
          var v = pair && typeof pair === 'object' ? pair[sides[si]] : undefined;
          if (v === null || v === undefined) continue;
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            return {
              ok: false,
              error: 'Monto inválido en institución #' + (i + 1),
            };
          }
        }
      }
    }

    var summary =
      reviewed.summary && typeof reviewed.summary === 'object'
        ? reviewed.summary
        : {};
    for (var sr = 0; sr < EXTRACT_RUBRO_KEYS.length; sr += 1) {
      var sp = summary[EXTRACT_RUBRO_KEYS[sr]];
      var ssides = ['mn', 'me'];
      for (var ss = 0; ss < ssides.length; ss += 1) {
        var sv = sp && typeof sp === 'object' ? sp[ssides[ss]] : undefined;
        if (sv === null || sv === undefined) continue;
        if (typeof sv !== 'number' || !Number.isFinite(sv) || sv < 0) {
          return { ok: false, error: 'Monto inválido en resumen' };
        }
      }
    }
    return { ok: true };
  }

  function buildConfirmPayload(consultedOn, reviewed) {
    return {
      consulted_on: consultedOn,
      reviewed: reviewed,
    };
  }

  function validateExtractSelectedFile(file) {
    if (!file) return { ok: false, error: 'Seleccioná una imagen' };
    var mime = String(file.type || '')
      .toLowerCase()
      .split(';')[0]
      .trim();
    if (!EXTRACT_ALLOWED_MIME[mime]) {
      return { ok: false, error: 'Archivo no permitido (JPEG, PNG o WEBP)' };
    }
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, error: 'El archivo supera 10 MB' };
    }
    return { ok: true, file: file };
  }

  function shouldContinueExtractPoll(elapsedMs, status) {
    if (status !== 'extracting') return false;
    if (!Number.isFinite(elapsedMs) || elapsedMs >= BCU_EXTRACT_POLL_MAX_MS) {
      return false;
    }
    return true;
  }

  function extractPollIntervalMs() {
    return BCU_EXTRACT_POLL_MS;
  }

  function extractPollMaxMs() {
    return BCU_EXTRACT_POLL_MAX_MS;
  }

  function institutionHistoryAmountKeys() {
    return [
      'vigente_mn',
      'vigente_me',
      'vigente_no_autoliquidable_mn',
      'vigente_no_autoliquidable_me',
      'moroso_mn',
      'moroso_me',
      'castigado_mn',
      'castigado_me',
      'contingencias_mn',
      'contingencias_me',
      'creditos_reestructurados_mn',
      'creditos_reestructurados_me',
    ];
  }

  return {
    OPS_STATUS_LABELS: OPS_STATUS_LABELS,
    FILTERS: FILTERS,
    BCU_CATEGORIES: BCU_CATEGORIES,
    ALLOWED_MIME: ALLOWED_MIME,
    EXTRACT_ALLOWED_MIME: EXTRACT_ALLOWED_MIME,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    EXTRACT_RUBRO_KEYS: EXTRACT_RUBRO_KEYS,
    BCU_EXTRACT_POLL_MS: BCU_EXTRACT_POLL_MS,
    BCU_EXTRACT_POLL_MAX_MS: BCU_EXTRACT_POLL_MAX_MS,
    opsStatusLabel: opsStatusLabel,
    formatPersonName: formatPersonName,
    formatScore: formatScore,
    formatWorstBcu: formatWorstBcu,
    bcuCategoryBadgeClass: bcuCategoryBadgeClass,
    scoreCell: scoreCell,
    scoreTone: scoreTone,
    miPlanCell: miPlanCell,
    miDeudaCell: miDeudaCell,
    worstBcuCell: worstBcuCell,
    retryReviewCell: retryReviewCell,
    miPlanLabel: miPlanLabel,
    miDeudaLabel: miDeudaLabel,
    todayYmdMontevideo: todayYmdMontevideo,
    formatCalendarDateUy: formatCalendarDateUy,
    formatRejectedAtDateCell: formatRejectedAtDateCell,
    outreachStatusTone: outreachStatusTone,
    formatNextReviewOn: formatNextReviewOn,
    formatTsUy: formatTsUy,
    buildListUrl: buildListUrl,
    emptyInstitution: emptyInstitution,
    serializeInstitutions: serializeInstitutions,
    validateSelectedFile: validateSelectedFile,
    formatFileSize: formatFileSize,
    canRemoveInstitution: canRemoveInstitution,
    moneyCell: moneyCell,
    formatMoneyUyInteger: formatMoneyUyInteger,
    emptyExtractInstitution: emptyExtractInstitution,
    emptyExtractSummary: emptyExtractSummary,
    extractionToReviewed: extractionToReviewed,
    moneyModeFromValue: moneyModeFromValue,
    moneyValueFromMode: moneyValueFromMode,
    moneyValueFromCompact: moneyValueFromCompact,
    FINDING_REASON_LABELS: FINDING_REASON_LABELS,
    CLASSIFICATION_LABELS: CLASSIFICATION_LABELS,
    EXTRACT_RUBRO_LABELS: EXTRACT_RUBRO_LABELS,
    findingReasonLabel: findingReasonLabel,
    classificationLabel: classificationLabel,
    formatPeriodLabelUy: formatPeriodLabelUy,
    parseMoneyFindingPath: parseMoneyFindingPath,
    formatFindingPathLabel: formatFindingPathLabel,
    groupFindingsForUi: groupFindingsForUi,
    highlightPathMapFromFindings: highlightPathMapFromFindings,
    isMoneyPathHighlighted: isMoneyPathHighlighted,
    shouldShowMoneyCell: shouldShowMoneyCell,
    shouldExpandExtractSummary: shouldExpandExtractSummary,
    extractRubroLabel: extractRubroLabel,
    documentCiMatchesExpected: documentCiMatchesExpected,
    isPeriodValidYyyymm: isPeriodValidYyyymm,
    currencyViewQuickStatus: currencyViewQuickStatus,
    formatMoneyUyQuick: formatMoneyUyQuick,
    moneyPairsEqual: moneyPairsEqual,
    moneyPairHasPositive: moneyPairHasPositive,
    formatQuickMoneyPair: formatQuickMoneyPair,
    institutionQuickRows: institutionQuickRows,
    extractionObservationsForUi: extractionObservationsForUi,
    validateReviewedUx: validateReviewedUx,
    buildConfirmPayload: buildConfirmPayload,
    validateExtractSelectedFile: validateExtractSelectedFile,
    shouldContinueExtractPoll: shouldContinueExtractPoll,
    extractPollIntervalMs: extractPollIntervalMs,
    extractPollMaxMs: extractPollMaxMs,
    institutionHistoryAmountKeys: institutionHistoryAmountKeys,
  };
});
