/**
 * Credizona solicitud ↔ Meta ad attribution (UTM exact match).
 * Used by public/meta-agent.js and unit tests.
 */

const META_PAID_UTM_SOURCES = Object.freeze([
  'meta',
  'facebook',
  'instagram',
  'fb',
  'ig',
]);

const CZ_ATTRIBUTION_BUCKETS = Object.freeze({
  META_AD_ATTRIBUTED: 'meta_ad_attributed',
  META_AD_PENDING: 'meta_ad_pending',
  META_NO_AD: 'meta_no_ad',
  UNKNOWN_ORIGIN: 'unknown_origin',
  OTHER_CHANNEL: 'other_channel',
});

function trimLower(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim().toLowerCase();
}

function isNumericMetaId(val) {
  if (val === null || val === undefined) return false;
  return /^[0-9]+$/.test(String(val).trim());
}

function trackingSummaryObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function isMetaPaidUtmSource(source) {
  return META_PAID_UTM_SOURCES.indexOf(trimLower(source)) >= 0;
}

function isRecognizedNonMetaChannel(summary) {
  var src = trimLower(summary.utm_source);
  if (src === 'sms') return true;
  // Meta paid landings may still carry jt (see cz funnel sync); do not demote those to SMS/JT channel.
  if (isMetaPaidUtmSource(summary.utm_source)) return false;
  if (summary.jt && String(summary.jt).trim()) return true;
  return false;
}

function hasAnyUtmSignal(summary) {
  return !!(
    trimLower(summary.utm_source) ||
    trimLower(summary.utm_medium) ||
    trimLower(summary.utm_campaign) ||
    trimLower(summary.utm_content) ||
    trimLower(summary.utm_term)
  );
}

/**
 * @param {object} summary tracking_data_summary
 * @param {Map<string, { campaign_id: string, entity_id: string }>} adDim
 * @param {string|null} entityId expected own entity
 */
function classifyCzSolicitudBucket(summary, adDim, entityId) {
  var s = trackingSummaryObject(summary);
  if (trimLower(s.utm_source) === 'sms') {
    return CZ_ATTRIBUTION_BUCKETS.OTHER_CHANNEL;
  }
  if (isRecognizedNonMetaChannel(s)) {
    return CZ_ATTRIBUTION_BUCKETS.OTHER_CHANNEL;
  }
  if (!isMetaPaidUtmSource(s.utm_source)) {
    return hasAnyUtmSignal(s)
      ? CZ_ATTRIBUTION_BUCKETS.OTHER_CHANNEL
      : CZ_ATTRIBUTION_BUCKETS.UNKNOWN_ORIGIN;
  }
  if (!isNumericMetaId(s.utm_content) || !isNumericMetaId(s.utm_campaign)) {
    return CZ_ATTRIBUTION_BUCKETS.META_NO_AD;
  }
  var adId = String(s.utm_content).trim();
  var dim = adDim && adDim.get(adId);
  if (!dim) {
    return CZ_ATTRIBUTION_BUCKETS.META_AD_PENDING;
  }
  if (entityId && dim.entity_id && String(dim.entity_id) !== String(entityId)) {
    return CZ_ATTRIBUTION_BUCKETS.META_AD_PENDING;
  }
  if (String(dim.campaign_id) !== String(s.utm_campaign).trim()) {
    return CZ_ATTRIBUTION_BUCKETS.META_AD_PENDING;
  }
  return CZ_ATTRIBUTION_BUCKETS.META_AD_ATTRIBUTED;
}

/**
 * Build ad_id → { campaign_id, entity_id } from deduped daily ad metric rows.
 */
