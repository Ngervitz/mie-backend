/**
 * Meta Ads Agent — vanilla port of metaagent2/src/App.jsx
 * Encapsulated IIFE: no globals collide with mie-dashboard.js.
 *
 * Datasource: Supabase REST (own_ad_metrics). No supabase-js in public/.
 *
 * CREDENTIALS (not present in frontend today — do NOT invent values):
 *   Configure EITHER:
 *   1) Placeholders below (SUPABASE_URL / SUPABASE_ANON_KEY), OR
 *   2) Before this script loads:
 *        window.__META_AGENT_DATASOURCE__ = {
 *          supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
 *          supabaseAnonKey: 'YOUR_ANON_KEY'
 *        };
 *   Backend .env has SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY only —
 *   SERVICE_ROLE must never be used in the browser. Need a public anon key
 *   (Dashboard → Project Settings → API → anon public) plus RLS that allows
 *   read of own_ad_metrics for the configured entity.
 *
 * LOOKBACK: METRIC_LOOKBACK_DAYS (default 30). Change that constant to adjust
 * the analytic window. Aggregation / KPIs / alerts stay in JS (no SQL GROUP BY).
 */
(function () {
  'use strict';

  // --- Datasource config (placeholders — fill or inject via window) ---
  var SUPABASE_URL = ''; // e.g. https://xxxx.supabase.co
  var SUPABASE_ANON_KEY = ''; // anon public key only — never service_role

  var OWN_ENTITY_ID = 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df';
  /** Analytic window for own_ad_metrics.metric_date (gte). Change here. */
  var METRIC_LOOKBACK_DAYS = 30;

  var CONFIG_ERROR_MSG = 'Falta configuración de datasource.';

  var state = {
    data: [],
    loading: true,
    error: null,
    tab: 'campaigns',
    lastUpdate: null,
    configMissing: false,
    // Read-only economic calendar card; null fields render "Sin datos".
    nextEvents: { nextHoliday: null, nextBpsPayment: null },
    // Auction pressure from GET /reports/auction-pressure; null → "sin datos".
    auctionPressure: null,
    // Liquidity cycle: { today, history } from GET /api/liquidity-cycle/history.
    liquidityCycle: null,
    // Current BCU usura rate from GET /api/bcu-usura-rate/current.
    bcuUsuraRate: null,
  };

  var auctionPressureChart = null;
  var activeSeriesToggles = {
    auctionIndex: true,
    holidays: true,
    phase: true,
    cpc: true,
    cpl: false,
    bcuRate: true,
    totalEvents: true,
  };

  var root = null;
  var refreshTimerId = null;

  function fmt(val, dec) {
    if (dec === undefined) dec = 2;
    var n = parseFloat(val);
    return isNaN(n) ? '—' : n.toFixed(dec);
  }

  function fmtN(val) {
    var n = parseFloat(val);
    return isNaN(n) ? null : n;
  }

  function resolveDatasourceConfig() {
    var injected = typeof window !== 'undefined' ? window.__META_AGENT_DATASOURCE__ : null;
    var url = '';
    var anonKey = '';
    if (injected && typeof injected === 'object') {
      url = String(injected.supabaseUrl || injected.SUPABASE_URL || '').trim();
      anonKey = String(injected.supabaseAnonKey || injected.SUPABASE_ANON_KEY || '').trim();
    }
    if (!url) url = String(SUPABASE_URL || '').trim();
    if (!anonKey) anonKey = String(SUPABASE_ANON_KEY || '').trim();
    return { url: url, anonKey: anonKey };
  }

  function isDatasourceConfigured(cfg) {
    return !!(cfg && cfg.url && cfg.anonKey);
  }

  function toCsvCompatString(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  /**
   * Map own_ad_metrics row → same string-keyed shape parseCSV() used to emit,
   * so findVal / buildCampList / KPIs / alerts need no changes.
   * Derived metrics (cpl, ctr, cpc) computed here from raw columns only.
   */
  function mapOwnAdMetricsToLegacyRow(row) {
    var spendNum = parseFloat(row.spend);
    var impressionsNum = parseFloat(row.impressions);
    var clicksNum = parseFloat(row.clicks);
    var actionsNum = parseFloat(row.actions);
    var spend = isNaN(spendNum) ? 0 : spendNum;
    var impressions = isNaN(impressionsNum) ? 0 : impressionsNum;
    var clicks = isNaN(clicksNum) ? 0 : clicksNum;
    var actions = isNaN(actionsNum) ? 0 : actionsNum;

    var cpl = actions > 0 ? spend / actions : '';
    var ctr = impressions > 0 ? (clicks / impressions) * 100 : '';
    var cpc = clicks > 0 ? spend / clicks : '';

    var name = toCsvCompatString(row.campaign_name);
    var freq = toCsvCompatString(row.frequency);
    var spendStr = toCsvCompatString(row.spend);
    var convStr = toCsvCompatString(row.actions);

    return {
      campaign_name: name,
      campana: name,
      cpl: toCsvCompatString(cpl),
      ctr: toCsvCompatString(ctr),
      cpc: toCsvCompatString(cpc),
      frequency: freq,
      frecuencia: freq,
      spend: spendStr,
      gasto: spendStr,
      conversions: convStr,
      conversiones: convStr,
      impressions: toCsvCompatString(row.impressions),
      clicks: toCsvCompatString(row.clicks),
      metric_date: toCsvCompatString(row.metric_date),
      raw_json:
        row.raw_json && typeof row.raw_json === 'object' ? row.raw_json : null,
    };
  }

  function lookbackStartDateIso() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - METRIC_LOOKBACK_DAYS);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /**
   * Raw rows from Supabase REST (no SQL aggregation). Paginated to avoid
   * PostgREST default 1000-row cap within the lookback window.
   */
  async function fetchOwnAdMetricsRows(cfg) {
    var since = lookbackStartDateIso();
    var base =
      cfg.url.replace(/\/+$/, '') +
      '/rest/v1/own_ad_metrics' +
      '?entity_id=eq.' +
      encodeURIComponent(OWN_ENTITY_ID) +
      '&metric_date=gte.' +
      encodeURIComponent(since) +
      '&select=entity_id,campaign_id,campaign_name,metric_date,spend,impressions,clicks,actions,actions_value,frequency,raw_json,created_at' +
      '&order=metric_date.asc';

    var pageSize = 1000;
    var from = 0;
    var all = [];

    while (true) {
      var res = await fetch(base, {
        method: 'GET',
        headers: {
          apikey: cfg.anonKey,
          Authorization: 'Bearer ' + cfg.anonKey,
          Accept: 'application/json',
          Range: from + '-' + (from + pageSize - 1),
          Prefer: 'count=exact',
        },
      });
      if (!res.ok) {
        var body = '';
        try {
          body = await res.text();
        } catch (ignore) {
          body = '';
        }
        throw new Error('Supabase HTTP ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
      }
      var chunk = await res.json();
      if (!Array.isArray(chunk)) {
        throw new Error('Respuesta inesperada de Supabase');
      }
      for (var i = 0; i < chunk.length; i++) {
        all.push(chunk[i]);
      }
      if (chunk.length < pageSize) break;
      from += pageSize;
    }

    return all;
  }

  function findVal(row) {
    var keys = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var found = Object.keys(row).find(function (rk) {
        return rk.includes(k.toLowerCase());
      });
      if (found && row[found] !== '') {
        var n = parseFloat(row[found]);
        return isNaN(n) ? row[found] : n;
      }
    }
    return null;
  }

  function sparkbarHtml(value, max, color) {
    if (!color) color = '#3b82f6';
    var pct = Math.min(((fmtN(value) || 0) / (fmtN(max) || 1)) * 100, 100);
    return (
      '<div class="ma-sparkbar">' +
      '<div class="ma-sparkbar-fill" style="width:' +
      pct +
      '%;background:' +
      color +
      '"></div>' +
      '</div>'
    );
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function avg(arr) {
    return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null;
  }

  function sum(arr) {
    return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) : null;
  }

  function buildCampList(data) {
    var campaigns = {};
    data.forEach(function (row) {
      var name = findVal(row, 'campana', 'campaign') || 'Sin nombre';
      if (!campaigns[name]) {
        campaigns[name] = {
          name: name,
          cpl: [],
          ctr: [],
          cpc: [],
          frecuencia: [],
          gasto: [],
          conversiones: [],
          dias: 0,
        };
      }
      campaigns[name].dias++;
      function add(arr) {
        var keys = Array.prototype.slice.call(arguments, 1);
        var v = findVal.apply(null, [row].concat(keys));
        if (v !== null && !isNaN(v)) arr.push(v);
      }
      add(campaigns[name].cpl, 'cpl');
      add(campaigns[name].ctr, 'ctr');
      add(campaigns[name].cpc, 'cpc');
      add(campaigns[name].frecuencia, 'frecuencia', 'frequency');
      add(campaigns[name].gasto, 'gasto', 'spend');
      add(campaigns[name].conversiones, 'conversiones', 'conversions');
    });

    return Object.values(campaigns).map(function (c) {
      return {
        name: c.name,
        dias: c.dias,
        cpl: avg(c.cpl),
        ctr: avg(c.ctr),
        cpc: avg(c.cpc),
        frecuencia: avg(c.frecuencia),
        gasto: sum(c.gasto),
        conversiones: sum(c.conversiones),
      };
    });
  }

  /** Alert thresholds (identical to App.jsx): frecuencia > 4.5 | cpl > 1.5 | ctr < 1 */
  function campaignHasAlert(c) {
    return (
      (c.frecuencia !== null && c.frecuencia > 4.5) ||
      (c.cpl !== null && c.cpl > 1.5) ||
      (c.ctr !== null && c.ctr < 1)
    );
  }

  function rankingLabel(value) {
    if (value === null || value === undefined || value === '') return '—';
    return String(value);
  }

  /**
   * Deterministic account-level aggregates for the latest available
   * metric_date. Null-safety: no rows / zero denominator → null (never 0,
   * Infinity or NaN). ctr is returned as a percentage for this panel's
   * existing display convention (fmt(x) + '%').
   * reach / rankings are read from raw_json (Meta Insights payload).
   */
  function computeLatestDateStats(data) {
    var latestDate = null;
    data.forEach(function (row) {
      var d = row.metric_date || '';
      if (d && (!latestDate || d > latestDate)) latestDate = d;
    });

    if (!latestDate) {
      return {
        date: null,
        spend: null,
        ctr: null,
        cpc: null,
        cpm: null,
        reach: null,
        frequency: null,
        qualityRanking: null,
        engagementRanking: null,
        conversionRanking: null,
      };
    }

    var spend = null;
    var impressions = null;
    var clicks = null;
    var reach = null;
    var freqWeighted = 0;
    var freqWeight = 0;
    var qualityRanking = null;
    var engagementRanking = null;
    var conversionRanking = null;
    data.forEach(function (row) {
      if ((row.metric_date || '') !== latestDate) return;
      var s = fmtN(row.spend);
      var i = fmtN(row.impressions);
      var c = fmtN(row.clicks);
      if (s !== null) spend = (spend || 0) + s;
      if (i !== null) impressions = (impressions || 0) + i;
      if (c !== null) clicks = (clicks || 0) + c;

      var raw = row.raw_json && typeof row.raw_json === 'object' ? row.raw_json : null;
      if (!raw) return;
      var r = fmtN(raw.reach);
      if (r !== null) reach = (reach || 0) + r;
      var f = fmtN(raw.frequency);
      if (f !== null) {
        var w = i !== null && i > 0 ? i : 1;
        freqWeighted += f * w;
        freqWeight += w;
      }
      if (!qualityRanking && raw.quality_ranking) {
        qualityRanking = String(raw.quality_ranking);
      }
      if (!engagementRanking && raw.engagement_rate_ranking) {
        engagementRanking = String(raw.engagement_rate_ranking);
      }
      if (!conversionRanking && raw.conversion_rate_ranking) {
        conversionRanking = String(raw.conversion_rate_ranking);
      }
    });

    var ctr =
      impressions !== null && impressions > 0 && clicks !== null
        ? (clicks / impressions) * 100
        : null;
    var cpc =
      clicks !== null && clicks > 0 && spend !== null ? spend / clicks : null;
    var cpm =
      impressions !== null && impressions > 0 && spend !== null
        ? (spend / impressions) * 1000
        : null;
    var frequency = freqWeight > 0 ? freqWeighted / freqWeight : null;

    return {
      date: latestDate,
      spend: spend,
      ctr: ctr,
      cpc: cpc,
      cpm: cpm,
      reach: reach,
      frequency: frequency,
      qualityRanking: qualityRanking,
      engagementRanking: engagementRanking,
      conversionRanking: conversionRanking,
    };
  }

  function computeDerived(data) {
    var campList = buildCampList(data);
    var totalGasto = campList.reduce(function (a, c) { return a + (c.gasto || 0); }, 0);
    var totalConv = campList.reduce(function (a, c) { return a + (c.conversiones || 0); }, 0);
    var cplVals = campList.filter(function (c) { return c.cpl !== null; });
    var avgCPL = cplVals.length
      ? cplVals.reduce(function (a, c) { return a + c.cpl; }, 0) / cplVals.length
      : null;
    var alertas = campList.filter(campaignHasAlert);
    return {
      campList: campList,
      totalGasto: totalGasto,
      totalConv: totalConv,
      avgCPL: avgCPL,
      alertas: alertas,
      latest: computeLatestDateStats(data),
    };
  }

  function renderLoading() {
    return (
      '<div class="ma-state">' +
      '<div class="ma-state-title ma-pulse">CARGANDO</div>' +
      '<div class="ma-state-sub">CONECTANDO CON SUPABASE</div>' +
      '<div class="ma-state-hint">Cargando datos de Meta Ads...</div>' +
      '</div>'
    );
  }

  function renderConfigMissing() {
    return (
      '<div class="ma-state">' +
      '<div class="ma-state-icon">⚠️</div>' +
      '<div class="ma-state-error">' +
      escapeHtml(CONFIG_ERROR_MSG) +
      '</div>' +
      '<div class="ma-state-hint">Configurá SUPABASE_URL y SUPABASE_ANON_KEY en meta-agent.js o window.__META_AGENT_DATASOURCE__</div>' +
      '</div>'
    );
  }

  function renderError() {
    return (
      '<div class="ma-state">' +
      '<div class="ma-state-icon">⚠️</div>' +
      '<div class="ma-state-error">' +
      escapeHtml(state.error || 'Error al conectar con Supabase') +
      '</div>' +
      '<button type="button" class="ma-btn ma-btn-primary" data-ma-action="retry">Reintentar</button>' +
      '</div>'
    );
  }

  function renderHeader(alertas) {
    var alertBadge = '';
    if (alertas.length > 0) {
      alertBadge =
        '<div class="ma-alert-badge">⚠ ' +
        alertas.length +
        ' ALERTA' +
        (alertas.length > 1 ? 'S' : '') +
        '</div>';
    }
    var syncLabel = state.lastUpdate ? 'SYNC ' + escapeHtml(state.lastUpdate) : '';
    return (
      '<div class="ma-header">' +
      '<div class="ma-header-right">' +
      alertBadge +
      '<div class="ma-sync-label">' +
      syncLabel +
      '</div>' +
      '<button type="button" class="ma-btn ma-btn-sync" data-ma-action="sync">↻ SYNC</button>' +
      '<div class="ma-live">' +
      '<span class="ma-live-dot ma-pulse"></span>' +
      '<span class="ma-live-text">LIVE</span>' +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  /**
   * Display-only daily series for trend arrows. Does not change KPI totals
   * or auction-pressure logic — only prior-period baselines for the UI.
   */
  function buildDailySeries(data) {
    var byDate = {};
    (data || []).forEach(function (row) {
      var d = row.metric_date || '';
      if (!d) return;
      if (!byDate[d]) {
        byDate[d] = {
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          hasSpend: false,
          hasImpr: false,
          hasClicks: false,
          hasConv: false,
        };
      }
      var bucket = byDate[d];
      var s = fmtN(row.spend);
      var i = fmtN(row.impressions);
      var c = fmtN(row.clicks);
      var v = fmtN(row.conversiones);
      if (v === null) v = fmtN(row.conversions);
      if (s !== null) {
        bucket.spend += s;
        bucket.hasSpend = true;
      }
      if (i !== null) {
        bucket.impressions += i;
        bucket.hasImpr = true;
      }
      if (c !== null) {
        bucket.clicks += c;
        bucket.hasClicks = true;
      }
      if (v !== null) {
        bucket.conversions += v;
        bucket.hasConv = true;
      }
    });

    return Object.keys(byDate)
      .sort()
      .map(function (date) {
        var b = byDate[date];
        var spend = b.hasSpend ? b.spend : null;
        var impressions = b.hasImpr ? b.impressions : null;
        var clicks = b.hasClicks ? b.clicks : null;
        var conversions = b.hasConv ? b.conversions : null;
        var ctr =
          impressions !== null && impressions > 0 && clicks !== null
            ? (clicks / impressions) * 100
            : null;
        var cpc =
          clicks !== null && clicks > 0 && spend !== null ? spend / clicks : null;
        var cpm =
          impressions !== null && impressions > 0 && spend !== null
            ? (spend / impressions) * 1000
            : null;
        var cpl =
          conversions !== null && conversions > 0 && spend !== null
            ? spend / conversions
            : null;
        return {
          date: date,
          spend: spend,
          ctr: ctr,
          cpc: cpc,
          cpm: cpm,
          conversions: conversions,
          cpl: cpl,
        };
      });
  }

  /**
   * @param {'up_good'|'up_bad'} semantic
   * @returns {{ arrow: string, label: string, tone: string }|null}
   */
  function buildTrendIndicator(current, priorValues, semantic) {
    if (current === null || current === undefined || !Number.isFinite(Number(current))) {
      return null;
    }
    var priors = (priorValues || []).filter(function (v) {
      return v !== null && v !== undefined && Number.isFinite(Number(v));
    });
    if (!priors.length) return null;
    var baseline = avg(priors);
    if (baseline === null || !Number.isFinite(baseline) || baseline === 0) {
      return null;
    }
    var deltaPct = ((Number(current) - baseline) / Math.abs(baseline)) * 100;
    if (!Number.isFinite(deltaPct)) return null;
    var rounded = Math.round(deltaPct);
    if (rounded === 0) {
      return { arrow: '–', label: '0%', tone: 'neutral' };
    }
    var up = rounded > 0;
    var tone;
    if (semantic === 'up_good') {
      tone = up ? 'good' : 'bad';
    } else {
      tone = up ? 'bad' : 'good';
    }
    return {
      arrow: up ? '↑' : '↓',
      label: Math.abs(rounded) + '%',
      tone: tone,
    };
  }

  function trendsFromData(data, latest) {
    var series = buildDailySeries(data);
    if (!series.length || !latest || !latest.date) {
      return {
        spend: null,
        conversions: null,
        cpl: null,
        ctr: null,
        cpc: null,
        cpm: null,
      };
    }
    var priors = series.filter(function (d) {
      return d.date < latest.date;
    });
    var latestDay = null;
    for (var i = 0; i < series.length; i++) {
      if (series[i].date === latest.date) latestDay = series[i];
    }
    function pick(key) {
      return priors
        .map(function (d) {
          return d[key];
        })
        .filter(function (v) {
          return v !== null && v !== undefined;
        });
    }
    return {
      spend: buildTrendIndicator(latest.spend, pick('spend'), 'up_bad'),
      conversions: buildTrendIndicator(
        latestDay ? latestDay.conversions : null,
        pick('conversions'),
        'up_good',
      ),
      cpl: buildTrendIndicator(latestDay ? latestDay.cpl : null, pick('cpl'), 'up_bad'),
      ctr: buildTrendIndicator(latest.ctr, pick('ctr'), 'up_good'),
      cpc: buildTrendIndicator(latest.cpc, pick('cpc'), 'up_bad'),
      cpm: buildTrendIndicator(latest.cpm, pick('cpm'), 'up_bad'),
    };
  }

  function renderTrendHtml(trend) {
    if (!trend) return '';
    return (
      '<span class="ma-trend ma-trend-' +
      trend.tone +
      '" aria-label="Tendencia ' +
      escapeHtml(trend.arrow + ' ' + trend.label) +
      '">' +
      '<span class="ma-trend-arrow">' +
      escapeHtml(trend.arrow) +
      '</span>' +
      '<span class="ma-trend-delta">' +
      escapeHtml(trend.label) +
      '</span>' +
      '</span>'
    );
  }

  function renderKpiCard(k) {
    var cardClass = 'ma-card';
    if (k.alertHighlight) cardClass += ' ma-card-signal-alert';
    var valueClass = 'ma-mv ma-kpi-value';
    if (k.compactValue) valueClass += ' ma-kpi-value-compact';
    return (
      '<div class="' +
      cardClass +
      '">' +
      '<div class="ma-card-top">' +
      '<div class="ma-kpi-label">' +
      escapeHtml(k.label) +
      '</div>' +
      '<span class="ma-kpi-icon">' +
      k.icon +
      '</span>' +
      '</div>' +
      '<div class="ma-kpi-value-row">' +
      '<div class="' +
      valueClass +
      '" style="color:' +
      k.color +
      '">' +
      escapeHtml(k.val) +
      '</div>' +
      renderTrendHtml(k.trend) +
      '</div>' +
      '<div class="ma-kpi-sub">' +
      escapeHtml(k.sub) +
      '</div>' +
      '</div>'
    );
  }

  function renderKpiSection(title, cards, sectionMod) {
    var sectionClass = 'ma-kpi-section';
    if (sectionMod) sectionClass += ' ' + sectionMod;
    return (
      '<section class="' +
      sectionClass +
      '">' +
      '<h2 class="ma-kpi-section-title">' +
      escapeHtml(title) +
      '</h2>' +
      '<div class="ma-kpi-grid">' +
      cards.map(renderKpiCard).join('') +
      '</div>' +
      '</section>'
    );
  }

  function formatPressurePercent(ratio) {
    if (ratio === null || ratio === undefined) return null;
    var n = Number(ratio);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) + '%';
  }

  /**
   * Map auction-pressure API payload → same KPI card shape as Gasto/CTR/etc.
   * ownCpmRatio null keeps the market-only fallback (never hides the card).
   */
  function auctionPressureKpi(payload) {
    var base = {
      label: 'PRESIÓN DE SUBASTA',
      color: '#f59e0b',
      icon: '⚖️',
    };
    if (!payload) {
      return Object.assign({}, base, { val: '—', sub: 'sin datos' });
    }
    if (payload.ownCpmRatio == null) {
      var market = formatPressurePercent(payload.competitorPressureRatio);
      return Object.assign({}, base, {
        val: market || '—',
        sub: market
          ? 'actividad de mercado · CPM propio sin datos'
          : 'sin datos',
      });
    }
    var index = formatPressurePercent(payload.auctionPressureIndex);
    return Object.assign({}, base, {
      val: index || '—',
      sub: 'índice cruzado vs promedio 30d',
    });
  }

  var LIQUIDITY_PHASE_LABELS = {
    alta_demanda: 'Alta demanda',
    mitad_mes: 'Mitad de mes',
    cierre_mes: 'Cierre de mes',
  };

  function liquidityPhaseLabel(phase) {
    return LIQUIDITY_PHASE_LABELS[phase] || phase || '—';
  }

  function liquidityCycleKpi(payload) {
    var base = {
      label: 'SEMANA DE ZAFRA',
      color: '#38bdf8',
      icon: '🌾',
    };
    if (!payload || !payload.today || !payload.today.cyclePhase) {
      return Object.assign({}, base, { val: '—', sub: 'sin datos' });
    }
    var day = payload.today.dayOfMonth;
    return Object.assign({}, base, {
      val: liquidityPhaseLabel(payload.today.cyclePhase),
      sub: day ? 'día ' + day + ' del mes' : 'fase de hoy',
    });
  }

  function bcuUsuraKpi(rate) {
    var base = {
      label: 'TASA USURA BCU',
      color: '#c084fc',
      icon: '📉',
    };
    if (!rate || rate.rate_percent == null) {
      return Object.assign({}, base, { val: '—', sub: 'sin datos' });
    }
    var from = formatDateEs(rate.effective_from);
    return Object.assign({}, base, {
      val: fmt(rate.rate_percent) + '%',
      sub: from ? 'rige desde ' + from : 'tasa vigente',
    });
  }

  function normalizeChartDate(value) {
    if (value == null) return null;
    var raw = String(value).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
  }

  function destroyAuctionPressureChart() {
    if (auctionPressureChart) {
      auctionPressureChart.destroy();
      auctionPressureChart = null;
    }
  }

  function phasePointColor(phase) {
    if (phase === 'alta_demanda') return '#ef4444';
    if (phase === 'mitad_mes') return '#38bdf8';
    if (phase === 'cierre_mes') return '#a78bfa';
    return '#94a3b8';
  }

  function axisBounds(values) {
    var finite = values
      .filter(function (value) {
        return value !== null && Number.isFinite(Number(value));
      })
      .map(Number);

    var base = {
      display: false,
      grid: { drawOnChartArea: false },
    };
    if (!finite.length) return base;

    var min = Math.min.apply(Math, finite);
    var max = Math.max.apply(Math, finite);
    if (min === max) {
      if (min === 0) {
        min = -1;
        max = 1;
      } else {
        min = min * 0.9;
        max = max * 1.1;
        if (min > max) {
          var swap = min;
          min = max;
          max = swap;
        }
      }
    } else {
      var padding = (max - min) * 0.1;
      min -= padding;
      max += padding;
    }

    base.min = min;
    base.max = max;
    return base;
  }

  function checkedAttribute(seriesKey) {
    return activeSeriesToggles[seriesKey] ? ' checked' : '';
  }

  /**
   * Same fallback as the KPI card: combined index when available,
   * else competitor-only pressure when own CPM is missing.
   */
  function resolvePressureDisplay(row) {
    if (!row) return { value: null, kind: null };
    if (
      row.auction_pressure_index != null &&
      Number.isFinite(Number(row.auction_pressure_index))
    ) {
      return {
        value: Number(row.auction_pressure_index),
        kind: 'combined',
      };
    }
    if (
      row.competitor_pressure_ratio != null &&
      Number.isFinite(Number(row.competitor_pressure_ratio))
    ) {
      return {
        value: Number(row.competitor_pressure_ratio),
        kind: 'competitors',
      };
    }
    return { value: null, kind: null };
  }

  function renderAuctionPressureChartSection(payload) {
    var history =
      payload && Array.isArray(payload.history) ? payload.history : [];
    var withIndex = history.filter(function (row) {
      return (
        row &&
        (row.auction_pressure_index != null ||
          row.competitor_pressure_ratio != null)
      );
    }).length;

    var message = null;
    if (history.length < 5) {
      message =
        '💡 Todavía hay poco historial de este ciclo — el gráfico se va a ir completando con el tiempo.';
    } else if (withIndex < 5) {
      message =
        '💡 Hay historial de fechas, pero todavía pocos días con datos suficientes de Presión de Subasta para graficar una tendencia clara.';
    }

    if (message) {
      return (
        '<section class="ma-kpi-section ma-auction-pressure-chart">' +
        '<h2 class="ma-kpi-section-title">Presión de Subasta (histórico)</h2>' +
        '<div class="ma-empty">' +
        escapeHtml(message) +
        '</div></section>'
      );
    }

    return (
      '<section class="ma-kpi-section ma-auction-pressure-chart">' +
      '<h2 class="ma-kpi-section-title">Presión de Subasta (histórico)</h2>' +
      '<div class="chart-series-toggles" ' +
      'style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px">' +
      '<label><input type="checkbox" data-series="auctionIndex"' +
      checkedAttribute('auctionIndex') +
      '> Presión de Subasta</label>' +
      '<label><input type="checkbox" data-series="holidays"' +
      checkedAttribute('holidays') +
      '> Feriados</label>' +
      '<label><input type="checkbox" data-series="phase"' +
      checkedAttribute('phase') +
      '> Fase del ciclo</label>' +
      '<label><input type="checkbox" data-series="cpc"' +
      checkedAttribute('cpc') +
      '> CPC propio</label>' +
      '<label><input type="checkbox" data-series="cpl"' +
      checkedAttribute('cpl') +
      '> CPL propio</label>' +
      '<label><input type="checkbox" data-series="bcuRate"' +
      checkedAttribute('bcuRate') +
      '> Tasa usura BCU</label>' +
      '<label><input type="checkbox" data-series="totalEvents"' +
      checkedAttribute('totalEvents') +
      '> Volumen de eventos</label>' +
      '</div>' +
      '<div style="position:relative;height:320px;width:100%">' +
      '<canvas id="ma-auction-pressure-canvas"></canvas>' +
      '</div></section>'
    );
  }

  function mountAuctionPressureChart(payload) {
    destroyAuctionPressureChart();

    var canvas = document.getElementById('ma-auction-pressure-canvas');
    if (!canvas || typeof window.Chart !== 'function') return;

    var history = Array.isArray(payload && payload.history)
      ? payload.history.slice()
      : [];
    history.sort(function (a, b) {
      var left = normalizeChartDate(a && a.log_date) || '';
      var right = normalizeChartDate(b && b.log_date) || '';
      return left.localeCompare(right);
    });

    var holidayByDate = {};
    (Array.isArray(payload && payload.holidays) ? payload.holidays : [])
      .forEach(function (holiday) {
        var date = normalizeChartDate(holiday && holiday.date);
        if (date) holidayByDate[date] = holiday;
      });

    var labels = [];
    var indexValues = [];
    var pressureKinds = [];
    var holidayValues = [];
    var holidayTitles = [];
    var phaseValues = [];
    var phaseLabels = [];
    var phaseColors = [];
    var cpcValues = [];
    var cplValues = [];
    var bcuValues = [];
    var eventValues = [];

    history.forEach(function (row) {
      var date = normalizeChartDate(row && row.log_date);
      if (!date) return;
      labels.push(date);

      var pressure = resolvePressureDisplay(row);
      indexValues.push(pressure.value);
      pressureKinds.push(pressure.kind);

      var holiday = holidayByDate[date] || null;
      holidayTitles.push(holiday ? holiday.title || 'Feriado' : null);
      holidayValues.push(
        holiday && pressure.value != null ? pressure.value : null,
      );

      phaseValues.push(0.5);
      phaseLabels.push(liquidityPhaseLabel(row.cycle_phase));
      phaseColors.push(phasePointColor(row.cycle_phase));

      cpcValues.push(
        row.own_cpc != null && Number.isFinite(Number(row.own_cpc))
          ? Number(row.own_cpc)
          : null,
      );
      cplValues.push(
        row.own_cpl != null && Number.isFinite(Number(row.own_cpl))
          ? Number(row.own_cpl)
          : null,
      );
      bcuValues.push(
        row.bcu_usura_rate != null &&
        Number.isFinite(Number(row.bcu_usura_rate))
          ? Number(row.bcu_usura_rate)
          : null,
      );
      eventValues.push(
        row.total_competitor_events != null &&
        Number.isFinite(Number(row.total_competitor_events))
          ? Number(row.total_competitor_events)
          : null,
      );
    });

    var datasets = [
      {
        id: 'auctionIndex',
        label: 'Presión de Subasta',
        data: indexValues,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.15)',
        tension: 0.25,
        spanGaps: false,
        pointRadius: 3,
        yAxisID: 'y',
        hidden: !activeSeriesToggles.auctionIndex,
      },
      {
        id: 'holidays',
        label: 'Feriados',
        data: holidayValues,
        borderColor: 'transparent',
        backgroundColor: '#ef4444',
        showLine: false,
        spanGaps: false,
        pointRadius: 6,
        pointHoverRadius: 7,
        yAxisID: 'y',
        hidden: !activeSeriesToggles.holidays,
      },
      {
        id: 'phase',
        label: 'Fase del ciclo',
        data: phaseValues,
        borderColor: 'transparent',
        backgroundColor: phaseColors,
        pointBackgroundColor: phaseColors,
        showLine: false,
        spanGaps: false,
        pointRadius: 5,
        pointHoverRadius: 6,
        yAxisID: 'y1',
        hidden: !activeSeriesToggles.phase,
      },
      {
        id: 'cpc',
        label: 'CPC propio',
        data: cpcValues,
        borderColor: '#22c55e',
        backgroundColor: '#22c55e',
        tension: 0.2,
        spanGaps: false,
        pointRadius: 3,
        yAxisID: 'yCpc',
        hidden: !activeSeriesToggles.cpc,
      },
      {
        id: 'bcuRate',
        label: 'Tasa usura BCU',
        data: bcuValues,
        borderColor: '#38bdf8',
        backgroundColor: '#38bdf8',
        tension: 0.2,
        spanGaps: false,
        pointRadius: 3,
        yAxisID: 'yBcu',
        hidden: !activeSeriesToggles.bcuRate,
      },
      {
        id: 'totalEvents',
        label: 'Volumen de eventos',
        data: eventValues,
        borderColor: '#a78bfa',
        backgroundColor: '#a78bfa',
        tension: 0.2,
        spanGaps: false,
        pointRadius: 3,
        yAxisID: 'yEvents',
        hidden: !activeSeriesToggles.totalEvents,
      },
    ];

    var hasCpl = cplValues.some(function (value) {
      return value != null;
    });
    if (hasCpl) {
      datasets.push({
        id: 'cpl',
        label: 'CPL propio',
        data: cplValues,
        borderColor: '#f472b6',
        backgroundColor: '#f472b6',
        tension: 0.2,
        spanGaps: false,
        pointRadius: 3,
        yAxisID: 'yCpl',
        hidden: !activeSeriesToggles.cpl,
      });
    }

    var scales = {
      y: {
        display: true,
        title: { display: true, text: 'Índice' },
        grid: {
          color: '#2a2f3a',
          drawTicks: false,
        },
      },
      y1: {
        display: false,
        min: 0,
        max: 5,
        grid: { drawOnChartArea: false },
      },
      yCpc: axisBounds(cpcValues),
      yBcu: axisBounds(bcuValues),
      yEvents: axisBounds(eventValues),
      x: {
        grid: {
          color: '#2a2f3a',
          drawTicks: false,
        },
        ticks: {
          maxRotation: 45,
          autoSkip: true,
          maxTicksLimit: 10,
        },
      },
    };
    if (hasCpl) scales.yCpl = axisBounds(cplValues);

    auctionPressureChart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var id = ctx.dataset && ctx.dataset.id;
                var value = ctx.parsed && ctx.parsed.y;
                var index = ctx.dataIndex;

                if (id === 'auctionIndex') {
                  if (value == null) return null;
                  var pct = Math.round(value * 100) + '%';
                  if (pressureKinds[index] === 'competitors') {
                    return 'Presión (solo competidores): ' + pct;
                  }
                  return 'Presión de Subasta: ' + pct;
                }
                if (id === 'holidays') {
                  return holidayTitles[index]
                    ? 'Feriado: ' +
                        holidayTitles[index] +
                        ' (' +
                        labels[index] +
                        ')'
                    : null;
                }
                if (id === 'phase') {
                  return 'Fase: ' + (phaseLabels[index] || '—');
                }
                if (id === 'cpc') {
                  return value == null ? null : 'CPC propio: $' + fmt(value);
                }
                if (id === 'cpl') {
                  return value == null ? null : 'CPL propio: $' + fmt(value);
                }
                if (id === 'bcuRate') {
                  return value == null
                    ? null
                    : 'Tasa usura BCU: ' + fmt(value) + '%';
                }
                if (id === 'totalEvents') {
                  return value == null
                    ? null
                    : 'Eventos competidores: ' + fmt(value, 0);
                }
                return null;
              },
            },
          },
        },
        scales: scales,
      },
    });

    document
      .querySelectorAll('.chart-series-toggles [data-series]')
      .forEach(function (checkbox) {
        checkbox.addEventListener('change', function () {
          var seriesKey = checkbox.getAttribute('data-series');
          activeSeriesToggles[seriesKey] = checkbox.checked;

          if (!auctionPressureChart) return;
          var datasetIndex =
            auctionPressureChart.data.datasets.findIndex(function (dataset) {
              return dataset.id === seriesKey;
            });
          if (datasetIndex === -1) return;

          auctionPressureChart.getDatasetMeta(datasetIndex).hidden =
            !checkbox.checked;
          auctionPressureChart.update();
        });
      });
  }

  function renderLiquidityHistory(payload) {
    var rows = payload && Array.isArray(payload.history) ? payload.history : [];
    if (rows.length === 0) {
      return (
        '<section class="ma-kpi-section ma-liquidity-history">' +
        '<h2 class="ma-kpi-section-title">Historial ciclo de liquidez (30 días)</h2>' +
        '<div class="ma-empty">Sin registros todavía — el job diario irá llenando este historial</div>' +
        '</section>'
      );
    }
    return (
      '<section class="ma-kpi-section ma-liquidity-history">' +
      '<h2 class="ma-kpi-section-title">Historial ciclo de liquidez (30 días)</h2>' +
      '<div class="ma-table-wrap">' +
      '<table class="ma-table">' +
      '<thead><tr><th>Fecha</th><th>Fase</th><th>Gasto Meta</th></tr></thead>' +
      '<tbody>' +
      rows
        .map(function (r) {
          var dateLabel = formatDateEs(r.log_date) || r.log_date || '—';
          var spend =
            r.meta_spend_day !== null && r.meta_spend_day !== undefined
              ? '$' + fmt(r.meta_spend_day)
              : '—';
          return (
            '<tr>' +
            '<td>' +
            escapeHtml(dateLabel) +
            '</td>' +
            '<td>' +
            escapeHtml(liquidityPhaseLabel(r.cycle_phase)) +
            '</td>' +
            '<td>' +
            escapeHtml(spend) +
            '</td>' +
            '</tr>'
          );
        })
        .join('') +
      '</tbody></table></div></section>'
    );
  }

  function renderEventKpi(label, icon, ev) {
    var value = '—';
    var sub = 'Sin datos';
    if (ev && ev.date_start) {
      var range = formatRangeEs(ev.date_start, ev.date_end);
      if (range) {
        value = range;
        sub =
          (ev.active ? 'En curso' : 'Próximo') +
          (ev.title ? ' — ' + ev.title : '');
      }
    }
    return {
      label: label,
      icon: icon,
      val: value,
      sub: sub,
      color: '#e8eaed',
    };
  }

  function renderKpis(derived, data) {
    var avgCPL = derived.avgCPL;
    var alertas = derived.alertas;
    var latest = derived.latest || {};
    var latestSub = latest.date ? latest.date : 'sin datos';
    var trends = trendsFromData(data, latest);
    var ev = state.nextEvents || {};

    var performance = [
      {
        label: 'GASTO',
        val:
          latest.spend !== null && latest.spend !== undefined
            ? '$' + fmt(latest.spend, 0)
            : '—',
        sub: latestSub,
        color: '#3b82f6',
        icon: '💰',
        trend: trends.spend,
      },
      {
        label: 'CONVERSIONES',
        val: derived.totalConv ? fmt(derived.totalConv, 0) : '—',
        sub: derived.totalConv ? 'total acumulado' : 'sin datos',
        color: '#22c55e',
        icon: '🎯',
        trend: trends.conversions,
      },
      {
        label: 'CPL PROMEDIO',
        val: avgCPL !== null ? '$' + fmt(avgCPL) : '—',
        sub:
          avgCPL === null
            ? 'sin datos'
            : avgCPL <= 1
              ? '✓ Bajo objetivo'
              : '⚠ Sobre objetivo',
        color: avgCPL !== null && avgCPL <= 1 ? '#22c55e' : '#f59e0b',
        icon: '📉',
        trend: trends.cpl,
      },
      {
        label: 'CTR',
        val:
          latest.ctr !== null && latest.ctr !== undefined
            ? fmt(latest.ctr) + '%'
            : '—',
        sub: latestSub,
        color: '#3b82f6',
        icon: '👁',
        trend: trends.ctr,
      },
      {
        label: 'CPC',
        val:
          latest.cpc !== null && latest.cpc !== undefined
            ? '$' + fmt(latest.cpc)
            : '—',
        sub: latestSub,
        color: '#8b5cf6',
        icon: '🖱',
        trend: trends.cpc,
      },
      {
        label: 'CPM',
        val:
          latest.cpm !== null && latest.cpm !== undefined
            ? '$' + fmt(latest.cpm)
            : '—',
        sub: latestSub,
        color: '#f59e0b',
        icon: '📡',
        trend: trends.cpm,
      },
      {
        label: 'ALCANCE',
        val:
          latest.reach !== null && latest.reach !== undefined
            ? fmt(latest.reach, 0)
            : '—',
        sub:
          latest.reach !== null && latest.reach !== undefined
            ? latestSub
            : 'sin datos',
        color: '#38bdf8',
        icon: '📢',
      },
      {
        label: 'FRECUENCIA',
        val:
          latest.frequency !== null && latest.frequency !== undefined
            ? fmt(latest.frequency)
            : '—',
        sub:
          latest.frequency !== null && latest.frequency !== undefined
            ? latestSub
            : 'sin datos',
        color: '#fb7185',
        icon: '🔁',
      },
      (function () {
        var q = rankingLabel(latest.qualityRanking);
        var e = rankingLabel(latest.engagementRanking);
        var c = rankingLabel(latest.conversionRanking);
        var hasAny =
          latest.qualityRanking ||
          latest.engagementRanking ||
          latest.conversionRanking;
        return {
          label: 'RANKING DE CALIDAD',
          val:
            'Calidad: ' +
            q +
            ' · Engagement: ' +
            e +
            ' · Conversión: ' +
            c,
          sub: hasAny ? latestSub : 'sin datos',
          color: '#a78bfa',
          icon: '🏆',
          compactValue: true,
        };
      })(),
    ];

    var context = [
      renderEventKpi('FERIADO', '📅', ev.nextHoliday),
      renderEventKpi('PAGO BPS', '🏦', ev.nextBpsPayment),
      auctionPressureKpi(state.auctionPressure),
      liquidityCycleKpi(state.liquidityCycle),
      bcuUsuraKpi(state.bcuUsuraRate),
      {
        label: 'ALERTAS',
        val: String(alertas.length),
        sub: alertas.length === 0 ? 'Sin alertas' : 'Requieren atención',
        color: alertas.length === 0 ? '#22c55e' : '#ef4444',
        icon: alertas.length === 0 ? '✅' : '🚨',
        alertHighlight: alertas.length > 0,
      },
    ];

    return (
      renderKpiSection(
        'Performance Publicitaria',
        performance,
        'ma-kpi-section-performance',
      ) +
      renderAuctionPressureChartSection(state.liquidityCycle) +
      renderKpiSection(
        'Contexto y Señales',
        context,
        'ma-kpi-section-context',
      ) +
      renderLiquidityHistory(state.liquidityCycle)
    );
  }

  function renderSubTabs(alertCount) {
    var tabs = [
      ['campaigns', '📊 Campañas'],
      ['alerts', '🚨 Alertas (' + alertCount + ')'],
      ['raw', '📋 Datos'],
    ];
    return (
      '<div class="ma-subtabs">' +
      tabs
        .map(function (t) {
          var id = t[0];
          var label = t[1];
          var active = state.tab === id ? ' active' : '';
          return (
            '<div class="ma-tab' +
            active +
            '" data-ma-tab="' +
            id +
            '">' +
            escapeHtml(label) +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function renderCampaigns(campList, totalGasto, totalConv) {
    if (campList.length === 0) {
      return '<div class="ma-fade"><div class="ma-empty">No se encontraron campañas</div></div>';
    }

    return (
      '<div class="ma-fade">' +
      campList
        .map(function (c) {
          var hasAlert = campaignHasAlert(c);
          var metrics = [
            {
              label: 'CPL',
              val: c.cpl !== null ? '$' + fmt(c.cpl) : '—',
              warn: c.cpl !== null && c.cpl > 1,
              bar: c.cpl,
              max: 5,
              color: c.cpl !== null && c.cpl > 1 ? '#ef4444' : '#22c55e',
            },
            {
              label: 'CTR',
              val: c.ctr !== null ? fmt(c.ctr) + '%' : '—',
              warn: c.ctr !== null && c.ctr < 1,
              bar: c.ctr,
              max: 10,
              color: c.ctr !== null && c.ctr < 1 ? '#f59e0b' : '#3b82f6',
            },
            {
              label: 'CPC',
              val: c.cpc !== null ? '$' + fmt(c.cpc) : '—',
              warn: false,
              bar: c.cpc,
              max: 5,
              color: '#8b5cf6',
            },
            {
              label: 'FREC.',
              val: c.frecuencia !== null ? fmt(c.frecuencia, 1) : '—',
              warn: c.frecuencia !== null && c.frecuencia > 4.5,
              bar: c.frecuencia,
              max: 10,
              color: c.frecuencia !== null && c.frecuencia > 4.5 ? '#ef4444' : '#22c55e',
            },
            {
              label: 'GASTO',
              val: c.gasto !== null ? '$' + fmt(c.gasto, 0) : '—',
              warn: false,
              bar: c.gasto,
              max: totalGasto || 1,
              color: '#f59e0b',
            },
            {
              label: 'CONV.',
              val: c.conversiones !== null ? fmt(c.conversiones, 0) : '—',
              warn: false,
              bar: c.conversiones,
              max: totalConv || 1,
              color: '#22c55e',
            },
          ];

          return (
            '<div class="ma-row-card">' +
            '<div class="ma-row-top">' +
            '<div class="ma-row-title">' +
            '<span class="ma-status-dot" style="color:' +
            (hasAlert ? '#ef4444' : '#22c55e') +
            '">●</span>' +
            '<span class="ma-camp-name">' +
            escapeHtml(c.name) +
            '</span>' +
            (hasAlert ? '<span class="ma-ab">⚠ ALERTA</span>' : '') +
            '</div>' +
            '<div class="ma-dias">' +
            c.dias +
            ' DÍA' +
            (c.dias !== 1 ? 'S' : '') +
            '</div>' +
            '</div>' +
            '<div class="ma-metrics">' +
            metrics
              .map(function (m) {
                return (
                  '<div>' +
                  '<div class="ma-metric-label">' +
                  escapeHtml(m.label) +
                  '</div>' +
                  '<div class="ma-mv ma-metric-val" style="color:' +
                  (m.warn ? '#ef4444' : '#e2e8f0') +
                  '">' +
                  escapeHtml(m.val) +
                  '</div>' +
                  sparkbarHtml(m.bar, m.max, m.color) +
                  '</div>'
                );
              })
              .join('') +
            '</div>' +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function renderAlerts(alertas) {
    if (alertas.length === 0) {
      return (
        '<div class="ma-fade">' +
        '<div class="ma-all-clear">' +
        '<div class="ma-all-clear-icon">✅</div>' +
        '<div class="ma-all-clear-title">TODO EN ORDEN</div>' +
        '</div>' +
        '</div>'
      );
    }

    return (
      '<div class="ma-fade">' +
      alertas
        .map(function (c) {
          var chips = '';
          if (c.frecuencia !== null && c.frecuencia > 4.5) {
            chips +=
              '<div class="ma-alert-chip ma-alert-chip-red">' +
              '<div class="ma-alert-chip-label">⚡ FRECUENCIA ALTA</div>' +
              '<div class="ma-mv ma-alert-chip-val" style="color:#ef4444">' +
              escapeHtml(fmt(c.frecuencia, 1)) +
              '</div>' +
              '<div class="ma-alert-chip-hint">Renovar creatividades urgente</div>' +
              '</div>';
          }
          if (c.cpl !== null && c.cpl > 1.5) {
            chips +=
              '<div class="ma-alert-chip ma-alert-chip-red">' +
              '<div class="ma-alert-chip-label">📉 CPL ALTO</div>' +
              '<div class="ma-mv ma-alert-chip-val" style="color:#ef4444">$' +
              escapeHtml(fmt(c.cpl)) +
              '</div>' +
              '<div class="ma-alert-chip-hint">Revisar audiencia y landing</div>' +
              '</div>';
          }
          if (c.ctr !== null && c.ctr < 1) {
            chips +=
              '<div class="ma-alert-chip ma-alert-chip-amber">' +
              '<div class="ma-alert-chip-label">👁 CTR BAJO</div>' +
              '<div class="ma-mv ma-alert-chip-val" style="color:#f59e0b">' +
              escapeHtml(fmt(c.ctr)) +
              '%</div>' +
              '<div class="ma-alert-chip-hint">Cambiar creatividad urgente</div>' +
              '</div>';
          }
          return (
            '<div class="ma-card ma-card-alert">' +
            '<div class="ma-alert-name">' +
            escapeHtml(c.name) +
            '</div>' +
            '<div class="ma-alert-chips">' +
            chips +
            '</div>' +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function renderRaw(data) {
    var headers = data.length > 0 ? Object.keys(data[0]) : [];
    var rows = data.slice(0, 50);
    return (
      '<div class="ma-fade ma-table-wrap">' +
      '<table class="ma-table">' +
      '<thead><tr>' +
      headers
        .map(function (h) {
          return '<th>' + escapeHtml(h) + '</th>';
        })
        .join('') +
      '</tr></thead>' +
      '<tbody>' +
      rows
        .map(function (row) {
          return (
            '<tr>' +
            Object.values(row)
              .map(function (val) {
                return '<td>' + escapeHtml(val || '—') + '</td>';
              })
              .join('') +
            '</tr>'
          );
        })
        .join('') +
      '</tbody>' +
      '</table>' +
      '</div>'
    );
  }

  function renderFooter(data) {
    return (
      '<div class="ma-footer">' +
      '<span>SUPERAGENTE META ADS</span>' +
      '<span>' +
      data.length +
      ' REGISTROS · CPL OBJETIVO $1.00</span>' +
      '<span>AUTO-REFRESH 5MIN</span>' +
      '</div>'
    );
  }

  var MONTH_NAMES_ES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre',
  ];

  function splitDateOnly(dateStr) {
    if (!dateStr) return null;
    var parts = String(dateStr).split('-');
    if (parts.length !== 3) return null;
    var month = Number(parts[1]);
    var day = Number(parts[2]);
    if (!month || !day || month < 1 || month > 12) return null;
    return { month: month, day: day };
  }

  /** '2026-07-18' → '18 de julio'. Invalid/missing → null. */
  function formatDateEs(dateStr) {
    var p = splitDateOnly(dateStr);
    return p ? p.day + ' de ' + MONTH_NAMES_ES[p.month - 1] : null;
  }

  /** Compact range: same month → '2 al 22 de julio'; else full both ends. */
  function formatRangeEs(startStr, endStr) {
    var start = splitDateOnly(startStr);
    if (!start) return null;
    var end = splitDateOnly(endStr);
    if (!end || (start.month === end.month && start.day === end.day)) {
      return formatDateEs(startStr);
    }
    if (start.month === end.month) {
      return start.day + ' al ' + end.day + ' de ' + MONTH_NAMES_ES[start.month - 1];
    }
    return formatDateEs(startStr) + ' al ' + formatDateEs(endStr);
  }

  function renderBody(derived) {
    var tabContent = '';
    if (state.tab === 'campaigns') {
      tabContent = renderCampaigns(derived.campList, derived.totalGasto, derived.totalConv);
    } else if (state.tab === 'alerts') {
      tabContent = renderAlerts(derived.alertas);
    } else {
      tabContent = renderRaw(state.data);
    }

    return (
      '<div class="ma-body">' +
      renderKpis(derived, state.data) +
      renderSubTabs(derived.alertas.length) +
      tabContent +
      renderFooter(state.data) +
      '</div>'
    );
  }

  function render() {
    if (!root) return;

    destroyAuctionPressureChart();

    var derived = computeDerived(state.data);
    var html = '<div class="ma-shell">' + renderHeader(derived.alertas);

    if (state.configMissing) {
      html += renderConfigMissing();
    } else if (state.loading) {
      html += renderLoading();
    } else if (state.error) {
      html += renderError();
    } else {
      html += renderBody(derived);
    }

    html += '</div>';
    root.innerHTML = html;
    bindEvents();
    if (!state.configMissing && !state.loading && !state.error) {
      mountAuctionPressureChart(state.liquidityCycle);
    }
  }

  function bindEvents() {
    if (!root) return;

    root.querySelectorAll('[data-ma-action]').forEach(function (el) {
      el.addEventListener('click', function () {
        var action = el.getAttribute('data-ma-action');
        if (action === 'sync' || action === 'retry') {
          loadData();
        }
      });
    });

    root.querySelectorAll('[data-ma-tab]').forEach(function (el) {
      el.addEventListener('click', function () {
        var tab = el.getAttribute('data-ma-tab');
        if (tab && tab !== state.tab) {
          state.tab = tab;
          render();
        }
      });
    });
  }

  async function loadData() {
    var cfg = resolveDatasourceConfig();
    if (!isDatasourceConfigured(cfg)) {
      state.configMissing = true;
      state.loading = false;
      state.error = CONFIG_ERROR_MSG;
      state.data = [];
      render();
      return;
    }

    state.configMissing = false;
    state.loading = true;
    state.error = null;
    render();
    try {
      var rawRows = await fetchOwnAdMetricsRows(cfg);
      // Normalize types to CSV-compat strings before any business logic.
      var parsed = rawRows.map(mapOwnAdMetricsToLegacyRow);
      state.data = parsed;
      state.lastUpdate = new Date().toLocaleTimeString('es-AR');
      state.error = null;
    } catch (e) {
      state.error = 'No se pudo conectar con Supabase.';
    }
    state.loading = false;
    render();
    loadNextEvents();
    loadAuctionPressure();
    loadLiquidityCycle();
    loadBcuUsuraRate();
  }

  /**
   * Economic calendar card — isolated fetch against the backend (relative
   * path; same-origin as the dashboard). Any failure leaves nulls in place,
   * which render as "Sin datos"; it never breaks the metrics panel.
   */
  async function loadNextEvents() {
    var base = window.location.protocol === 'file:'
      ? 'https://mie-backend-production.up.railway.app'
      : '';
    try {
      var res = await fetch(base + '/reports/next-economic-events', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      var body = await res.json();
      if (!body || typeof body !== 'object') return;
      state.nextEvents = {
        nextHoliday: body.nextHoliday || null,
        nextBpsPayment: body.nextBpsPayment || null,
      };
      render();
    } catch (e) {
      // Keep nulls → "Sin datos".
    }
  }

  /**
   * Auction pressure KPI — same-origin backend. Failures leave null
   * (card shows "sin datos"); never blocks the Own Ads panel.
   */
  async function loadAuctionPressure() {
    var base = window.location.protocol === 'file:'
      ? 'https://mie-backend-production.up.railway.app'
      : '';
    try {
      var res = await fetch(base + '/reports/auction-pressure', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      var body = await res.json();
      if (!body || typeof body !== 'object') return;
      state.auctionPressure = body;
      render();
    } catch (e) {
      // Keep null → "sin datos".
    }
  }

  /**
   * Liquidity cycle — today's phase + 30-day spend history. Failures leave
   * null (card/historial show sin datos); never blocks Own Ads panel.
   */
  async function loadLiquidityCycle() {
    var base = window.location.protocol === 'file:'
      ? 'https://mie-backend-production.up.railway.app'
      : '';
    try {
      var res = await fetch(base + '/api/liquidity-cycle/history', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      var body = await res.json();
      if (!body || typeof body !== 'object') return;
      state.liquidityCycle = body;
      render();
    } catch (e) {
      // Keep null → "sin datos".
    }
  }

  /**
   * Current BCU usura rate — informational only. 404 / failures → "sin datos".
   */
  async function loadBcuUsuraRate() {
    var base = window.location.protocol === 'file:'
      ? 'https://mie-backend-production.up.railway.app'
      : '';
    try {
      var res = await fetch(base + '/api/bcu-usura-rate/current', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      var body = await res.json();
      if (!body || typeof body !== 'object' || !body.rate) return;
      state.bcuUsuraRate = body.rate;
      render();
    } catch (e) {
      // Keep null → "sin datos".
    }
  }

  function init() {
    root = document.getElementById('meta-ads-root');
    if (!root) return;

    var cfg = resolveDatasourceConfig();
    if (!isDatasourceConfigured(cfg)) {
      // Controlled interrupt: do not call Supabase; leave MIC tab unaffected.
      state.configMissing = true;
      state.loading = false;
      state.error = CONFIG_ERROR_MSG;
      state.data = [];
      render();
      return;
    }

    loadData();
    if (refreshTimerId) clearInterval(refreshTimerId);
    refreshTimerId = setInterval(loadData, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
