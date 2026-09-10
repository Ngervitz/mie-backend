'use strict';

/**
 * Deterministic BCU result HTML → bcu_v1 (no LLM, no JS execution, no I/O).
 *
 * Separates:
 * - page_type (RESULT_PAGE | CONSULTA_FORM | UNKNOWN_PAGE)
 * - extraction (bcu_v1 object only for RESULT_PAGE; otherwise null)
 * - parser_meta (technical, non-sensitive)
 *
 * Charset decode is separate: decodeBcuHtml(Buffer) → string → parseBcuHtml(string).
 */

const cheerio = require('cheerio');
const {
  EXTRACTION_CONTRACT_VERSION,
  RUBRO_KEYS,
  CURRENCY_VIEWS,
} = require('./bcuExtractContract');

const PAGE_TYPE = Object.freeze({
  RESULT_PAGE: 'RESULT_PAGE',
  CONSULTA_FORM: 'CONSULTA_FORM',
  UNKNOWN_PAGE: 'UNKNOWN_PAGE',
});

/** Radio value → bcu_v1 currency_view_selected (portal: A/B/D). */
const RADIO_TO_CURRENCY = Object.freeze({
  A: 'MN_PESOS_ME_PESOS', // MNP_MEP — MN-$ + ME-$
  B: 'MN_PESOS_ME_USD', // MNP_MED — MN-$ + ME-US$
  D: 'MN_USD_ME_USD', // MND_MED — MN-US$ + ME-US$
});

const VALID_CATEGORIES = Object.freeze(['1C', '2A', '2B', '3', '4', '5']);

const RUBRO_LABEL_TO_KEY = Object.freeze({
  VIGENTE: 'vigente',
  'VIGENTE - NO AUTOLIQUIDABLE': 'vigente_no_autoliquidable',
  'VIGENTE-NO AUTOLIQUIDABLE': 'vigente_no_autoliquidable',
  'VIGENTE NO AUTOLIQUIDABLE': 'vigente_no_autoliquidable',
  'COLOCACION VENCIDA': 'colocacion_vencida',
  'COLOCACIÓN VENCIDA': 'colocacion_vencida',
  MOROSOS: 'moroso',
  MOROSO: 'moroso',
  'CASTIGADO POR ATRASO': 'castigado_por_atraso',
  CONTINGENCIAS: 'contingencias',
  'CREDITOS REESTRUCTURADOS': 'creditos_reestructurados',
  'CRÉDITOS REESTRUCTURADOS': 'creditos_reestructurados',
});

function emptyMoneyPair() {
  return { mn: null, me: null };
}

function emptyRubros() {
  const o = {};
  for (let i = 0; i < RUBRO_KEYS.length; i += 1) {
    o[RUBRO_KEYS[i]] = emptyMoneyPair();
  }
  return o;
}

function normLabel(raw) {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function mapRubroKey(label) {
  const n = normLabel(label);
  if (RUBRO_LABEL_TO_KEY[n]) return RUBRO_LABEL_TO_KEY[n];
  const flat = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (RUBRO_LABEL_TO_KEY[flat]) return RUBRO_LABEL_TO_KEY[flat];
  if (flat.indexOf('CASTIGADO POR ATRASO') === 0) return 'castigado_por_atraso';
  if (flat.indexOf('VIGENTE') === 0 && flat.indexOf('NO AUTOLIQUIDABLE') !== -1) {
    return 'vigente_no_autoliquidable';
  }
  if (flat === 'VIGENTE') return 'vigente';
  if (flat === 'COLOCACION VENCIDA') return 'colocacion_vencida';
  if (flat.indexOf('MOROSO') === 0) return 'moroso';
  if (flat.indexOf('CONTINGENC') === 0) return 'contingencias';
  if (flat.indexOf('CREDITOS REESTRUCTURADOS') === 0) {
    return 'creditos_reestructurados';
  }
  return null;
}

/**
 * True when the first cell looks like a BCU rubro label (not CALIF / RUBRO header /
 * numeric / bare institution title without rubro styling).
 */
function looksLikeUnmappedRubroLabel(label, cls) {
  const n = normLabel(label);
  if (!n || n === 'RUBRO') return false;
  if (/^CALIF/i.test(n)) return false;
  if (/\d/.test(label) && !/^CALIF/i.test(label)) return false;
  return Boolean(cls && cls.indexOf('headerLeftGris') !== -1);
}

/**
 * Parse BCU display money "5,180.88" / "0.00" → number or null.
 * Parse failure never becomes 0.
 * @returns {{ value: number|null, ok: boolean, raw: string }}
 */
function parseBcuMoneyCell(raw) {
  const text = String(raw == null ? '' : raw)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, '')
    .trim();
  if (!text) return { value: null, ok: false, raw: text };
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(text)) {
    return { value: null, ok: false, raw: text };
  }
  const normalized = text.replace(/,/g, '');
  const num = Number(normalized);
  if (!Number.isFinite(num) || num < 0) {
    return { value: null, ok: false, raw: text };
  }
  return { value: num, ok: true, raw: text };
}

