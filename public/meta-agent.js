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
      '&select=entity_id,campaign_id,campaign_name,metric_date,spend,impressions,clicks,actions,actions_value,frequency,created_at' +
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

  /**
   * Deterministic account-level aggregates for the latest available
   * metric_date. Null-safety: no rows / zero denominator → null (never 0,
   * Infinity or NaN). ctr is returned as a percentage for this panel's
   * existing display convention (fmt(x) + '%').
   */
  function computeLatestDateStats(data) {
    var latestDate = null;
    data.forEach(function (row) {
      var d = row.metric_date || '';
      if (d && (!latestDate || d > latestDate)) latestDate = d;
    });

    if (!latestDate) {
      return { date: null, spend: null, ctr: null, cpc: null, cpm: null };
    }

    var spend = null;
    var impressions = null;
    var clicks = null;
    data.forEach(function (row) {
      if ((row.metric_date || '') !== latestDate) return;
      var s = fmtN(row.spend);
      var i = fmtN(row.impressions);
      var c = fmtN(row.clicks);
      if (s !== null) spend = (spend || 0) + s;
      if (i !== null) impressions = (impressions || 0) + i;
      if (c !== null) clicks = (clicks || 0) + c;
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

    return { date: latestDate, spend: spend, ctr: ctr, cpc: cpc, cpm: cpm };
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
      '<div class="ma-header-left">' +
      '<div class="ma-logo">⚡</div>' +
      '<div>' +
      '<div class="ma-brand">META ADS AGENT</div>' +
      '<div class="ma-brand-sub">POWERED BY CLAUDE AI</div>' +
      '</div>' +
      '</div>' +
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

  function renderKpis(derived, data) {
    var avgCPL = derived.avgCPL;
    var alertas = derived.alertas;
    var latest = derived.latest || {};
    var latestSub = latest.date ? latest.date : 'sin datos';
    var kpis = [
      {
        label: 'GASTO',
        val: latest.spend !== null && latest.spend !== undefined
          ? '$' + fmt(latest.spend, 0)
          : '—',
        sub: latestSub,
        color: '#3b82f6',
        icon: '💰',
      },
      {
        label: 'CONVERSIONES',
        val: derived.totalConv ? fmt(derived.totalConv, 0) : '—',
        sub: derived.totalConv ? 'total acumulado' : 'sin datos',
        color: '#22c55e',
        icon: '🎯',
      },
      {
        label: 'CPL PROMEDIO',
        val: avgCPL !== null ? '$' + fmt(avgCPL) : '—',
        sub: avgCPL === null
          ? 'sin datos'
          : avgCPL <= 1
            ? '✓ Bajo objetivo'
            : '⚠ Sobre objetivo',
        color: avgCPL !== null && avgCPL <= 1 ? '#22c55e' : '#f59e0b',
        icon: '📉',
      },
      {
        label: 'ALERTAS',
        val: String(alertas.length),
        sub: alertas.length === 0 ? 'Sin alertas' : 'Requieren atención',
        color: alertas.length === 0 ? '#22c55e' : '#ef4444',
        icon: alertas.length === 0 ? '✅' : '🚨',
      },
      {
        label: 'CTR',
        val: latest.ctr !== null && latest.ctr !== undefined ? fmt(latest.ctr) + '%' : '—',
        sub: latestSub,
        color: '#3b82f6',
        icon: '👁',
      },
      {
        label: 'CPC',
        val: latest.cpc !== null && latest.cpc !== undefined ? '$' + fmt(latest.cpc) : '—',
        sub: latestSub,
        color: '#8b5cf6',
        icon: '🖱',
      },
      {
        label: 'CPM',
        val: latest.cpm !== null && latest.cpm !== undefined ? '$' + fmt(latest.cpm) : '—',
        sub: latestSub,
        color: '#f59e0b',
        icon: '📡',
      },
    ];

    return (
      '<div class="ma-kpi-grid ma-fade">' +
      kpis
        .map(function (k) {
          return (
            '<div class="ma-card">' +
            '<div class="ma-card-top">' +
            '<div class="ma-kpi-label">' +
            escapeHtml(k.label) +
            '</div>' +
            '<span class="ma-kpi-icon">' +
            k.icon +
            '</span>' +
            '</div>' +
            '<div class="ma-mv ma-kpi-value" style="color:' +
            k.color +
            '">' +
            escapeHtml(k.val) +
            '</div>' +
            '<div class="ma-kpi-sub">' +
            escapeHtml(k.sub) +
            '</div>' +
            '</div>'
          );
        })
        .join('') +
      '</div>'
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

  function renderEventCard(label, icon, ev) {
    var value = '—';
    var sub = 'Sin datos';
    if (ev && ev.date_start) {
      var range = formatRangeEs(ev.date_start, ev.date_end);
      if (range) {
        value = range;
        sub = (ev.active ? 'En curso' : 'Próximo') +
          (ev.title ? ' — ' + ev.title : '');
      }
    }
    return (
      '<div class="ma-card">' +
      '<div class="ma-card-top">' +
      '<div class="ma-kpi-label">' + escapeHtml(label) + '</div>' +
      '<span class="ma-kpi-icon">' + icon + '</span>' +
      '</div>' +
      '<div class="ma-mv ma-kpi-value ma-event-value">' +
      escapeHtml(value) +
      '</div>' +
      '<div class="ma-kpi-sub">' + escapeHtml(sub) + '</div>' +
      '</div>'
    );
  }

  function renderNextEvents() {
    var ev = state.nextEvents || {};
    return (
      '<div class="ma-kpi-grid ma-next-events">' +
      renderEventCard('FERIADO', '📅', ev.nextHoliday) +
      renderEventCard('PAGO BPS', '🏦', ev.nextBpsPayment) +
      '</div>'
    );
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
      renderNextEvents() +
      renderSubTabs(derived.alertas.length) +
      tabContent +
      renderFooter(state.data) +
      '</div>'
    );
  }

  function render() {
    if (!root) return;

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
