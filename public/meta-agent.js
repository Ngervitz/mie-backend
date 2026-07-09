/**
 * Meta Ads Agent — vanilla port of metaagent2/src/App.jsx
 * Encapsulated IIFE: no globals collide with mie-dashboard.js.
 */
(function () {
  'use strict';

  var SHEET_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ1AabqPmRBVR6J8trdM50_F5Nnw4tBFPoT1Fk-9PnLC5iz9T15lnSjNe4J21IW6CIKDXmkbzxmg6PK/pub?gid=0&single=true&output=csv';

  var state = {
    data: [],
    loading: true,
    error: null,
    tab: 'campaigns',
    lastUpdate: null,
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

  function parseCSV(text) {
    var lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    var headers = lines[0].split(',').map(function (h) {
      return h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[()]/g, '');
    });
    return lines
      .slice(1)
      .map(function (line) {
        var values = line.split(',');
        var obj = {};
        headers.forEach(function (h, i) {
          obj[h] = (values[i] && values[i].trim()) || '';
        });
        return obj;
      })
      .filter(function (row) {
        return Object.values(row).some(function (v) {
          return v !== '';
        });
      });
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
    };
  }

  function renderLoading() {
    return (
      '<div class="ma-state">' +
      '<div class="ma-state-title ma-pulse">CARGANDO</div>' +
      '<div class="ma-state-sub">CONECTANDO CON GOOGLE SHEETS</div>' +
      '<div class="ma-state-hint">Cargando datos de Meta Ads...</div>' +
      '</div>'
    );
  }

  function renderError() {
    return (
      '<div class="ma-state">' +
      '<div class="ma-state-icon">⚠️</div>' +
      '<div class="ma-state-error">' +
      escapeHtml(state.error || 'Error al conectar con Google Sheets') +
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
    var kpis = [
      {
        label: 'GASTO TOTAL',
        val: '$' + fmt(derived.totalGasto, 0),
        sub: data.length + ' registros',
        color: '#3b82f6',
        icon: '💰',
      },
      {
        label: 'CONVERSIONES',
        val: derived.totalConv ? fmt(derived.totalConv, 0) : '—',
        sub: 'total acumulado',
        color: '#22c55e',
        icon: '🎯',
      },
      {
        label: 'CPL PROMEDIO',
        val: avgCPL !== null ? '$' + fmt(avgCPL) : '—',
        sub: avgCPL !== null && avgCPL <= 1 ? '✓ Bajo objetivo' : '⚠ Sobre objetivo',
        color: avgCPL !== null && avgCPL <= 1 ? '#22c55e' : '#f59e0b',
        icon: '📉',
      },
      {
        label: 'ALERTAS',
        val: String(alertas.length),
        sub: alertas.length === 0 ? 'Todo en orden' : 'Requieren atención',
        color: alertas.length === 0 ? '#22c55e' : '#ef4444',
        icon: alertas.length === 0 ? '✅' : '🚨',
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

    var derived = computeDerived(state.data);
    var html = '<div class="ma-shell">' + renderHeader(derived.alertas);

    if (state.loading) {
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
    state.loading = true;
    state.error = null;
    render();
    try {
      var res = await fetch(SHEET_URL);
      if (!res.ok) throw new Error('Error al cargar');
      var text = await res.text();
      var parsed = parseCSV(text);
      state.data = parsed;
      state.lastUpdate = new Date().toLocaleTimeString('es-AR');
      state.error = null;
    } catch (e) {
      state.error = 'No se pudo conectar con Google Sheets.';
    }
    state.loading = false;
    render();
  }

  function init() {
    root = document.getElementById('meta-ads-root');
    if (!root) return;
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