/**
 * Decode saved BCU HTML Buffer using meta charset.
 * Observed portal saves use charset=windows-1252.
 * Node latin1 is 1:1 byte→char; sufficient for BCU Spanish text (windows-1252 / iso-8859-1).
 * No extra dependency required.
 *
 * @param {Buffer|string} input
 * @returns {{ html: string, charset: string }}
 */
function decodeBcuHtml(input) {
  if (Buffer.isBuffer(input)) {
    const head = input.slice(0, 4096).toString('latin1');
    const m = /charset\s*=\s*["']?\s*([a-zA-Z0-9_-]+)/i.exec(head);
    const rawCharset = (m && m[1] ? m[1] : 'windows-1252').toLowerCase();
    if (rawCharset === 'utf-8' || rawCharset === 'utf8') {
      return { html: input.toString('utf8'), charset: 'utf-8' };
    }
    // windows-1252, iso-8859-1, and unspecified → latin1 decode
    return { html: input.toString('latin1'), charset: rawCharset };
  }
  return { html: String(input || ''), charset: 'string' };
}

/**
 * Strip CAPTCHA tokens / saved-from URLs. Does not log or return the token.
 * @param {string} html
 * @returns {string}
 */
function sanitizeBcuHtmlSensitive(html) {
  return String(html || '')
    .replace(/g-recaptcha-response=[^&\s"'<>]*/gi, 'g-recaptcha-response=REDACTED')
    .replace(
      /<textarea\b[^>]*\bname\s*=\s*["']?g-recaptcha-response["']?[^>]*>[\s\S]*?<\/textarea>/gi,
      '<textarea name="g-recaptcha-response">REDACTED</textarea>',
    )
    .replace(
      /<input\b[^>]*\bname\s*=\s*["']?g-recaptcha-response["']?[^>]*>/gi,
      '<input type="hidden" name="g-recaptcha-response" value="REDACTED" />',
    )
    .replace(
      /<!--\s*saved from url=\([^)]*\)[^>]*-->/gi,
      '<!-- saved from url=(REDACTED) -->',
    )
    .replace(
      /saved from url=\([^)]*\)https?:\/\/[^\s\]]+/gi,
      'saved from url=(REDACTED)',
    );
}

function cellText($, el) {
  return ($(el).text() || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function findLabelValue($, labelRe) {
  let found = null;
  $('td').each(function (_i, el) {
    if (found != null) return;
    const t = cellText($, el);
    if (!labelRe.test(t)) return;
    const next = $(el).next('td');
    if (next.length) {
      found = cellText($, next);
      return;
    }
    const parent = $(el).parent();
    const tds = parent.children('td');
    if (tds.length >= 2) {
      const idx = tds.toArray().indexOf(el);
      if (idx >= 0 && idx + 1 < tds.length) {
        found = cellText($, tds.get(idx + 1));
      } else {
        found = cellText($, tds.get(1));
      }
    }
  });
  return found;
}

/** Visible YYYYMM next to Periodo label — never hidden input[name=periodo]. */
function findVisiblePeriod($) {
  let period = null;
  $('tr').each(function (_i, tr) {
    if (period) return;
    const tds = $(tr).children('td');
    for (let i = 0; i < tds.length; i += 1) {
      const t = cellText($, tds.get(i));
      if (!/^Periodo$/i.test(t)) continue;
      for (let j = i + 1; j < tds.length; j += 1) {
        const v = cellText($, tds.get(j)).trim();
        if (/^20\d{2}(0[1-9]|1[0-2])$/.test(v)) {
          period = v;
          return;
        }
      }
    }
  });
  return period;
}

function detectCurrencyRadio($) {
  let selected = null;
  $('input[name="rbtMons"]').each(function (_i, el) {
    if ($(el).attr('checked') == null) return;
    // Prefer visible radios over hidden sync fields with same name
    const type = String($(el).attr('type') || '').toLowerCase();
    if (type === 'hidden') return;
    selected = String($(el).attr('value') || '').toUpperCase();
  });
  if (!selected) {
    $('input[name="rbtMons"]').each(function (_i, el) {
      if ($(el).attr('checked') == null) return;
      selected = String($(el).attr('value') || '').toUpperCase();
    });
  }
  return selected;
}

function detectCurrencyView($) {
  const selected = detectCurrencyRadio($);
  if (selected && RADIO_TO_CURRENCY[selected]) {
    return RADIO_TO_CURRENCY[selected];
  }
  return 'UNKNOWN';
}

/**
 * Column indices from portal colXGrupos (td[0]=rubro):
 * A/MNP_MEP → 1,2 ; B/MNP_MED → 1,4 ; D/MND_MED → 3,4
 */
function moneyPairFromRowCells(cells, currencyView, warnings, pathPrefix) {
  let mnIdx = 1;
  let meIdx = 2;
  if (currencyView === 'MN_PESOS_ME_USD') {
    mnIdx = 1;
    meIdx = 4;
  } else if (currencyView === 'MN_USD_ME_USD') {
    mnIdx = 3;
    meIdx = 4;
  } else if (currencyView !== 'MN_PESOS_ME_PESOS') {
    // UNKNOWN / unsupported view: do not invent columns
    return emptyMoneyPair();
  }
  const mnRaw = cells[mnIdx] != null ? cells[mnIdx] : '';
  const meRaw = cells[meIdx] != null ? cells[meIdx] : '';
  const mnP = parseBcuMoneyCell(mnRaw);
  const meP = parseBcuMoneyCell(meRaw);
  if (!mnP.ok && mnRaw) warnings.push('parse_fail_mn:' + pathPrefix);
  if (!meP.ok && meRaw) warnings.push('parse_fail_me:' + pathPrefix);
  return {
    mn: mnP.ok ? mnP.value : null,
    me: meP.ok ? meP.value : null,
  };
}

function parseRubroTable($, tableSel, currencyView, warnings, pathPrefix) {
  const rubros = emptyRubros();
  $(tableSel)
    .find('tr')
    .each(function (_i, tr) {
      const tds = $(tr).children('td');
      if (tds.length < 3) return;
      const first = tds.eq(0);
      const cls = String(first.attr('class') || '');
      const label = cellText($, first);
      if (/\d/.test(label) && !/^CALIF/i.test(label)) return;
      if (cls && cls.indexOf('headerLeftGris') === -1 && normLabel(label) !== 'RUBRO') {
        if (tableSel !== '#tabla' && !mapRubroKey(label)) return;
      }
      const key = mapRubroKey(label);
      if (!key) {
        if (looksLikeUnmappedRubroLabel(label, cls)) {
          const warn =
            'unmapped_rubro:' +
            normLabel(label).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (warnings.indexOf(warn) === -1) warnings.push(warn);
        }
        return;
      }
      if (normLabel(label) === 'RUBRO') return;
      const cells = [];
      tds.each(function (_j, td) {
        cells.push(cellText($, td));
      });
      rubros[key] = moneyPairFromRowCells(
        cells,
        currencyView,
        warnings,
        pathPrefix + '.' + key,
      );
    });
  return { rubros: rubros };
}

function parseInstitutions($, currencyView, warnings) {
  const institutions = [];
  const seen = Object.create(null);

  // Collect indices from ids present in DOM (no hard max from observed n).
  const indices = [];
  $('[id^="tablaXInst"], [id^="XInst"]').each(function (_i, el) {
    const id = String($(el).attr('id') || '');
    const m = /^(?:tabla)?XInst(\d+)$/i.exec(id);
    if (!m) return;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || seen[n]) return;
    seen[n] = true;
    indices.push(n);
  });
  indices.sort(function (a, b) {
    return a - b;
  });

  for (let i = 0; i < indices.length; i += 1) {
    const n = indices[i];
    const head = $('#XInst' + n);
    const table = $('#tablaXInst' + n);
    if (!table.length) continue;

    let name = '';
    let category = null;
    table.find('tr').each(function (_j, tr) {
      if (name) return;
      const tds = $(tr).children('td');
      if (tds.length < 2) return;
      const a = cellText($, tds.get(0));
      const b = cellText($, tds.get(1));
      if (/^CALIF:/i.test(b) || /CALIF/i.test(b)) {
        name = a;
        const m = /CALIF\s*:\s*([0-9A-Za-z]+)/i.exec(b);
        if (m) {
          const cat = String(m[1]).toUpperCase();
          category = VALID_CATEGORIES.indexOf(cat) >= 0 ? cat : null;
        }
      }
    });
    if (!name) {
      const hl = head.find('td.headerLeft').first();
      name = cellText($, hl);
    }
    name = String(name || '').trim();

    const parsed = parseRubroTable(
      $,
      '#tablaXInst' + n,
      currencyView,
      warnings,
      'institutions[' + institutions.length + ']',
    );

    institutions.push(
      Object.assign(
        {
          institution_name_raw: name || null,
          category: category,
        },
        parsed.rubros,
      ),
    );
  }
  return { institutions: institutions };
}

function hasSummaryTable($) {
  const table = $('#tabla');
  if (!table.length) return false;
  let rubroRows = 0;
  table.find('tr').each(function (_i, tr) {
    const tds = $(tr).children('td');
    if (tds.length < 3) return;
    if (mapRubroKey(cellText($, tds.get(0)))) rubroRows += 1;
  });
  return rubroRows > 0;
}

function hasConsultaFormSignals($) {
  const hasNroDoc = $('input[name="nroDoc"]').length > 0;
  const hasPais =
    $('select[name="cboPaisDoc"], select#cboPaisDoc').length > 0;
  const hasTipo =
    $('select[name="cboTipoDoc"], select#cboTipoDoc').length > 0;
  const hasConsultar =
    $('input[type="image"][value="Consultar"], input[value="Consultar"]').length >
    0;
  const hasPeriodoText =
    $('input[type="text"][name="periodo"], input[name="periodo"][type="TEXT"]').length >
      0 ||
    $('input[name="periodo"]').filter(function () {
      const t = String($(this).attr('type') || 'text').toLowerCase();
      return t === 'text';
    }).length > 0;
  return hasNroDoc && hasPais && (hasTipo || hasConsultar) && hasPeriodoText;
}

/**
 * Structural page classification from static HTML (no session semantics).
 * @returns {string} PAGE_TYPE.*
 */
function classifyPageType($) {
  const documentRaw = findLabelValue($, /^Documento$/i);
  const periodVisible = findVisiblePeriod($);
  const hasRadio = $('input[type="radio"][name="rbtMons"]').length > 0;
  const summaryOk = hasSummaryTable($);
  const hasInst =
    $('[id^="tablaXInst"]').length > 0 || $('[id^="XInst"]').length > 0;

  const resultEvidence =
    !!documentRaw &&
    !!periodVisible &&
    hasRadio &&
    summaryOk;

  if (resultEvidence) return PAGE_TYPE.RESULT_PAGE;

  // Valid empty-debt result would still have Documento/Periodo/radio/summary headers;
  // require summary structure (#tabla with rubro rows) or institutions.
  if (
    documentRaw &&
    periodVisible &&
    hasRadio &&
    (summaryOk || hasInst)
  ) {
    return PAGE_TYPE.RESULT_PAGE;
  }

  if (hasConsultaFormSignals($) && !summaryOk && !documentRaw) {
    return PAGE_TYPE.CONSULTA_FORM;
  }

  // Form-like without full result signals
  if (hasConsultaFormSignals($) && !resultEvidence) {
    return PAGE_TYPE.CONSULTA_FORM;
  }

  return PAGE_TYPE.UNKNOWN_PAGE;
}

function loadCheerio(html) {
  const safeHtml = sanitizeBcuHtmlSensitive(html);
  const $ = cheerio.load(safeHtml, {
    xmlMode: false,
    decodeEntities: true,
  });
  $('script').remove();
  return { $: $, safeHtml: safeHtml };
}

function extractResultPage($, charset) {
  const warnings = [];
  const illegible_fields = [];

  const document_ci_raw = findLabelValue($, /^Documento$/i);
  const periodVisible = findVisiblePeriod($);
  let period = null;
  if (periodVisible && /^20\d{2}(0[1-9]|1[0-2])$/.test(String(periodVisible).trim())) {
    period = String(periodVisible).trim();
  } else {
    warnings.push('period_visible_unparsed');
  }

  const hiddenPeriodos = [];
  $('input[name="periodo"]').each(function (_i, el) {
    hiddenPeriodos.push(String($(el).attr('value') || ''));
  });

  const radio = detectCurrencyRadio($);
  const currency_view_selected = radio && RADIO_TO_CURRENCY[radio]
    ? RADIO_TO_CURRENCY[radio]
    : 'UNKNOWN';
  if (currency_view_selected === 'UNKNOWN') {
    warnings.push('currency_view_unknown');
  }

  const summaryParsed = parseRubroTable(
    $,
    '#tabla',
    currency_view_selected,
    warnings,
    'summary',
  );
  const instParsed = parseInstitutions($, currency_view_selected, warnings);

  const extraction = {
    extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
    currency_view_selected: currency_view_selected,
    period: period,
    document_ci_raw: document_ci_raw ? String(document_ci_raw).trim() : null,
    institutions: instParsed.institutions,
    summary: summaryParsed.rubros,
    review: {
      warnings: warnings.slice(),
      illegible_fields: illegible_fields.slice(),
    },
  };

  return {
    extraction: extraction,
    parser_meta: {
      html_charset: charset || null,
      radio_value: radio || null,
      hidden_periodos_ignored: hiddenPeriodos,
      institution_count: instParsed.institutions.length,
      currency_views_known: CURRENCY_VIEWS.slice(),
    },
  };
}

/**
 * Parse already-decoded HTML string.
 * @param {string} html
 * @param {{ charset?: string }} [options]
 * @returns {{ page_type: string, extraction: object|null, parser_meta: object }}
 */
function parseBcuHtml(html, options) {
  const charset = options && options.charset != null ? options.charset : 'string';
  const loaded = loadCheerio(html);
  const $ = loaded.$;
  const page_type = classifyPageType($);

  if (page_type === PAGE_TYPE.RESULT_PAGE) {
    const extracted = extractResultPage($, charset);
    return {
      page_type: page_type,
      extraction: extracted.extraction,
      parser_meta: Object.assign(
        {
          sensitive_redacted: true,
        },
        extracted.parser_meta,
      ),
    };
  }

  return {
    page_type: page_type,
    extraction: null,
    parser_meta: {
      html_charset: charset,
      sensitive_redacted: true,
      institution_count: 0,
      reason:
        page_type === PAGE_TYPE.CONSULTA_FORM
          ? 'consulta_form_not_result'
          : 'unknown_page_structure',
    },
  };
}

/**
 * Decode Buffer then parse.
 * @param {Buffer|string} input
 */
function parseBcuHtmlBuffer(input) {
  const decoded = decodeBcuHtml(input);
  return parseBcuHtml(decoded.html, { charset: decoded.charset });
}

/**
 * Deep-clone extraction; throws if captcha-like content present.
 */
function assertNoCaptchaLeak(value, label) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/g-recaptcha-response=(?!REDACTED)/i.test(s)) {
    throw new Error('captcha_leak in ' + (label || 'payload'));
  }
  if (/03AFcWeA[A-Za-z0-9_-]{20,}/.test(s)) {
    throw new Error('captcha_token_leak in ' + (label || 'payload'));
  }
  return false;
}

module.exports = {
  PAGE_TYPE,
  RADIO_TO_CURRENCY,
  decodeBcuHtml,
  sanitizeBcuHtmlSensitive,
  parseBcuHtml,
  parseBcuHtmlBuffer,
  parseBcuMoneyCell,
  mapRubroKey,
  assertNoCaptchaLeak,
};
