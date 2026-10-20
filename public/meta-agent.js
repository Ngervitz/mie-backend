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
  /** Insights conversions type for pixel event form_step_3. Not the aggregate fb_pixel_custom. */
  var META_CPL_ACTION_TYPE = 'offsite_conversion.fb_pixel_custom.form_step_3';
  var ACCOUNT_TIME_ZONE = 'America/Montevideo';

  var CONFIG_ERROR_MSG = 'Falta configuración de datasource.';

  var state = {
    data: [],
    loading: true,
    error: null,
    tab: 'campaigns',
    lastUpdate: null,
    /** today | yesterday | 7d | 30d | custom — America/Montevideo calendar dates */
    periodPreset: 'today',
    customFrom: '',
    customTo: '',
    configMissing: false,
    // Read-only economic calendar card; null fields render "Sin datos".
    nextEvents: { nextHoliday: null, nextBpsPayment: null },
    // Auction pressure from GET /reports/auction-pressure; null → "sin datos".
    auctionPressure: null,
    // Liquidity cycle: { today, history } from GET /api/liquidity-cycle/history.
    liquidityCycle: null,
    // History list only. Starts collapsed; KPI cards stay visible.
    liquidityListOpen: false,
    // Current BCU usura rate from GET /api/bcu-usura-rate/current.
    bcuUsuraRate: null,
    /** Ad-level rows from own_ad_ad_metrics (legacy-mapped). */
    adData: [],
    adDataError: null,
    /** campaign_id → true when ad list is expanded */
    expandedCampaignIds: {},
    /** ad expand key → true when platform detail is expanded */
    expandedPlatformAdIds: {},
    /** Aggregated CZ ↔ Meta attribution from GET /api/meta-agent/cz-attribution. */
    czAttribution: null,
    czAttributionError: null,
    czAttributionLoading: false,
  };

  function resolveCzAttributionApi() {
    if (typeof require === 'function') {
      try {
        return require('../src/lib/metaAgentCzAttribution');
      } catch (ignore) {}
    }
    if (typeof window !== 'undefined' && window.__META_AGENT_CZ_ATTRIBUTION__) {
      return window.__META_AGENT_CZ_ATTRIBUTION__;
    }
    return null;
  }

  var CZ = resolveCzAttributionApi();

  if (!CZ) {
    CZ = {
      CZ_ATTRIBUTION_BUCKETS: {
        META_AD_ATTRIBUTED: 'meta_ad_attributed',
        META_AD_PENDING: 'meta_ad_pending',
        META_NO_AD: 'meta_no_ad',
        UNKNOWN_ORIGIN: 'unknown_origin',
        OTHER_CHANNEL: 'other_channel',
      },
      attachCzStatsToAdList: function (adList, byAdId) {
        return (adList || []).map(function (ad) {
          var stats =
            (byAdId && ad.ad_id != null && byAdId[String(ad.ad_id)]) || null;
          var czSolicitudes = stats ? stats.solicitudCount : 0;
          var gasto = ad.gasto;
          var cplCz =
            gasto !== null && gasto !== undefined && czSolicitudes > 0
              ? gasto / czSolicitudes
              : null;
          return Object.assign({}, ad, {
            czSolicitudes: czSolicitudes,
            czUniqueCi: stats ? stats.uniqueCi : 0,
            czPreaprobados: stats ? stats.preaprobadosCount || 0 : 0,
            czGranted: stats ? stats.grantedCount || 0 : 0,
            cplCz: cplCz,
            cplCzSinSolicitudes: czSolicitudes === 0,
            costPerPreaprob: null,
            costPerGranted: null,
          });
        });
      },
      formatPlatformLabel: function (p) {
        return p || 'Sin datos';
      },
    };
  }

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

  /** USD display only — always two decimals; does not alter stored metrics. */
  function fmtUsd(val) {
    var n = parseFloat(val);
    return isNaN(n) ? '—' : n.toFixed(2);
  }

  function fmtN(val) {
    var n = parseFloat(val);
    return isNaN(n) ? null : n;
  }

  function shiftIsoDate(dateStr, deltaDays) {
    var parts = String(dateStr).split('-').map(Number);
    var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().split('T')[0];
  }

  function calendarDateInZone(now) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: ACCOUNT_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now || new Date());
    } catch (e) {
      return null;
    }
  }

  function isValidDateOnly(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  }

  /**
   * Resolve inclusive [from, to] metric_date bounds for the selected preset (UY).
   */
  function resolvePeriodRange(preset, customFrom, customTo, now) {
    var today = calendarDateInZone(now);
    if (!today) {
      return { from: null, to: null, preset: preset || '7d' };
    }
    var p = preset || '7d';
    var from = today;
    var to = today;
    if (p === 'today') {
      from = today;
      to = today;
    } else if (p === 'yesterday') {
      from = shiftIsoDate(today, -1);
      to = from;
    } else if (p === '30d') {
      from = shiftIsoDate(today, -29);
      to = today;
    } else if (p === 'custom') {
      var cf = isValidDateOnly(customFrom) ? String(customFrom) : null;
      var ct = isValidDateOnly(customTo) ? String(customTo) : null;
      if (cf && ct) {
        from = cf <= ct ? cf : ct;
        to = cf <= ct ? ct : cf;
      } else {
        from = shiftIsoDate(today, -6);
        to = today;
        p = '7d';
      }
    } else {
      from = shiftIsoDate(today, -6);
      to = today;
      p = '7d';
    }
    return { from: from, to: to, preset: p };
  }

  function enumerateInclusiveDates(from, to) {
    var out = [];
    if (!from || !to || from > to) return out;
    var cur = from;
    while (cur <= to) {
      out.push(cur);
      cur = shiftIsoDate(cur, 1);
    }
    return out;
  }

  function filterRowsByMetricDate(rows, from, to) {
    if (!from || !to) return rows || [];
    return (rows || []).filter(function (row) {
      var d = row.metric_date || '';
      return d && d >= from && d <= to;
    });
  }

  /** DISTINCT ON (campaign_id, metric_date) — keep newest created_at per key. */
  function dedupeRowsByCampaignDate(rows) {
    var byKey = {};
    (rows || []).forEach(function (row) {
      var cid =
        row.campaign_id != null && String(row.campaign_id) !== ''
          ? String(row.campaign_id)
          : String(row.campaign_name || row.campana || '');
      var d = row.metric_date || '';
      var key = cid + '\u0000' + d;
      var created = row.created_at != null ? String(row.created_at) : '';
      if (!byKey[key] || created > (byKey[key].created_at || '')) {
        byKey[key] = row;
      }
    });
    return Object.keys(byKey).map(function (k) {
      return byKey[k];
    });
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

  function countExactActionType(list) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      var action = list[i];
      if (!action || action.action_type !== META_CPL_ACTION_TYPE) continue;
      var n = parseFloat(action.value);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  /**
   * form_step_3 count. The conversions array wins so the aggregate custom-pixel
   * bucket in actions is not added again. Null if that exact type is absent.
   */
  function metaLeadCountFromInsight(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var fromConversions = countExactActionType(raw.conversions);
    if (fromConversions !== null) return fromConversions;
    return countExactActionType(raw.actions);
  }

  function metaLeadsFromRow(row) {
    if (!row) return null;
    if (row.meta_leads !== '' && row.meta_leads != null) {
      var fromCol = fmtN(row.meta_leads);
      if (fromCol !== null) return fromCol;
    }
    return metaLeadCountFromInsight(row.raw_json);
  }

  function aggregateAccountPeriod(rows) {
    var spend = 0;
    var impressions = 0;
    var clicks = 0;
    var leads = 0;
    var hasSpend = false;
    var hasImpressions = false;
    var hasClicks = false;
    var hasLeads = false;

    (rows || []).forEach(function (row) {
      var s = fmtN(row.spend != null ? row.spend : row.gasto);
      var i = fmtN(row.impressions);
      var c = fmtN(row.clicks);
      var l = metaLeadsFromRow(row);
      if (s !== null) {
        spend += s;
        hasSpend = true;
      }
      if (i !== null) {
        impressions += i;
        hasImpressions = true;
      }
      if (c !== null) {
        clicks += c;
        hasClicks = true;
      }
      if (l !== null) {
        leads += l;
        hasLeads = true;
      }
    });

    var spendOut = hasSpend ? spend : null;
    var impressionsOut = hasImpressions ? impressions : null;
    var clicksOut = hasClicks ? clicks : null;
    var leadsOut = hasLeads ? leads : null;

    var ctr =
      impressionsOut !== null && impressionsOut > 0 && clicksOut !== null
        ? (clicksOut / impressionsOut) * 100
        : null;
    var cpc =
      clicksOut !== null && clicksOut > 0 && spendOut !== null
        ? spendOut / clicksOut
        : null;
    var cpm =
      impressionsOut !== null && impressionsOut > 0 && spendOut !== null
        ? (spendOut / impressionsOut) * 1000
        : null;
    var cpl =
      leadsOut !== null && leadsOut > 0 && spendOut !== null
        ? spendOut / leadsOut
        : null;

    return {
      spend: spendOut,
      impressions: impressionsOut,
      clicks: clicksOut,
      leads: leadsOut,
      ctr: ctr,
      cpc: cpc,
      cpm: cpm,
      cpl: cpl,
      reach: null,
      frequency: null,
      qualityRanking: null,
      engagementRanking: null,
      conversionRanking: null,
      date: null,
    };
  }

  function buildCampListByCampaignId(rows) {
    var campaigns = {};
    (rows || []).forEach(function (row) {
      var cid =
        row.campaign_id != null && String(row.campaign_id) !== ''
          ? String(row.campaign_id)
          : '__unknown__';
      if (!campaigns[cid]) {
        campaigns[cid] = {
          campaign_id: cid === '__unknown__' ? null : cid,
          name: findVal(row, 'campana', 'campaign') || 'Sin nombre',
          rowDays: {},
          spend: 0,
          impressions: 0,
          clicks: 0,
          leads: 0,
          hasSpend: false,
          hasImpressions: false,
          hasClicks: false,
          hasLeads: false,
        };
      }
      var c = campaigns[cid];
      var d = row.metric_date || '';
      if (d) c.rowDays[d] = true;
      var s = fmtN(row.spend != null ? row.spend : row.gasto);
      var i = fmtN(row.impressions);
      var cl = fmtN(row.clicks);
      var l = metaLeadsFromRow(row);
      if (s !== null) {
        c.spend += s;
        c.hasSpend = true;
      }
      if (i !== null) {
        c.impressions += i;
        c.hasImpressions = true;
      }
      if (cl !== null) {
        c.clicks += cl;
        c.hasClicks = true;
      }
      if (l !== null) {
        c.leads += l;
        c.hasLeads = true;
      }
    });

    return Object.keys(campaigns).map(function (key) {
      var c = campaigns[key];
      var gasto = c.hasSpend ? c.spend : null;
      var impressions = c.hasImpressions ? c.impressions : null;
      var clicks = c.hasClicks ? c.clicks : null;
      var conversiones = c.hasLeads ? c.leads : null;
      var ctr =
        impressions !== null && impressions > 0 && clicks !== null
          ? (clicks / impressions) * 100
          : null;
      var cpc =
        clicks !== null && clicks > 0 && gasto !== null ? gasto / clicks : null;
      var cpl =
        conversiones !== null && conversiones > 0 && gasto !== null
          ? gasto / conversiones
          : null;
      var dias = Object.keys(c.rowDays).length;
      return {
        campaign_id: c.campaign_id,
        name: c.name,
        dias: dias,
        gasto: gasto,
        impressions: impressions,
        clicks: clicks,
        conversiones: conversiones,
        cpl: cpl,
        cplSinConversiones: !(conversiones !== null && conversiones > 0),
        ctr: ctr,
        cpc: cpc,
        frecuencia: null,
        alcance: null,
      };
    });
  }

  function dedupeRowsByAdDate(rows) {
    var byKey = {};
    (rows || []).forEach(function (row) {
      var aid =
        row.ad_id != null && String(row.ad_id) !== ''
          ? String(row.ad_id)
          : '';
      if (!aid) return;
      var d = row.metric_date || '';
      var key = aid + '\u0000' + d;
      var created = row.created_at != null ? String(row.created_at) : '';
      if (!byKey[key] || created > (byKey[key].created_at || '')) {
        byKey[key] = row;
      }
    });
    return Object.keys(byKey).map(function (k) {
      return byKey[k];
    });
  }

  function buildAdListByAdId(rows) {
    var ads = {};
    (rows || []).forEach(function (row) {
      var aid =
        row.ad_id != null && String(row.ad_id) !== ''
          ? String(row.ad_id)
          : '__unknown__';
      if (aid === '__unknown__') return;
      if (!ads[aid]) {
        ads[aid] = {
          ad_id: aid,
          campaign_id:
            row.campaign_id != null && String(row.campaign_id) !== ''
              ? String(row.campaign_id)
              : null,
          name:
            (row.ad_name && String(row.ad_name)) ||
            findVal(row, 'ad') ||
            'Sin nombre',
          rowDays: {},
          spend: 0,
          impressions: 0,
          clicks: 0,
          leads: 0,
          hasSpend: false,
          hasImpressions: false,
          hasClicks: false,
          hasLeads: false,
        };
      }
      var a = ads[aid];
      var d = row.metric_date || '';
      if (d) a.rowDays[d] = true;
      var s = fmtN(row.spend != null ? row.spend : row.gasto);
      var i = fmtN(row.impressions);
      var cl = fmtN(row.clicks);
      var l = metaLeadsFromRow(row);
      if (s !== null) {
        a.spend += s;
        a.hasSpend = true;
      }
      if (i !== null) {
        a.impressions += i;
        a.hasImpressions = true;
      }
      if (cl !== null) {
        a.clicks += cl;
        a.hasClicks = true;
      }
      if (l !== null) {
        a.leads += l;
        a.hasLeads = true;
      }
    });

    return Object.keys(ads).map(function (key) {
      var a = ads[key];
      var gasto = a.hasSpend ? a.spend : null;
      var impressions = a.hasImpressions ? a.impressions : null;
      var clicks = a.hasClicks ? a.clicks : null;
      var conversiones = a.hasLeads ? a.leads : null;
      var ctr =
        impressions !== null && impressions > 0 && clicks !== null
          ? (clicks / impressions) * 100
          : null;
      var cpc =
        clicks !== null && clicks > 0 && gasto !== null ? gasto / clicks : null;
      var cpl =
        conversiones !== null && conversiones > 0 && gasto !== null
          ? gasto / conversiones
          : null;
      return {
        ad_id: a.ad_id,
        campaign_id: a.campaign_id,
        name: a.name,
        dias: Object.keys(a.rowDays).length,
        gasto: gasto,
        impressions: impressions,
        clicks: clicks,
        conversiones: conversiones,
        cpl: cpl,
        cplSinConversiones: !(conversiones !== null && conversiones > 0),
        ctr: ctr,
        cpc: cpc,
      };
    });
  }

  function groupAdsByCampaignId(adList) {
    var byCamp = {};
    (adList || []).forEach(function (a) {
      var cid = a.campaign_id != null ? String(a.campaign_id) : '__unknown__';
      if (!byCamp[cid]) byCamp[cid] = [];
      byCamp[cid].push(a);
    });
    return byCamp;
  }

  function czPayloadMatchesPeriod(payload, range) {
    if (!payload || !payload.range || !range) return false;
    return (
      payload.range.from === range.from && payload.range.to === range.to
    );
  }

  /**
   * Ad-level aggregates for the active period preset (same as campaigns).
   * @param {object[]} allAdData
   * @param {object|null} czPayload from GET /api/meta-agent/cz-attribution
   */
  function computeAdsDerived(allAdData, czPayload) {
    var range = resolvePeriodRange(
      state.periodPreset,
      state.customFrom,
      state.customTo,
    );
    var filtered = filterRowsByMetricDate(allAdData || [], range.from, range.to);
    var deduped = dedupeRowsByAdDate(filtered);
    var adList = buildAdListByAdId(deduped);
    var czAttribution = null;
    if (CZ && czPayload && czPayloadMatchesPeriod(czPayload, range)) {
      adList = CZ.attachCzStatsToAdList(adList, czPayload.byAdId || {});
      czAttribution = {
        byAdId: czPayload.byAdId || {},
        buckets: czPayload.buckets || {},
        globalAttributed: czPayload.globalAttributed || {
          solicitudCount: 0,
          uniqueCi: 0,
        },
        ciOverlap: czPayload.ciOverlap || {},
        pendingAdIds: czPayload.pendingAdIds || [],
        dateSemantics: czPayload.dateSemantics || null,
        limitations: czPayload.limitations || null,
      };
    } else if (CZ) {
      adList = CZ.attachCzStatsToAdList(adList, {});
    }
    if (CZ && CZ.aggregatePlatformSpendForAd) {
      var platByAd = CZ.aggregatePlatformSpendForAd(
        deduped,
        range.from,
        range.to,
      );
      adList = adList.map(function (ad) {
        var slices = platByAd[String(ad.ad_id)] || null;
        return Object.assign({}, ad, { platformSpend: slices });
      });
    }
    var adsByCampaign = groupAdsByCampaignId(adList);
    return {
      adList: adList,
      adsByCampaign: adsByCampaign,
      range: range,
      datasetEmpty: !(allAdData && allAdData.length),
      bounds: computeDatasetDateBounds(allAdData || []),
      czAttribution: czAttribution,
    };
  }

  function computeDatasetDateBounds(rows) {
    var minD = null;
    var maxD = null;
    (rows || []).forEach(function (row) {
      var d = row.metric_date || '';
      if (!d) return;
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
    });
    return { minDate: minD, maxDate: maxD };
  }

  function computeCoverage(filteredRows, range, allRows) {
    var from = range.from;
    var to = range.to;
    var expectedDays = enumerateInclusiveDates(from, to);
    var datesWithAnyRow = {};
    (filteredRows || []).forEach(function (row) {
      var d = row.metric_date || '';
      if (d) datesWithAnyRow[d] = true;
    });
    var present = expectedDays.filter(function (d) {
      return !!datesWithAnyRow[d];
    });
    var bounds = computeDatasetDateBounds(allRows);
    var today = calendarDateInZone();
    var includesPartialToday =
      !!today && to === today && expectedDays.indexOf(today) >= 0;
    return {
      from: from,
      to: to,
      expectedDayCount: expectedDays.length,
      presentDayCount: present.length,
      missingDayCount: expectedDays.length - present.length,
      datasetMinDate: bounds.minDate,
      datasetMaxDate: bounds.maxDate,
      includesPartialToday: includesPartialToday,
      isComplete: present.length === expectedDays.length && !includesPartialToday,
    };
  }

  function todayMontevideoIso(now) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: ACCOUNT_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now || new Date());
    } catch (e) {
      return null;
    }
  }

  function isPartialMetricDay(dateStr, now) {
    var today = todayMontevideoIso(now);
    return !!(dateStr && today && String(dateStr) === today);
  }

  /**
   * Map own_ad_metrics row → same string-keyed shape parseCSV() used to emit,
   * so findVal / buildCampList / KPIs / alerts need no changes.
   * Derived metrics (cpl, ctr, cpc) computed here from raw columns only.
   */
  function mapOwnAdMetricsToLegacyRow(row) {
    var impressionsNum = parseFloat(row.impressions);
    var clicksNum = parseFloat(row.clicks);
    var impressions = isNaN(impressionsNum) ? 0 : impressionsNum;
    var clicks = isNaN(clicksNum) ? 0 : clicksNum;
    var metaLeads = metaLeadCountFromInsight(row.raw_json);
    var spendNum = fmtN(row.spend);

    var ctr = impressions > 0 ? (clicks / impressions) * 100 : '';
    var cpc = spendNum !== null && clicks > 0 ? spendNum / clicks : '';

    var name = toCsvCompatString(row.campaign_name);
    var freq = toCsvCompatString(row.frequency);
    var spendStr = toCsvCompatString(row.spend);

    return {
      campaign_id:
        row.campaign_id != null ? toCsvCompatString(row.campaign_id) : '',
      campaign_name: name,
      campana: name,
      cpl: '',
      meta_leads: metaLeads === null ? '' : toCsvCompatString(metaLeads),
      ctr: toCsvCompatString(ctr),
      cpc: toCsvCompatString(cpc),
      frequency: freq,
      frecuencia: freq,
      spend: spendStr,
      gasto: spendStr,
      conversions: '',
      conversiones: '',
      impressions: toCsvCompatString(row.impressions),
      clicks: toCsvCompatString(row.clicks),
      metric_date: toCsvCompatString(row.metric_date),
      created_at: toCsvCompatString(row.created_at),
      raw_json:
        row.raw_json && typeof row.raw_json === 'object' ? row.raw_json : null,
    };
  }

  function mapOwnAdAdMetricsToLegacyRow(row) {
    var impressionsNum = parseFloat(row.impressions);
    var clicksNum = parseFloat(row.clicks);
    var impressions = isNaN(impressionsNum) ? 0 : impressionsNum;
    var clicks = isNaN(clicksNum) ? 0 : clicksNum;
    var metaLeads = metaLeadsFromRow({
      meta_leads: row.actions,
      raw_json: row.raw_json,
    });
    var spendNum = fmtN(row.spend);
    var ctr = impressions > 0 ? (clicks / impressions) * 100 : '';
    var cpc = spendNum !== null && clicks > 0 ? spendNum / clicks : '';
    var spendStr = toCsvCompatString(row.spend);
    var adName = toCsvCompatString(row.ad_name);

    return {
      ad_id: row.ad_id != null ? toCsvCompatString(row.ad_id) : '',
      ad_name: adName,
      campaign_id:
        row.campaign_id != null ? toCsvCompatString(row.campaign_id) : '',
      campaign_name: toCsvCompatString(row.campaign_name),
      meta_leads: metaLeads === null ? '' : toCsvCompatString(metaLeads),
      ctr: toCsvCompatString(ctr),
      cpc: toCsvCompatString(cpc),
      spend: spendStr,
      gasto: spendStr,
      impressions: toCsvCompatString(row.impressions),
      clicks: toCsvCompatString(row.clicks),
      metric_date: toCsvCompatString(row.metric_date),
      created_at: toCsvCompatString(row.created_at),
      raw_json:
        row.raw_json && typeof row.raw_json === 'object' ? row.raw_json : null,
    };
  }

  function lookbackStartDateIso(now) {
    var today = calendarDateInZone(now);
    if (!today) return null;
    return shiftIsoDate(today, -METRIC_LOOKBACK_DAYS);
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

  async function fetchOwnAdAdMetricsRows(cfg) {
    var since = lookbackStartDateIso();
    var base =
      cfg.url.replace(/\/+$/, '') +
      '/rest/v1/own_ad_ad_metrics' +
      '?entity_id=eq.' +
      encodeURIComponent(OWN_ENTITY_ID) +
      '&metric_date=gte.' +
      encodeURIComponent(since) +
      '&select=entity_id,campaign_id,campaign_name,ad_id,ad_name,metric_date,spend,impressions,clicks,actions,actions_value,raw_json,created_at' +
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
        throw new Error('Respuesta inesperada de Supabase (ads)');
      }
      for (var i = 0; i < chunk.length; i++) {
        all.push(chunk[i]);
      }
      if (chunk.length < pageSize) break;
      from += pageSize;
    }

    return all;
  }

  function apiBaseUrl() {
    return window.location.protocol === 'file:'
      ? 'https://mie-backend-production.up.railway.app'
      : '';
  }

  async function loadCzAttribution() {
    var range = resolvePeriodRange(
      state.periodPreset,
      state.customFrom,
      state.customTo,
    );
    if (!range.from || !range.to) {
      state.czAttribution = null;
      state.czAttributionError = null;
      state.czAttributionLoading = false;
      return;
    }
    state.czAttributionLoading = true;
    try {
      var url =
        apiBaseUrl() +
        '/api/meta-agent/cz-attribution?from=' +
        encodeURIComponent(range.from) +
        '&to=' +
        encodeURIComponent(range.to);
      var res = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) {
        state.czAttribution = null;
        state.czAttributionError =
          'Sesión sin permiso para atribución Credizona (Meta Ads).';
        return;
      }
      if (!res.ok) {
        state.czAttribution = null;
        state.czAttributionError =
          'No se pudo cargar atribución Credizona (' + res.status + ').';
        return;
      }
      var body = await res.json();
      if (!body || typeof body !== 'object' || !body.byAdId) {
        state.czAttribution = null;
        state.czAttributionError = 'Respuesta inválida de atribución Credizona.';
        return;
      }
      state.czAttribution = body;
      state.czAttributionError = null;
    } catch (e) {
      state.czAttribution = null;
      state.czAttributionError = 'No se pudo cargar atribución Credizona.';
      console.error(
        '[meta-agent] loadCzAttribution failed:',
        e && e.message ? e.message : String(e),
      );
    } finally {
      state.czAttributionLoading = false;
      render();
    }
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
        leads: null,
        qualityRanking: null,
        engagementRanking: null,
        conversionRanking: null,
      };
    }

    var spend = null;
    var impressions = null;
    var clicks = null;
    var reach = null;
    var leads = null;
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
      var leadN = metaLeadsFromRow(row);
      if (leadN !== null) leads = (leads || 0) + leadN;

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
      leads: leads,
      qualityRanking: qualityRanking,
      engagementRanking: engagementRanking,
      conversionRanking: conversionRanking,
    };
  }

  function computeDerived(allData) {
    var range = resolvePeriodRange(
      state.periodPreset,
      state.customFrom,
      state.customTo,
    );
    var filtered = filterRowsByMetricDate(allData || [], range.from, range.to);
    var deduped = dedupeRowsByCampaignDate(filtered);
    var campList = buildCampListByCampaignId(deduped);
    var period = aggregateAccountPeriod(deduped);
    var coverage = computeCoverage(deduped, range, allData || []);
    var totalGasto =
      period.spend !== null && period.spend !== undefined ? period.spend : 0;
    var totalConv =
      period.leads !== null && period.leads !== undefined ? period.leads : 0;
    var avgCPL = period.cpl;
    var alertas = campList.filter(campaignHasAlert);
    var singleDay = range.from === range.to;
    var latest = singleDay
      ? computeLatestDateStats(deduped)
      : period;
    if (singleDay && latest.date) {
      period.date = latest.date;
    }
    return {
      campList: campList,
      totalGasto: totalGasto,
      totalConv: totalConv,
      avgCPL: avgCPL,
      alertas: alertas,
      latest: latest,
      period: period,
      range: range,
      coverage: coverage,
      filteredRows: deduped,
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
      var v = metaLeadsFromRow(row);
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
      return { arrow: '→', label: '0%', tone: 'neutral' };
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
                  return value == null ? null : 'CPC propio: $' + fmtUsd(value);
                }
                if (id === 'cpl') {
                  return value == null ? null : 'CPL propio: $' + fmtUsd(value);
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
    var open = state.liquidityListOpen === true;
    var body;
    if (rows.length === 0) {
      body =
        '<div class="ma-empty">Sin registros todavía — el job diario irá llenando este historial</div>';
    } else {
      body =
        '<div class="ma-table-wrap">' +
        '<table class="ma-table">' +
        '<thead><tr><th>Fecha</th><th>Fase</th><th>Gasto Meta</th></tr></thead>' +
        '<tbody>' +
        rows
          .map(function (r) {
            var dateLabel = formatDateEs(r.log_date) || r.log_date || '—';
            var spend =
              r.meta_spend_day !== null && r.meta_spend_day !== undefined
                ? '$' + fmtUsd(r.meta_spend_day)
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
        '</tbody></table></div>';
    }
    return (
      '<section class="ma-kpi-section ma-liquidity-history">' +
      '<button type="button" class="ma-liquidity-toggle" data-ma-action="toggle-liquidity" aria-expanded="' +
      (open ? 'true' : 'false') +
      '">' +
      '<span class="ma-kpi-section-title">Historial ciclo de liquidez (30 días)</span>' +
      '<span class="ma-liquidity-count">' +
      rows.length +
      (open ? ' ▾' : ' ▸') +
      '</span>' +
      '</button>' +
      '<div class="ma-liquidity-body"' +
      (open ? '' : ' hidden') +
      '>' +
      body +
      '</div></section>'
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

  function renderPeriodBar(derived) {
    var range = derived.range || {};
    var cov = derived.coverage || {};
    var rangeLabel =
      formatRangeEs(range.from, range.to) ||
      (range.from && range.to
        ? range.from + ' – ' + range.to
        : 'Período no definido');
    var datasetLine = '—';
    if (cov.datasetMinDate && cov.datasetMaxDate) {
      datasetLine =
        formatRangeEs(cov.datasetMinDate, cov.datasetMaxDate) ||
        cov.datasetMinDate + ' – ' + cov.datasetMaxDate;
    }
    var syncLine =
      cov.expectedDayCount != null
        ? cov.presentDayCount +
          '/' +
          cov.expectedDayCount +
          ' días con datos Meta en el período'
        : '';
    var warnClass =
      cov.missingDayCount > 0 || cov.includesPartialToday
        ? ' ma-coverage-warn'
        : '';
    var warnBits = [];
    if (cov.missingDayCount > 0) {
      warnBits.push(
        'Faltan ' +
          cov.missingDayCount +
          ' día(s) de sync dentro del período seleccionado',
      );
    }
    if (cov.includesPartialToday) {
      warnBits.push('Hoy puede estar incompleto hasta el próximo sync');
    }
    if (!cov.datasetMinDate) {
      warnBits.push('Sin filas en own_ad_metrics para este rango cargado');
    }

    var preset = state.periodPreset || '7d';
    function btn(id, label) {
      var active = preset === id ? ' active' : '';
      return (
        '<button type="button" class="ma-period-btn' +
        active +
        '" data-ma-period="' +
        id +
        '">' +
        escapeHtml(label) +
        '</button>'
      );
    }

    return (
      '<div class="ma-period-bar">' +
      '<div class="ma-period-presets">' +
      btn('today', 'Hoy') +
      btn('yesterday', 'Ayer') +
      btn('7d', 'Últimos 7 días') +
      btn('30d', 'Últimos 30 días') +
      btn('custom', 'Personalizado') +
      '</div>' +
      (preset === 'custom'
        ? '<div class="ma-period-custom">' +
          '<label>Desde <input type="date" class="ma-period-input" data-ma-period-from value="' +
          escapeHtml(state.customFrom || range.from || '') +
          '" /></label>' +
          '<label>Hasta <input type="date" class="ma-period-input" data-ma-period-to value="' +
          escapeHtml(state.customTo || range.to || '') +
          '" /></label>' +
          '<button type="button" class="ma-btn ma-period-apply" data-ma-action="apply-period">Aplicar</button>' +
          '</div>'
        : '') +
      '<div class="ma-period-summary">' +
      '<strong>Período:</strong> ' +
      escapeHtml(rangeLabel) +
      ' <span class="ma-period-tz">(America/Montevideo)</span>' +
      '</div>' +
      '<div class="ma-period-summary">' +
      '<strong>Datos cargados (own_ad_metrics):</strong> ' +
      escapeHtml(datasetLine) +
      (syncLine ? ' · ' + escapeHtml(syncLine) : '') +
      '</div>' +
      (warnBits.length
        ? '<div class="ma-coverage-banner' +
          warnClass +
          '">' +
          escapeHtml(warnBits.join(' · ')) +
          '</div>'
        : '') +
      '<p class="ma-period-note">Conversiones = evento Meta form_step_3 (pixel). No son solicitudes Credizona.</p>' +
      '</div>'
    );
  }

  function renderKpis(derived, data) {
    var avgCPL = derived.avgCPL;
    var alertas = derived.alertas;
    var period = derived.period || derived.latest || {};
    var range = derived.range || {};
    var singleDay = range.from && range.to && range.from === range.to;
    var partialDay =
      singleDay && isPartialMetricDay(period.date || range.to);
    var periodSub =
      formatRangeEs(range.from, range.to) ||
      (range.from && range.to ? range.from + ' – ' + range.to : 'sin datos');
    if (partialDay) periodSub += ' · día en curso';
    var trends =
      singleDay && !partialDay
        ? trendsFromData(data, period)
        : {
            spend: null,
            conversions: null,
            cpl: null,
            ctr: null,
            cpc: null,
            cpm: null,
          };
    var metaLeadCount =
      period.leads !== null && period.leads !== undefined ? period.leads : null;
    var metaCpl = avgCPL;
    var rankingDay = singleDay ? period : computeLatestDateStats(data || []);
    var ev = state.nextEvents || {};

    var performance = [
      {
        label: 'GASTO',
        val:
          period.spend !== null && period.spend !== undefined
            ? '$' + fmtUsd(period.spend)
            : '—',
        sub: periodSub,
        color: '#3b82f6',
        icon: '💰',
        trend: trends.spend,
      },
      {
        label: 'CONVERSIONES',
        val:
          metaLeadCount !== null && metaLeadCount > 0
            ? fmt(metaLeadCount, 0)
            : derived.totalConv === 0
              ? '0'
              : '—',
        sub: 'form_step_3 en el período',
        color: '#22c55e',
        icon: '🎯',
        trend: trends.conversions,
      },
      {
        label: 'CPL PROMEDIO',
        val: avgCPL !== null ? '$' + fmtUsd(avgCPL) : '—',
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
        label: 'CPL META',
        val:
          metaCpl !== null
            ? '$' + fmtUsd(metaCpl)
            : metaLeadCount === 0
              ? 'Sin conversiones'
              : '—',
        sub:
          metaCpl !== null
            ? 'gasto / conversiones Meta'
            : 'Sin conversiones Meta en el período',
        color: '#22c55e',
        icon: '💵',
      },
      {
        label: 'CTR',
        val:
          period.ctr !== null && period.ctr !== undefined
            ? fmt(period.ctr) + '%'
            : '—',
        sub: periodSub,
        color: '#3b82f6',
        icon: '👁',
        trend: trends.ctr,
      },
      {
        label: 'CPC',
        val:
          period.cpc !== null && period.cpc !== undefined
            ? '$' + fmtUsd(period.cpc)
            : '—',
        sub: periodSub,
        color: '#8b5cf6',
        icon: '🖱',
        trend: trends.cpc,
      },
      {
        label: 'CPM',
        val:
          period.cpm !== null && period.cpm !== undefined
            ? '$' + fmtUsd(period.cpm)
            : '—',
        sub: periodSub,
        color: '#f59e0b',
        icon: '📡',
        trend: trends.cpm,
      },
      {
        label: 'ALCANCE',
        val:
          singleDay &&
          rankingDay.reach !== null &&
          rankingDay.reach !== undefined
            ? fmt(rankingDay.reach, 0)
            : '—',
        sub: singleDay ? periodSub : '— (solo día único)',
        color: '#38bdf8',
        icon: '📢',
      },
      {
        label: 'FRECUENCIA',
        val:
          singleDay &&
          rankingDay.frequency !== null &&
          rankingDay.frequency !== undefined
            ? fmt(rankingDay.frequency)
            : '—',
        sub: singleDay ? periodSub : '— (no promediar en rango)',
        color: '#fb7185',
        icon: '🔁',
      },
      (function () {
        var q = rankingLabel(rankingDay.qualityRanking);
        var e = rankingLabel(rankingDay.engagementRanking);
        var c = rankingLabel(rankingDay.conversionRanking);
        var hasAny =
          rankingDay.qualityRanking ||
          rankingDay.engagementRanking ||
          rankingDay.conversionRanking;
        return {
          label: 'RANKING DE CALIDAD',
          val:
            'Calidad: ' +
            q +
            ' · Engagement: ' +
            e +
            ' · Conversión: ' +
            c,
          sub: hasAny && singleDay ? periodSub : '— (solo día único)',
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

  /** Shared campaign/ad grid columns — identity colors via CSS (--ma-kpi-*). */
  var MA_ENTITY_KPI_COLUMNS = [
    { id: 'gasto', label: 'Gasto', title: 'Gasto', trend: 'cost' },
    { id: 'impressions', label: 'Impr.', title: 'Impresiones', trend: 'volume' },
    { id: 'clicks', label: 'Clics', title: 'Clics', trend: 'volume' },
    { id: 'ctr', label: 'CTR', title: 'CTR', trend: 'rate_up' },
    { id: 'cpc', label: 'CPC', title: 'CPC', trend: 'cost' },
    { id: 'cplMeta', label: 'CPL M.', title: 'CPL Meta', trend: 'cost' },
    { id: 'convMeta', label: 'Conv M.', title: 'Conv. Meta', trend: 'volume' },
    { id: 'czSolicitudes', label: 'Sol CZ', title: 'Solicitudes Credizona', trend: null },
    { id: 'czPreaprobados', label: 'Preap.', title: 'Preaprobados', trend: null },
    { id: 'czGranted', label: 'Otor.', title: 'Otorgados', trend: null },
    { id: 'cplCz', label: 'CPL CZ', title: 'CPL Credizona', trend: null },
    { id: 'costPerPreaprob', label: '$/Preap', title: 'Costo por preaprobado', trend: null },
    { id: 'costPerGranted', label: '$/Otor', title: 'Costo por otorgado', trend: null },
    { id: 'alcance', label: 'Alc.', title: 'Alcance', trend: null },
    { id: 'frecuencia', label: 'Frec.', title: 'Frecuencia', trend: null },
  ];

  function resolvePreviousEquivalentRange(from, to) {
    var days = enumerateInclusiveDates(from, to);
    if (!days.length) return null;
    var len = days.length;
    return {
      from: shiftIsoDate(from, -len),
      to: shiftIsoDate(from, -1),
    };
  }

  function entityDatesPresent(rows, from, to, matchRow, rowKind) {
    var expected = enumerateInclusiveDates(from, to);
    if (!expected.length) return false;
    var filtered = filterRowsByMetricDate(rows, from, to).filter(matchRow);
    var isAd = rowKind === 'ad';
    if (rowKind !== 'campaign' && rowKind !== 'ad') {
      isAd = filtered.some(function (r) {
        return r.ad_id != null && String(r.ad_id) !== '';
      });
    }
    var deduped = isAd
      ? dedupeRowsByAdDate(filtered)
      : dedupeRowsByCampaignDate(filtered);
    var present = {};
    deduped.forEach(function (row) {
      var d = row.metric_date || '';
      if (d) present[d] = true;
    });
    return expected.every(function (d) {
      return !!present[d];
    });
  }

  function reachFrequencyForCampaignRows(rows, campaignId, date) {
    var spend = null;
    var impressions = null;
    var reach = null;
    var freqWeighted = 0;
    var freqWeight = 0;
    (rows || []).forEach(function (row) {
      if ((row.metric_date || '') !== date) return;
      if (String(row.campaign_id) !== String(campaignId)) return;
      var s = fmtN(row.spend != null ? row.spend : row.gasto);
      var i = fmtN(row.impressions);
      if (s !== null) spend = (spend || 0) + s;
      if (i !== null) impressions = (impressions || 0) + i;
      var raw =
        row.raw_json && typeof row.raw_json === 'object' ? row.raw_json : null;
      if (!raw) return;
      var r = fmtN(raw.reach);
      if (r !== null) reach = (reach || 0) + r;
      var f = fmtN(raw.frequency);
      if (f !== null) {
        var w = i !== null && i > 0 ? i : 1;
        freqWeighted += f * w;
        freqWeight += w;
      }
    });
    var frequency = freqWeight > 0 ? freqWeighted / freqWeight : null;
    return { alcance: reach, frecuencia: frequency };
  }

  function rollupCampaignCzFromAds(ads) {
    var out = {
      czSolicitudes: 0,
      czPreaprobados: 0,
      czGranted: 0,
      hasCz: false,
    };
    (ads || []).forEach(function (ad) {
      if (ad.czSolicitudes != null) {
        out.czSolicitudes += ad.czSolicitudes;
        out.hasCz = true;
      }
      if (ad.czPreaprobados != null) {
        out.czPreaprobados += ad.czPreaprobados;
        out.hasCz = true;
      }
      if (ad.czGranted != null) {
        out.czGranted += ad.czGranted;
        out.hasCz = true;
      }
    });
    return out;
  }

  function resolveCampaignCzRollup(campaignId, czPayload, adMetricRows) {
    if (!campaignId || !czPayload) return null;
    var key = String(campaignId);
    if (czPayload.byCampaignId && czPayload.byCampaignId[key]) {
      return czPayload.byCampaignId[key];
    }
    if (
      CZ &&
      CZ.computeCampaignCzRollups &&
      CZ.buildAdDimensionMap &&
      czPayload.byAdId &&
      adMetricRows &&
      adMetricRows.length
    ) {
      var adDim = CZ.buildAdDimensionMap(adMetricRows, OWN_ENTITY_ID);
      var byCamp = CZ.computeCampaignCzRollups(
        [],
        adDim,
        OWN_ENTITY_ID,
        czPayload.byAdId,
        null,
      );
      return byCamp[key] || null;
    }
    return null;
  }

  function mergeCampaignCzSlicesLocal(a, b) {
    if (CZ && CZ.mergeCampaignCzSlices) {
      return CZ.mergeCampaignCzSlices(a, b);
    }
    var left = a || { solicitudCount: 0, preaprobadosCount: 0, grantedCount: 0 };
    var right = b || { solicitudCount: 0, preaprobadosCount: 0, grantedCount: 0 };
    return {
      solicitudCount: left.solicitudCount + right.solicitudCount,
      preaprobadosCount: left.preaprobadosCount + right.preaprobadosCount,
      grantedCount: left.grantedCount + right.grantedCount,
    };
  }

  function applyCampaignCzRollupToEntity(entity, rollup) {
    if (!rollup) return entity;
    var total = mergeCampaignCzSlicesLocal(
      rollup.identified,
      rollup.unidentified,
    );
    entity.czSolicitudes = total.solicitudCount;
    entity.czPreaprobados = total.preaprobadosCount;
    entity.czGranted = total.grantedCount;
    entity.cplCzSinSolicitudes = total.solicitudCount === 0;
    entity.cplCz = entityCplCz(entity);
    entity.costPerPreaprob = entityCostPerPreaprob(entity);
    entity.costPerGranted = entityCostPerGranted(entity);
    entity._czRollup = rollup;
    return entity;
  }

  function adNameFromMetricRows(adId, adMetricRows) {
    var name = null;
    (adMetricRows || []).forEach(function (row) {
      if (String(row.ad_id) !== String(adId)) return;
      var n = row.ad_name || row.ad || findVal(row, 'ad');
      if (n) name = String(n);
    });
    return name || 'Anuncio ' + adId;
  }

  function enrichCampaignAdsWithCzOrphans(campaignId, ads, czPayload, adMetricRows) {
    if (!czPayload || !czPayload.byAdId || !CZ || !CZ.buildAdDimensionMap) {
      return ads;
    }
    var cid = String(campaignId);
    var dim = CZ.buildAdDimensionMap(adMetricRows || [], OWN_ENTITY_ID);
    var present = {};
    (ads || []).forEach(function (ad) {
      if (ad.ad_id != null) present[String(ad.ad_id)] = true;
    });
    var extras = [];
    Object.keys(czPayload.byAdId).forEach(function (adId) {
      if (present[adId]) return;
      var d = dim.get(adId);
      if (!d || String(d.campaign_id) !== cid) return;
      var stats = czPayload.byAdId[adId];
      extras.push({
        ad_id: adId,
        campaign_id: campaignId,
        name: adNameFromMetricRows(adId, adMetricRows),
        gasto: null,
        impressions: null,
        clicks: null,
        conversiones: null,
        cpl: null,
        cplSinConversiones: true,
        ctr: null,
        cpc: null,
        czSolicitudes: stats.solicitudCount || 0,
        czPreaprobados: stats.preaprobadosCount || 0,
        czGranted: stats.grantedCount || 0,
        cplCz:
          stats.solicitudCount > 0
            ? null
            : null,
        cplCzSinSolicitudes: !(stats.solicitudCount > 0),
        costPerPreaprob: null,
        costPerGranted: null,
        czAttributedOrphan: true,
      });
    });
    if (!extras.length) return ads;
    return (ads || []).concat(extras);
  }

  function buildUnidentifiedCzSyntheticAd(campaignId, rollup) {
    if (!rollup || !rollup.unidentified || rollup.unidentified.solicitudCount <= 0) {
      return null;
    }
    var u = rollup.unidentified;
    return {
      ad_id: null,
      campaign_id: campaignId,
      name: 'Sin anuncio identificado',
      czUnidentifiedRow: true,
      gasto: null,
      impressions: null,
      clicks: null,
      conversiones: null,
      cpl: null,
      cplSinConversiones: true,
      ctr: null,
      cpc: null,
      czSolicitudes: u.solicitudCount,
      czPreaprobados: u.preaprobadosCount,
      czGranted: u.grantedCount,
      cplCzSinSolicitudes: u.solicitudCount === 0,
      cplCz: null,
      costPerPreaprob: null,
      costPerGranted: null,
    };
  }

  function entityCostPerPreaprob(entity) {
    if (entity.costPerPreaprob != null) return entity.costPerPreaprob;
    var g = entity.gasto;
    var p = entity.czPreaprobados;
    if (g !== null && g !== undefined && p > 0) return g / p;
    return null;
  }

  function entityCostPerGranted(entity) {
    if (entity.costPerGranted != null) return entity.costPerGranted;
    var g = entity.gasto;
    var o = entity.czGranted;
    if (g !== null && g !== undefined && o > 0) return g / o;
    return null;
  }

  function entityCplCz(entity) {
    if (entity.cplCzSinSolicitudes) return null;
    if (entity.cplCz != null) return entity.cplCz;
    var g = entity.gasto;
    var s = entity.czSolicitudes;
    if (g !== null && g !== undefined && s > 0) return g / s;
    return null;
  }

  function buildCampaignEntity(c, adsDerived, campRows, range, adMetricRows) {
    var cid = c.campaign_id != null ? String(c.campaign_id) : null;
    var czPayload =
      adsDerived && adsDerived.czAttribution ? adsDerived.czAttribution : null;
    var rollup = resolveCampaignCzRollup(cid, czPayload, adMetricRows);
    var entity = {
      gasto: c.gasto,
      impressions: c.impressions,
      clicks: c.clicks,
      ctr: c.ctr,
      cpc: c.cpc,
      cplMeta: c.cplSinConversiones ? null : c.cpl,
      cplSinConversiones: c.cplSinConversiones,
      convMeta: c.conversiones,
      czSolicitudes: null,
      czPreaprobados: null,
      czGranted: null,
      cplCz: null,
      cplCzSinSolicitudes: true,
      costPerPreaprob: null,
      costPerGranted: null,
      alcance: null,
      frecuencia: null,
    };
    if (rollup) {
      applyCampaignCzRollupToEntity(entity, rollup);
    } else if (cid && adsDerived) {
      var ads = adsDerived.adsByCampaign[cid] || [];
      var cz = rollupCampaignCzFromAds(ads);
      if (cz.hasCz || czPayload) {
        entity.czSolicitudes = cz.czSolicitudes;
        entity.czPreaprobados = cz.czPreaprobados;
        entity.czGranted = cz.czGranted;
        entity.cplCzSinSolicitudes = cz.czSolicitudes === 0;
        entity.cplCz = entityCplCz(entity);
        entity.costPerPreaprob = entityCostPerPreaprob(entity);
        entity.costPerGranted = entityCostPerGranted(entity);
      }
    }
    if (range && range.from === range.to && cid && campRows) {
      var rf = reachFrequencyForCampaignRows(campRows, cid, range.from);
      entity.alcance = rf.alcance;
      entity.frecuencia = rf.frecuencia;
    }
    return entity;
  }

  function buildAdEntity(ad) {
    return {
      gasto: ad.gasto,
      impressions: ad.impressions,
      clicks: ad.clicks,
      ctr: ad.ctr,
      cpc: ad.cpc,
      cplMeta: ad.cplSinConversiones ? null : ad.cpl,
      cplSinConversiones: ad.cplSinConversiones,
      convMeta: ad.conversiones,
      czSolicitudes: ad.czSolicitudes != null ? ad.czSolicitudes : null,
      czPreaprobados: ad.czPreaprobados != null ? ad.czPreaprobados : null,
      czGranted: ad.czGranted != null ? ad.czGranted : null,
      cplCz: entityCplCz(ad),
      cplCzSinSolicitudes: ad.cplCzSinSolicitudes,
      costPerPreaprob: entityCostPerPreaprob(ad),
      costPerGranted: entityCostPerGranted(ad),
      alcance: null,
      frecuencia: null,
    };
  }

  function entityNumericForTrend(colId, entity) {
    if (!entity) return null;
    if (colId === 'cplMeta') return entity.cplMeta;
    if (colId === 'convMeta') return entity.convMeta;
    if (colId === 'cplCz') return entity.cplCz;
    if (colId === 'costPerPreaprob') return entity.costPerPreaprob;
    if (colId === 'costPerGranted') return entity.costPerGranted;
    return entity[colId] != null ? entity[colId] : null;
  }

  function trendSemanticForColumn(col) {
    if (!col || !col.trend) return null;
    if (col.trend === 'cost') return 'up_bad';
    if (col.trend === 'volume' || col.trend === 'rate_up') return 'up_good';
    return null;
  }

  function computeEntityColumnTrend(col, currentEntity, priorEntity) {
    if (!col.trend) return null;
    var semantic = trendSemanticForColumn(col);
    if (!semantic) return null;
    var cur = entityNumericForTrend(col.id, currentEntity);
    var prior = entityNumericForTrend(col.id, priorEntity);
    if (prior === null || prior === undefined || !Number.isFinite(Number(prior))) {
      return null;
    }
    return buildTrendIndicator(cur, [prior], semantic);
  }

  function priorCampaignEntity(
    campaignId,
    allCampRows,
    priorRange,
    allAdRows,
    czPayload,
  ) {
    var filtered = filterRowsByMetricDate(allCampRows || [], priorRange.from, priorRange.to);
    var deduped = dedupeRowsByCampaignDate(filtered);
    var list = buildCampListByCampaignId(deduped);
    var c = list.find(function (x) {
      return x.campaign_id != null && String(x.campaign_id) === String(campaignId);
    });
    if (!c) return null;
    var adsDerivedPrior = computeAdsDerivedForPeriod(
      allAdRows,
      priorRange,
      czPayload,
    );
    return buildCampaignEntity(c, adsDerivedPrior, deduped, priorRange);
  }

  function priorAdEntity(adId, allAdRows, priorRange, czPayload) {
    var adsDerivedPrior = computeAdsDerivedForPeriod(
      allAdRows,
      priorRange,
      czPayload,
    );
    var ad = (adsDerivedPrior.adList || []).find(function (a) {
      return String(a.ad_id) === String(adId);
    });
    return ad ? buildAdEntity(ad) : null;
  }

  function computeAdsDerivedForPeriod(allAdData, range, czPayload) {
    var prev = {
      periodPreset: state.periodPreset,
      customFrom: state.customFrom,
      customTo: state.customTo,
    };
    state.periodPreset = 'custom';
    state.customFrom = range.from;
    state.customTo = range.to;
    var out = computeAdsDerived(allAdData, czPayload);
    state.periodPreset = prev.periodPreset;
    state.customFrom = prev.customFrom;
    state.customTo = prev.customTo;
    return out;
  }

  function formatEntityKpiDisplay(colId, entity) {
    if (!entity) return { text: '—', muted: true };
    switch (colId) {
      case 'gasto':
        return entity.gasto !== null
          ? { text: '$' + fmtUsd(entity.gasto), muted: false }
          : { text: '—', muted: true };
      case 'impressions':
        return entity.impressions !== null
          ? { text: fmt(entity.impressions, 0), muted: false }
          : { text: '—', muted: true };
      case 'clicks':
        return entity.clicks !== null
          ? { text: fmt(entity.clicks, 0), muted: false }
          : { text: '—', muted: true };
      case 'ctr':
        return entity.ctr !== null
          ? { text: fmt(entity.ctr) + '%', muted: false }
          : { text: '—', muted: true };
      case 'cpc':
        return entity.cpc !== null
          ? { text: '$' + fmtUsd(entity.cpc), muted: false }
          : { text: '—', muted: true };
      case 'cplMeta':
        if (entity.cplSinConversiones) {
          return { text: '—', muted: true, title: 'Sin conversiones' };
        }
        return entity.cplMeta !== null
          ? { text: '$' + fmtUsd(entity.cplMeta), muted: false }
          : { text: '—', muted: true };
      case 'convMeta':
        if (entity.convMeta !== null && entity.convMeta > 0) {
          return { text: fmt(entity.convMeta, 0), muted: false };
        }
        if (entity.convMeta === 0) return { text: '0', muted: false };
        return { text: '—', muted: true, title: 'Sin conversiones' };
      case 'czSolicitudes':
        if (entity.czSolicitudes === null || entity.czSolicitudes === undefined) {
          return { text: '—', muted: true, title: 'Sin datos' };
        }
        return { text: fmt(entity.czSolicitudes, 0), muted: entity.czSolicitudes === 0 };
      case 'czPreaprobados':
        if (entity.czPreaprobados === null || entity.czPreaprobados === undefined) {
          return { text: '—', muted: true, title: 'Sin datos' };
        }
        return { text: fmt(entity.czPreaprobados, 0), muted: entity.czPreaprobados === 0 };
      case 'czGranted':
        if (entity.czGranted === null || entity.czGranted === undefined) {
          return { text: '—', muted: true, title: 'Sin datos' };
        }
        return { text: fmt(entity.czGranted, 0), muted: entity.czGranted === 0 };
      case 'cplCz':
        if (entity.cplCzSinSolicitudes) {
          return { text: '—', muted: true, title: 'Sin solicitudes' };
        }
        return entity.cplCz !== null
          ? { text: '$' + fmtUsd(entity.cplCz), muted: false }
          : { text: '—', muted: true, title: 'Sin datos' };
      case 'costPerPreaprob': {
        var cpp = entity.costPerPreaprob;
        if (cpp != null) return { text: '$' + fmtUsd(cpp), muted: false };
        if (entity.czPreaprobados === 0) return { text: '—', muted: true, title: 'Sin datos' };
        return { text: '—', muted: true };
      }
      case 'costPerGranted': {
        var cpg = entity.costPerGranted;
        if (cpg != null) return { text: '$' + fmtUsd(cpg), muted: false };
        if (entity.czGranted === 0) return { text: '—', muted: true, title: 'Sin datos' };
        return { text: '—', muted: true };
      }
      case 'alcance':
        return entity.alcance !== null && entity.alcance !== undefined
          ? { text: fmt(entity.alcance, 0), muted: false }
          : { text: '—', muted: true };
      case 'frecuencia':
        return entity.frecuencia !== null && entity.frecuencia !== undefined
          ? { text: fmt(entity.frecuencia, 1), muted: false }
          : { text: '—', muted: true };
      default:
        return { text: '—', muted: true };
    }
  }

  function renderEntityGridHeader() {
    return (
      '<div class="ma-entity-grid-head" role="row">' +
      '<div class="ma-entity-grid-cell ma-entity-grid-cell--name" role="columnheader">' +
      '<span class="ma-entity-kpi-label">Entidad</span>' +
      '</div>' +
      MA_ENTITY_KPI_COLUMNS.map(function (col) {
        var tip = col.title || col.label;
        return (
          '<div class="ma-entity-grid-cell ma-entity-grid-cell--kpi ma-kpi-id-' +
          col.id +
          '" role="columnheader">' +
          '<span class="ma-entity-kpi-label ma-kpi-id-' +
          col.id +
          '" title="' +
          escapeHtml(tip) +
          '">' +
          escapeHtml(col.label) +
          '</span>' +
          '</div>'
        );
      }).join('') +
      '</div>'
    );
  }

  function renderEntityGridKpiCells(entity, priorEntity, trendEnabled) {
    return MA_ENTITY_KPI_COLUMNS.map(function (col) {
      var disp = formatEntityKpiDisplay(col.id, entity);
      var trend =
        trendEnabled && priorEntity
          ? computeEntityColumnTrend(col, entity, priorEntity)
          : null;
      var valClass =
        'ma-entity-kpi-val ma-kpi-val-' +
        col.id +
        (disp.muted ? ' ma-entity-kpi-val--muted' : '');
      return (
        '<div class="ma-entity-grid-cell ma-entity-grid-cell--kpi" role="cell">' +
        '<div class="' +
        valClass +
        '">' +
        '<span class="ma-entity-kpi-val-text"' +
        (disp.title
          ? ' title="' + escapeHtml(disp.title) + '"'
          : '') +
        '>' +
        escapeHtml(disp.text) +
        '</span>' +
        renderTrendHtml(trend) +
        '</div>' +
        '</div>'
      );
    }).join('');
  }

  function adHasPlatformDetail(ad) {
    if (!ad) return false;
    if (
      ad.platformSpend &&
      typeof ad.platformSpend === 'object' &&
      Object.keys(ad.platformSpend).length > 0
    ) {
      return true;
    }
    return ad.gasto !== null && ad.gasto !== undefined && ad.gasto > 0;
  }

  function platformAdExpandKey(ad) {
    if (ad.ad_id != null && String(ad.ad_id) !== '') {
      return String(ad.ad_id);
    }
    return 'synthetic-' + String(ad.name || 'ad');
  }

  function renderAdPlatformDetail(ad) {
    var platformHtml = '';
    if (ad.platformSpend && typeof ad.platformSpend === 'object') {
      var platKeys = Object.keys(ad.platformSpend);
      if (platKeys.length) {
        platformHtml =
          '<div class="ma-ad-platform">' +
          '<div class="ma-ad-platform-title">Gasto Meta por plataforma (Insights)</div>' +
          '<ul class="ma-ad-platform-list">' +
          platKeys
            .sort(function (a, b) {
              return (ad.platformSpend[b] || 0) - (ad.platformSpend[a] || 0);
            })
            .map(function (pk) {
              return (
                '<li>' +
                escapeHtml(CZ.formatPlatformLabel(pk)) +
                ': $' +
                fmtUsd(ad.platformSpend[pk]) +
                '</li>'
              );
            })
            .join('') +
          '</ul></div>';
      }
    } else if (ad.gasto !== null && ad.gasto > 0) {
      platformHtml =
        '<div class="ma-ad-platform ma-ad-platform-muted">' +
        'Gasto por plataforma: Sin datos (requiere ingest con publisher_platform).</div>';
    }
    if (!platformHtml) return '';
    return (
      '<div class="ma-entity-grid-detail">' +
      platformHtml +
      '<div class="ma-ad-platform-note">Solicitudes / preaprobados / otorgados: No atribuible por plataforma (sin tracking verificable).</div>' +
      '</div>'
    );
  }

  function renderEntityGridAdRow(ad, ctx) {
    var entity = buildAdEntity(ad);
    var priorEntity = null;
    var trendEnabled = false;
    if (ctx.priorRange && ctx.trendsAllowed) {
      var adOkCur = entityDatesPresent(
        ctx.allAdRows,
        ctx.range.from,
        ctx.range.to,
        function (row) {
          return String(row.ad_id) === String(ad.ad_id);
        },
        'ad',
      );
      var adOkPrior = entityDatesPresent(
        ctx.allAdRows,
        ctx.priorRange.from,
        ctx.priorRange.to,
        function (row) {
          return String(row.ad_id) === String(ad.ad_id);
        },
        'ad',
      );
      if (adOkCur && adOkPrior) {
        priorEntity = priorAdEntity(
          ad.ad_id,
          ctx.allAdRows,
          ctx.priorRange,
          null,
        );
        trendEnabled = !!priorEntity;
      }
    }
    var platKey = platformAdExpandKey(ad);
    var platExpanded = !!state.expandedPlatformAdIds[platKey];
    var showPlatform = adHasPlatformDetail(ad);
    var platToggle = '';
    if (showPlatform) {
      platToggle =
        '<button type="button" class="ma-ad-toggle ma-ad-toggle--compact ma-platform-toggle" data-ma-action="toggle-ad-platform" data-ad-id="' +
        escapeHtml(platKey) +
        '" aria-expanded="' +
        (platExpanded ? 'true' : 'false') +
        '" title="' +
        (platExpanded ? 'Ocultar gasto por plataforma' : 'Ver gasto por plataforma') +
        '">' +
        (platExpanded ? '▾ Plat' : '▸ Plat') +
        '</button>';
    }
    var detail = platExpanded ? renderAdPlatformDetail(ad) : '';
    return (
      '<div class="ma-entity-grid-ad-block">' +
      '<div class="ma-entity-grid-row ma-entity-grid-row--ad' +
      (ad.czUnidentifiedRow ? ' ma-entity-grid-row--unidentified' : '') +
      '" role="row">' +
      '<div class="ma-entity-grid-cell ma-entity-grid-cell--name" role="cell">' +
      '<div class="ma-entity-name-line ma-entity-name-line--ad">' +
      '<span class="ma-entity-ad-name" title="' +
      escapeHtml(
        ad.name +
          (ad.ad_id != null && String(ad.ad_id) !== ''
            ? ' · ID ' + String(ad.ad_id)
            : ''),
      ) +
      '">' +
      escapeHtml(ad.name) +
      '</span>' +
      platToggle +
      '</div>' +
      '</div>' +
      renderEntityGridKpiCells(entity, priorEntity, trendEnabled) +
      '</div>' +
      detail +
      '</div>'
    );
  }

  function renderCzAttributionSummary(czAttribution, czError) {
    if (czError) {
      return (
        '<div class="ma-ad-panel ma-ad-panel-warn">' +
        escapeHtml(czError) +
        ' Las métricas Meta por anuncio siguen operativas.</div>'
      );
    }
    if (!CZ) {
      return (
        '<div class="ma-ad-panel ma-ad-panel-muted">' +
        'Atribución Credizona no disponible en el cliente.</div>'
      );
    }
    if (!czAttribution || !czAttribution.buckets) {
      return (
        '<div class="ma-ad-panel ma-ad-panel-muted">' +
        (state.czAttributionLoading
          ? 'Cargando atribución Credizona…'
          : 'Sin datos de solicitudes Credizona para el período.') +
        '</div>'
      );
    }
    var b = czAttribution.buckets;
    var B = CZ.CZ_ATTRIBUTION_BUCKETS;
    var ga = czAttribution.globalAttributed || { solicitudCount: 0, uniqueCi: 0 };
    return (
      '<div class="ma-cz-attrib-summary">' +
      '<div class="ma-cz-attrib-title">Credizona ↔ Meta (período seleccionado)</div>' +
      '<div class="ma-cz-attrib-total">Atribuidas a anuncio: <strong>' +
      fmt(ga.solicitudCount, 0) +
      '</strong> solicitudes · <strong>' +
      fmt(ga.uniqueCi, 0) +
      '</strong> CI únicas</div>' +
      '<ul class="ma-cz-attrib-list">' +
      '<li>Meta → anuncio: ' +
      fmt((b[B.META_AD_ATTRIBUTED] || {}).solicitudes || 0, 0) +
      ' solic.</li>' +
      '<li>Pendiente conciliación ad_id: ' +
      fmt((b[B.META_AD_PENDING] || {}).solicitudes || 0, 0) +
      ' solic.</li>' +
      '<li>Sin anuncio Meta determinado: ' +
      fmt((b[B.META_NO_AD] || {}).solicitudes || 0, 0) +
      ' solic.</li>' +
      '</ul>' +
      '<div class="ma-cz-attrib-foot">Preaprobados/otorgados: reglas CDV (estado 8 / grant) y ELM (S2 referred / disbursed_at), 1 por solicitud.</div>' +
      '</div>'
    );
  }

  function renderCampaignAdsPanel(c, adsDerived, gridCtx) {
    var cid = c.campaign_id != null ? String(c.campaign_id) : null;
    if (!cid) return '';
    var czPayload =
      adsDerived && adsDerived.czAttribution ? adsDerived.czAttribution : null;
    var adMetricRows = (gridCtx && gridCtx.allAdRows) || [];
    var ads = enrichCampaignAdsWithCzOrphans(
      cid,
      (adsDerived.adsByCampaign[cid] || []).slice(),
      czPayload,
      adMetricRows,
    );
    ads.sort(function (a, b) {
      if (a.czUnidentifiedRow) return 1;
      if (b.czUnidentifiedRow) return -1;
      return (b.gasto || 0) - (a.gasto || 0);
    });
    var rollup = resolveCampaignCzRollup(cid, czPayload, adMetricRows);
    var unidentified = buildUnidentifiedCzSyntheticAd(cid, rollup);
    if (unidentified) {
      var hasUnidentified = ads.some(function (a) {
        return a.czUnidentifiedRow;
      });
      if (!hasUnidentified) ads.push(unidentified);
    }
    return ads
      .map(function (ad) {
        return renderEntityGridAdRow(ad, gridCtx || {});
      })
      .join('');
  }

  function renderCampaignAdsPanelMessages(c, adsDerived) {
    var cid = c.campaign_id != null ? String(c.campaign_id) : null;
    if (!cid) {
      return (
        '<div class="ma-entity-grid-detail ma-ad-panel-muted">Sin ID de campaña para listar anuncios.</div>'
      );
    }
    if (state.adDataError) {
      return (
        '<div class="ma-entity-grid-detail ma-ad-panel-warn">' +
        escapeHtml(state.adDataError) +
        ' Las filas de campaña siguen operativas.</div>'
      );
    }
    if (adsDerived.datasetEmpty) {
      return (
        '<div class="ma-entity-grid-detail ma-ad-panel-muted">' +
        'Histórico por anuncio aún no disponible. Tras migración, sincronización y backfill, los anuncios aparecerán aquí para el período seleccionado.</div>'
      );
    }
    var czPayload =
      adsDerived && adsDerived.czAttribution ? adsDerived.czAttribution : null;
    var rollup = resolveCampaignCzRollup(
      cid,
      czPayload,
      state.adData || [],
    );
    var hasUnidentified =
      rollup &&
      rollup.unidentified &&
      rollup.unidentified.solicitudCount > 0;
    var ads = (adsDerived.adsByCampaign[cid] || []).slice();
    if (!ads.length && !hasUnidentified) {
      return (
        '<div class="ma-entity-grid-detail ma-ad-panel-muted">' +
        'Sin anuncios con datos Meta en este período para esta campaña.</div>'
      );
    }
    return null;
  }

  function renderCampaigns(campList, totalGasto, totalConv, adsDerived, derived) {
    var summaryHtml = renderCzAttributionSummary(
      adsDerived && adsDerived.czAttribution,
      state.czAttributionError,
    );
    if (campList.length === 0) {
      return (
        '<div class="ma-fade">' +
        summaryHtml +
        '<div class="ma-empty">No se encontraron campañas</div></div>'
      );
    }

    var range =
      (adsDerived && adsDerived.range) ||
      (derived && derived.range) ||
      resolvePeriodRange(state.periodPreset, state.customFrom, state.customTo);
    var priorRange = resolvePreviousEquivalentRange(range.from, range.to);
    var campBounds = computeDatasetDateBounds(state.data || []);
    var trendsAllowed =
      !!priorRange &&
      !isPartialMetricDay(range.to) &&
      !!campBounds.minDate &&
      priorRange.from >= campBounds.minDate;
    var gridCtx = {
      range: range,
      priorRange: priorRange,
      trendsAllowed: trendsAllowed,
      allCampRows: state.data || [],
      allAdRows: state.adData || [],
      campRowsInPeriod: (derived && derived.filteredRows) || [],
    };
    var bodyHtml = campList
      .map(function (c) {
        var cidKey = c.campaign_id != null ? String(c.campaign_id) : null;
        var expanded = !!(cidKey && state.expandedCampaignIds[cidKey]);
        var hasAlert = campaignHasAlert(c);
        var entity = buildCampaignEntity(
          c,
          adsDerived,
          gridCtx.campRowsInPeriod,
          range,
          gridCtx.allAdRows,
        );
        var priorEntity = null;
        var trendEnabled = false;
        if (trendsAllowed && priorRange && cidKey) {
          var campOkCur = entityDatesPresent(
            gridCtx.allCampRows,
            range.from,
            range.to,
            function (row) {
              return String(row.campaign_id) === String(cidKey);
            },
            'campaign',
          );
          var campOkPrior = entityDatesPresent(
            gridCtx.allCampRows,
            priorRange.from,
            priorRange.to,
            function (row) {
              return String(row.campaign_id) === String(cidKey);
            },
            'campaign',
          );
          if (campOkCur && campOkPrior) {
            priorEntity = priorCampaignEntity(
              cidKey,
              gridCtx.allCampRows,
              priorRange,
              gridCtx.allAdRows,
              null,
            );
            trendEnabled = !!priorEntity;
          }
        }

        var adsBlock = '';
        if (expanded) {
          var msg = renderCampaignAdsPanelMessages(c, adsDerived);
          adsBlock = msg || renderCampaignAdsPanel(c, adsDerived, gridCtx);
        }

        return (
          '<div class="ma-entity-grid-group">' +
          '<div class="ma-entity-grid-row ma-entity-grid-row--campaign" role="row">' +
          '<div class="ma-entity-grid-cell ma-entity-grid-cell--name" role="cell">' +
          '<div class="ma-entity-name-line ma-entity-name-line--campaign">' +
          '<span class="ma-status-dot" style="color:' +
          (hasAlert ? '#ef4444' : '#22c55e') +
          '">●</span>' +
          '<span class="ma-camp-name" title="' +
          escapeHtml(
            c.name +
              (c.campaign_id ? ' · ID ' + String(c.campaign_id) : '') +
              ' · ' +
              c.dias +
              ' día' +
              (c.dias !== 1 ? 's' : '') +
              ' con datos',
          ) +
          '">' +
          escapeHtml(c.name) +
          '</span>' +
          (hasAlert ? '<span class="ma-ab ma-ab--compact">⚠</span>' : '') +
          (cidKey
            ? '<button type="button" class="ma-ad-toggle ma-ad-toggle--compact" data-ma-action="toggle-campaign-ads" data-campaign-id="' +
              escapeHtml(cidKey) +
              '" title="' +
              (expanded ? 'Ocultar anuncios' : 'Ver anuncios') +
              '">' +
              (expanded ? '▾ Ads' : '▸ Ads') +
              '</button>'
            : '') +
          '</div>' +
          '</div>' +
          renderEntityGridKpiCells(entity, priorEntity, trendEnabled) +
          '</div>' +
          (expanded
            ? '<div class="ma-entity-grid-ads">' + adsBlock + '</div>'
            : '') +
          '</div>'
        );
      })
      .join('');

    return (
      '<div class="ma-fade">' +
      summaryHtml +
      '<div class="ma-entity-grid-scroll">' +
      '<div class="ma-entity-grid" role="table">' +
      renderEntityGridHeader() +
      '<div class="ma-entity-grid-body" role="rowgroup">' +
      bodyHtml +
      '</div>' +
      '</div>' +
      '</div>' +
      '<p class="ma-entity-grid-foot">Conv. Meta = form_step_3. Solic./preaprob./otorg. = Credizona por utm_content=ad_id. Flechas Meta: período anterior equivalente solo con sync completo por día.</p>' +
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
              escapeHtml(fmtUsd(c.cpl)) +
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
      var adsDerived = computeAdsDerived(state.adData, state.czAttribution);
      tabContent = renderCampaigns(
        derived.campList,
        derived.totalGasto,
        derived.totalConv,
        adsDerived,
        derived,
      );
    } else if (state.tab === 'alerts') {
      tabContent = renderAlerts(derived.alertas);
    } else {
      tabContent = renderRaw(state.data);
    }

    return (
      '<div class="ma-body">' +
      renderPeriodBar(derived) +
      renderKpis(derived, derived.filteredRows || state.data) +
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
        } else if (action === 'toggle-liquidity') {
          state.liquidityListOpen = !state.liquidityListOpen;
          render();
        } else if (action === 'apply-period') {
          var fromEl = root.querySelector('[data-ma-period-from]');
          var toEl = root.querySelector('[data-ma-period-to]');
          state.customFrom = fromEl ? fromEl.value : '';
          state.customTo = toEl ? toEl.value : '';
          state.periodPreset = 'custom';
          render();
          loadCzAttribution();
        } else if (action === 'toggle-campaign-ads') {
          var campId = el.getAttribute('data-campaign-id');
          if (!campId) return;
          if (state.expandedCampaignIds[campId]) {
            delete state.expandedCampaignIds[campId];
          } else {
            state.expandedCampaignIds[campId] = true;
          }
          render();
        } else if (action === 'toggle-ad-platform') {
          var adKey = el.getAttribute('data-ad-id');
          if (!adKey) return;
          if (state.expandedPlatformAdIds[adKey]) {
            delete state.expandedPlatformAdIds[adKey];
          } else {
            state.expandedPlatformAdIds[adKey] = true;
          }
          render();
        }
      });
    });

    root.querySelectorAll('[data-ma-period]').forEach(function (el) {
      el.addEventListener('click', function () {
        var preset = el.getAttribute('data-ma-period');
        if (!preset) return;
        state.periodPreset = preset;
        if (preset !== 'custom') {
          render();
          loadCzAttribution();
          return;
        }
        var range = resolvePeriodRange('7d', '', '');
        if (!state.customFrom) state.customFrom = range.from;
        if (!state.customTo) state.customTo = range.to;
        render();
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
      state.data = [];
      state.error = 'No se pudo conectar con Supabase.';
      var errMsg = e && e.message ? e.message : String(e);
      console.error('[meta-agent] loadData own_ad_metrics failed:', errMsg);
    }
    try {
      var adRawRows = await fetchOwnAdAdMetricsRows(cfg);
      state.adData = adRawRows.map(mapOwnAdAdMetricsToLegacyRow);
      state.adDataError = null;
    } catch (adErr) {
      state.adData = [];
      state.adDataError = 'No se pudieron cargar métricas por anuncio.';
      var adErrMsg =
        adErr && adErr.message ? adErr.message : String(adErr);
      console.error('[meta-agent] loadData own_ad_ad_metrics failed:', adErrMsg);
    }
    state.loading = false;
    render();
    loadCzAttribution();
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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      mapOwnAdMetricsToLegacyRow: mapOwnAdMetricsToLegacyRow,
      mapOwnAdAdMetricsToLegacyRow: mapOwnAdAdMetricsToLegacyRow,
      resolvePeriodRange: resolvePeriodRange,
      filterRowsByMetricDate: filterRowsByMetricDate,
      dedupeRowsByAdDate: dedupeRowsByAdDate,
      buildAdListByAdId: buildAdListByAdId,
      groupAdsByCampaignId: groupAdsByCampaignId,
      computeAdsDerived: computeAdsDerived,
      computeAdsDerivedForState: function (
        adData,
        preset,
        customFrom,
        customTo,
        czPayload,
      ) {
        var prev = {
          periodPreset: state.periodPreset,
          customFrom: state.customFrom,
          customTo: state.customTo,
        };
        state.periodPreset = preset;
        state.customFrom = customFrom || '';
        state.customTo = customTo || '';
        var out = computeAdsDerived(adData, czPayload);
        state.periodPreset = prev.periodPreset;
        state.customFrom = prev.customFrom;
        state.customTo = prev.customTo;
        return out;
      },
      toggleExpandedCampaign: function (expandedMap, campaignId) {
        var next = Object.assign({}, expandedMap || {});
        if (next[campaignId]) delete next[campaignId];
        else next[campaignId] = true;
        return next;
      },
      toggleExpandedPlatformAd: function (expandedMap, adKey) {
        var next = Object.assign({}, expandedMap || {});
        if (next[adKey]) delete next[adKey];
        else next[adKey] = true;
        return next;
      },
      adHasPlatformDetail: adHasPlatformDetail,
      platformAdExpandKey: platformAdExpandKey,
      dedupeRowsByCampaignDate: dedupeRowsByCampaignDate,
      buildCampListByCampaignId: buildCampListByCampaignId,
      aggregateAccountPeriod: aggregateAccountPeriod,
      computeCoverage: computeCoverage,
      computeDerivedForState: function (data, preset, customFrom, customTo) {
        var prev = {
          periodPreset: state.periodPreset,
          customFrom: state.customFrom,
          customTo: state.customTo,
        };
        state.periodPreset = preset;
        state.customFrom = customFrom || '';
        state.customTo = customTo || '';
        var out = computeDerived(data);
        state.periodPreset = prev.periodPreset;
        state.customFrom = prev.customFrom;
        state.customTo = prev.customTo;
        return out;
      },
      metaLeadCountFromInsight: metaLeadCountFromInsight,
      lookbackStartDateIso: lookbackStartDateIso,
      computeLatestDateStats: computeLatestDateStats,
      calendarDateInZone: calendarDateInZone,
      shiftIsoDate: shiftIsoDate,
      METRIC_LOOKBACK_DAYS: METRIC_LOOKBACK_DAYS,
      fmtN: fmtN,
      fmtUsd: fmtUsd,
      fmt: fmt,
      ACCOUNT_TIME_ZONE: ACCOUNT_TIME_ZONE,
      CZ: CZ,
      computeAdsDerived: computeAdsDerived,
      czPayloadMatchesPeriod: czPayloadMatchesPeriod,
      loadCzAttribution: loadCzAttribution,
      MA_ENTITY_KPI_COLUMNS: MA_ENTITY_KPI_COLUMNS,
      resolvePreviousEquivalentRange: resolvePreviousEquivalentRange,
      entityDatesPresent: entityDatesPresent,
      formatEntityKpiDisplay: formatEntityKpiDisplay,
      buildCampaignEntity: buildCampaignEntity,
      buildAdEntity: buildAdEntity,
      computeAdsDerivedForPeriod: computeAdsDerivedForPeriod,
      resolveCampaignCzRollup: resolveCampaignCzRollup,
      enrichCampaignAdsWithCzOrphans: enrichCampaignAdsWithCzOrphans,
      buildUnidentifiedCzSyntheticAd: buildUnidentifiedCzSyntheticAd,
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    try {
      var czLib = require('../src/lib/metaAgentCzAttribution');
      Object.keys(czLib).forEach(function (k) {
        if (module.exports[k] === undefined) module.exports[k] = czLib[k];
      });
    } catch (ignoreCzLib) {}
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