function buildAdDimensionMap(adMetricRows, entityId) {
  var map = new Map();
  (adMetricRows || []).forEach(function (row) {
    if (!row || row.ad_id == null) return;
    var adId = String(row.ad_id).trim();
    if (!adId) return;
    var ent =
      row.entity_id != null ? String(row.entity_id) : entityId != null ? String(entityId) : '';
    var camp =
      row.campaign_id != null && String(row.campaign_id) !== ''
        ? String(row.campaign_id)
        : null;
    if (!map.has(adId)) {
      map.set(adId, { campaign_id: camp, entity_id: ent });
      return;
    }
    var prev = map.get(adId);
    if (!prev.campaign_id && camp) prev.campaign_id = camp;
    if (!prev.entity_id && ent) prev.entity_id = ent;
  });
  return map;
}

function fechaRegCalendarDateUy(iso, calendarDateInZoneFn) {
  if (!iso) return null;
  var d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  if (typeof calendarDateInZoneFn === 'function') {
    return calendarDateInZoneFn(d);
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Montevideo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch (e) {
    return null;
  }
}

function filterSolicitudesByFechaRegPeriod(rows, from, to, calendarDateInZoneFn) {
  if (!from || !to) return rows || [];
  return (rows || []).filter(function (row) {
    var d = fechaRegCalendarDateUy(row.fecha_reg, calendarDateInZoneFn);
    return d && d >= from && d <= to;
  });
}

function emptyBucket() {
  return { _czIds: {}, _cis: {} };
}

function addToBucket(bucket, czId, ci) {
  if (czId != null) bucket._czIds[String(czId)] = true;
  if (ci != null && ci !== '') bucket._cis[String(ci)] = true;
}

function finalizeBucket(bucket) {
  return {
    solicitudes: Object.keys(bucket._czIds).length,
    uniqueCi: Object.keys(bucket._cis).length,
  };
}

function computeCiOverlapStats(byAdIdInternal, globalCiKeys) {
  var ciToAdCount = {};
  var sumPerAdCi = 0;
  Object.keys(byAdIdInternal).forEach(function (adId) {
    var cis = Object.keys(byAdIdInternal[adId]._cis);
    sumPerAdCi += cis.length;
    cis.forEach(function (ci) {
      ciToAdCount[ci] = (ciToAdCount[ci] || 0) + 1;
    });
  });
  var multiAdCiCount = 0;
  Object.keys(ciToAdCount).forEach(function (ci) {
    if (ciToAdCount[ci] > 1) multiAdCiCount += 1;
  });
  var globalUniqueCi = globalCiKeys ? globalCiKeys.length : 0;
  return {
    sumUniqueCiByAd: sumPerAdCi,
    globalUniqueCi: globalUniqueCi,
    excessFromMultiAd: sumPerAdCi - globalUniqueCi,
    ciPresentInMultipleAdsCount: multiAdCiCount,
  };
}

const ACCOUNT_TIME_ZONE = 'America/Montevideo';
const MAX_ATTRIBUTION_RANGE_DAYS = 90;

function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function shiftIsoDate(dateStr, deltaDays) {
  var parts = String(dateStr).split('-').map(Number);
  var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

function enumerateInclusiveDates(from, to) {
  var dates = [];
  var cur = from;
  while (cur <= to) {
    dates.push(cur);
    cur = shiftIsoDate(cur, 1);
  }
  return dates;
}

/**
 * Validate inclusive calendar range (UY dashboard dates).
 * @returns {{ ok: true, from: string, to: string, dayCount: number } | { ok: false, code: string, message: string }}
 */
function validateAttributionDateRange(from, to, maxDays) {
  var max = maxDays != null ? maxDays : MAX_ATTRIBUTION_RANGE_DAYS;
  var f = from != null ? String(from).trim() : '';
  var t = to != null ? String(to).trim() : '';
  if (!isValidDateOnly(f) || !isValidDateOnly(t)) {
    return { ok: false, code: 'invalid_date', message: 'Fechas inválidas' };
  }
  if (f > t) {
    return { ok: false, code: 'inverted_range', message: 'from debe ser <= to' };
  }
  var days = enumerateInclusiveDates(f, t).length;
  if (days > max) {
    return {
      ok: false,
      code: 'range_too_large',
      message: 'El rango no puede superar ' + max + ' días',
    };
  }
  return { ok: true, from: f, to: t, dayCount: days };
}

/** Montevideo calendar day start as UTC instant (UY = UTC-3, no DST). */
function uyDayStartUtcIso(dateStr) {
  return dateStr + 'T03:00:00.000Z';
}

function uyDayEndExclusiveUtcIso(dateStr) {
  return shiftIsoDate(dateStr, 1) + 'T03:00:00.000Z';
}

function sanitizePublicAttributionPayload(attribution, meta) {
  var overlap = attribution.ciOverlap || {};
  return {
    entityId: meta.entityId,
    timezone: meta.timezone || ACCOUNT_TIME_ZONE,
    range: { from: meta.from, to: meta.to },
    dateSemantics: attribution.dateSemantics || null,
    limitations: attribution.limitations || null,
    byAdId: attribution.byAdId,
    buckets: attribution.buckets,
    globalAttributed: attribution.globalAttributed,
    ciOverlap: {
      sumUniqueCiByAd: overlap.sumUniqueCiByAd,
      globalUniqueCi: overlap.globalUniqueCi,
      excessFromMultiAd: overlap.excessFromMultiAd,
      ciPresentInMultipleAdsCount: overlap.ciPresentInMultipleAdsCount,
    },
    pendingAdIds: attribution.pendingAdIds || [],
  };
}

/**
 * @returns {{
 *   byAdId: Record<string, { solicitudCount: number, uniqueCi: number }>,
 *   buckets: Record<string, { solicitudes: number, uniqueCi: number }>,
 *   globalAttributed: { solicitudCount: number, uniqueCi: number }
 * }}
 */
function computeCzAdAttribution(solicitudes, adDim, entityId, calendarDateInZoneFn) {
  var byAdIdInternal = {};
  var bucketsInternal = {};
  Object.keys(CZ_ATTRIBUTION_BUCKETS).forEach(function (k) {
    bucketsInternal[CZ_ATTRIBUTION_BUCKETS[k]] = emptyBucket();
  });
  var globalCz = {};
  var globalCi = {};

  (solicitudes || []).forEach(function (row) {
    if (!row || row.cz_id == null) return;
    var summary = trackingSummaryObject(row.tracking_data_summary);
    var bucket = classifyCzSolicitudBucket(summary, adDim, entityId);
    addToBucket(bucketsInternal[bucket], row.cz_id, row.ci);

    if (bucket === CZ_ATTRIBUTION_BUCKETS.META_AD_ATTRIBUTED) {
      var adId = String(summary.utm_content).trim();
      if (!byAdIdInternal[adId]) {
        byAdIdInternal[adId] = { _czIds: {}, _cis: {} };
      }
      byAdIdInternal[adId]._czIds[String(row.cz_id)] = true;
      if (row.ci != null && row.ci !== '') {
        byAdIdInternal[adId]._cis[String(row.ci)] = true;
      }
      globalCz[String(row.cz_id)] = true;
      if (row.ci != null && row.ci !== '') globalCi[String(row.ci)] = true;
    }
  });

  var byAdId = {};
  Object.keys(byAdIdInternal).forEach(function (adId) {
    var b = byAdIdInternal[adId];
    byAdId[adId] = {
      solicitudCount: Object.keys(b._czIds).length,
      uniqueCi: Object.keys(b._cis).length,
    };
  });

  var buckets = {};
  Object.keys(bucketsInternal).forEach(function (key) {
    buckets[key] = finalizeBucket(bucketsInternal[key]);
  });

  var globalAttributed = {
    solicitudCount: Object.keys(globalCz).length,
    uniqueCi: Object.keys(globalCi).length,
  };

  var pendingAdIds = {};
  (solicitudes || []).forEach(function (row) {
    if (!row || row.cz_id == null) return;
    var summary = trackingSummaryObject(row.tracking_data_summary);
    var bucket = classifyCzSolicitudBucket(summary, adDim, entityId);
    if (bucket === CZ_ATTRIBUTION_BUCKETS.META_AD_PENDING && isNumericMetaId(summary.utm_content)) {
      pendingAdIds[String(summary.utm_content).trim()] = true;
    }
  });

  return {
    byAdId: byAdId,
    buckets: buckets,
    globalAttributed: globalAttributed,
    ciOverlap: computeCiOverlapStats(byAdIdInternal, Object.keys(globalCi)),
    pendingAdIds: Object.keys(pendingAdIds),
  };
}

function costPerResult(gasto, count) {
  if (gasto === null || gasto === undefined || !count || count <= 0) return null;
  return gasto / count;
}

function attachCzStatsToAdList(adList, byAdId) {
  return (adList || []).map(function (ad) {
    var stats = (byAdId && ad.ad_id != null && byAdId[String(ad.ad_id)]) || null;
    var czSolicitudes = stats ? stats.solicitudCount : 0;
    var czUniqueCi = stats ? stats.uniqueCi : 0;
    var preaprobados = stats ? stats.preaprobadosCount || 0 : 0;
    var granted = stats ? stats.grantedCount || 0 : 0;
    var gasto = ad.gasto;
    return Object.assign({}, ad, {
      czSolicitudes: czSolicitudes,
      czUniqueCi: czUniqueCi,
      czPreaprobados: preaprobados,
      czGranted: granted,
      cplCz: costPerResult(gasto, czSolicitudes),
      cplCzSinSolicitudes: czSolicitudes === 0,
      costPerPreaprob: costPerResult(gasto, preaprobados),
      costPerGranted: costPerResult(gasto, granted),
      czPreaprobSinDatos: preaprobados === 0 && czSolicitudes > 0,
      czGrantedSinDatos: granted === 0 && czSolicitudes > 0,
    });
  });
}

/**
 * Roll up per-cz_id outcomes (deduped across CDV/ELM) into byAdId aggregates.
 * @param {Record<string, { solicitudCount: number, uniqueCi: number }>} byAdId
 * @param {Map<number, { adId: string, czId: number }>} attributedCzToAd
 * @param {Map<number, { preaprobado: boolean, granted: boolean, lender?: string|null }>} outcomeByCzId
 */
function mergeOutcomesIntoByAdId(byAdId, attributedCzToAd, outcomeByCzId) {
  var next = {};
  Object.keys(byAdId || {}).forEach(function (adId) {
    next[adId] = Object.assign({}, byAdId[adId], {
      preaprobadosCount: 0,
      grantedCount: 0,
    });
  });
  (attributedCzToAd || new Map()).forEach(function (meta, czId) {
    var adId = meta && meta.adId;
    if (!adId || !next[adId]) return;
    var out = outcomeByCzId && outcomeByCzId.get(Number(czId));
    if (!out) return;
    if (out.preaprobado) next[adId].preaprobadosCount += 1;
    if (out.granted) next[adId].grantedCount += 1;
  });
  return next;
}

/**
 * Build cz_id → ad_id map for META_AD_ATTRIBUTED solicitudes (deduped by cz_id).
 */
function buildAttributedCzToAdMap(solicitudes, adDim, entityId) {
  var map = new Map();
  (solicitudes || []).forEach(function (row) {
    if (!row || row.cz_id == null) return;
    var summary = trackingSummaryObject(row.tracking_data_summary);
    var bucket = classifyCzSolicitudBucket(summary, adDim, entityId);
    if (bucket !== CZ_ATTRIBUTION_BUCKETS.META_AD_ATTRIBUTED) return;
    var adId = String(summary.utm_content).trim();
    map.set(Number(row.cz_id), { adId: adId, czId: Number(row.cz_id) });
  });
  return map;
}

/**
 * One preaprobado / granted per solicitud (CDV and/or ELM collapse to 1).
 * @param {number} czId
 * @param {{ cdvCohort: boolean, grantedCdv: boolean, elmReferred: boolean, elmDisbursed: boolean }} facts
 */
function computeSolicitudOutcomeFacts(facts) {
  var preaprobado = !!(facts.cdvCohort || facts.elmReferred || facts.elmDisbursed);
  var granted = !!(facts.grantedCdv || facts.elmDisbursed);
  var lender = null;
  if (facts.grantedCdv && facts.elmDisbursed) lender = 'cdv_and_elm';
  else if (facts.grantedCdv) lender = 'cdv';
  else if (facts.elmDisbursed) lender = 'elm';
  return { preaprobado: preaprobado, granted: granted, lender: lender };
}

/** Meta publisher_platform spend from optional platform_slices on ingested raw_json. */
function aggregatePlatformSpendForAd(dedupedAdRows, from, to) {
  var totals = {};
  (dedupedAdRows || []).forEach(function (row) {
    if (!row || row.ad_id == null) return;
    var d = String(row.metric_date || '');
    if (from && d && d < from) return;
    if (to && d && d > to) return;
    var raw = row.raw_json;
    var slices =
      raw && typeof raw === 'object' && Array.isArray(raw.platform_slices)
        ? raw.platform_slices
        : null;
    if (!slices || !slices.length) return;
    var adKey = String(row.ad_id);
    if (!totals[adKey]) totals[adKey] = {};
    slices.forEach(function (sl) {
      if (!sl || !sl.publisher_platform) return;
      var plat = String(sl.publisher_platform).trim().toLowerCase();
      if (!plat) return;
      var spend = parseFloat(sl.spend);
      if (!Number.isFinite(spend)) return;
      totals[adKey][plat] = (totals[adKey][plat] || 0) + spend;
    });
  });
  return totals;
}

function formatPlatformLabel(platform) {
  var p = trimLower(platform);
  if (p === 'facebook') return 'Facebook';
  if (p === 'instagram') return 'Instagram';
  if (p === 'audience_network') return 'Audience Network';
  if (p === 'messenger') return 'Messenger';
  if (!p) return 'Sin datos';
  return platform;
}

/** Channel helper aligned with cz_funnel_channel_utility_live (post-migration). */
function czFunnelChannelFromUtmSource(source) {
  var src = trimLower(source);
  if (src === 'sms') return 'sms';
  if (META_PAID_UTM_SOURCES.indexOf(src) >= 0) return 'meta';
  return 'sin_atribuir';
}

module.exports = {
  META_PAID_UTM_SOURCES,
  CZ_ATTRIBUTION_BUCKETS,
  ACCOUNT_TIME_ZONE,
  MAX_ATTRIBUTION_RANGE_DAYS,
  isNumericMetaId,
  isMetaPaidUtmSource,
  classifyCzSolicitudBucket,
  buildAdDimensionMap,
  filterSolicitudesByFechaRegPeriod,
  computeCzAdAttribution,
  attachCzStatsToAdList,
  mergeOutcomesIntoByAdId,
  buildAttributedCzToAdMap,
  computeSolicitudOutcomeFacts,
  aggregatePlatformSpendForAd,
  formatPlatformLabel,
  costPerResult,
  czFunnelChannelFromUtmSource,
  fechaRegCalendarDateUy,
  validateAttributionDateRange,
  uyDayStartUtcIso,
  uyDayEndExclusiveUtcIso,
  sanitizePublicAttributionPayload,
  computeCiOverlapStats,
  dedupeAdMetricRowsByAdDate,
};

/**
 * Keep newest created_at per (ad_id, metric_date) — same rule as meta-agent UI.
 */
function dedupeAdMetricRowsByAdDate(rows) {
  var best = new Map();
  (rows || []).forEach(function (row) {
    if (!row || row.ad_id == null || !row.metric_date) return;
    var key = String(row.ad_id) + '|' + String(row.metric_date);
    var prev = best.get(key);
    if (!prev || String(row.created_at || '') > String(prev.created_at || '')) {
      best.set(key, row);
    }
  });
  return Array.from(best.values());
}
