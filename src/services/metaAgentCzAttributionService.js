/**
 * Server-side Credizona ↔ Meta ad attribution (aggregates only).
 */

const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  ACCOUNT_TIME_ZONE,
  buildAdDimensionMap,
  buildAttributedCzToAdMap,
  computeCzAdAttribution,
  computeSolicitudOutcomeFacts,
  dedupeAdMetricRowsByAdDate,
  filterSolicitudesByFechaRegPeriod,
  mergeOutcomesIntoByAdId,
  computeCampaignCzRollups,
  classifyCzSolicitudBucket,
  CZ_ATTRIBUTION_BUCKETS,
  sanitizePublicAttributionPayload,
  uyDayEndExclusiveUtcIso,
  uyDayStartUtcIso,
  validateAttributionDateRange,
  fechaRegCalendarDateUy,
} = require('../lib/metaAgentCzAttribution');
const {
  buildCohortByCzId,
  isGrantedForSolicitud,
} = require('../lib/preaprobadosRead');

const OWN_ENTITY = 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df';
const PAGE_SIZE = 1000;
const IN_CHUNK = 200;
const PREAPROBADOS_ESTADO_ID = 8;

const DATE_SEMANTICS = Object.freeze({
  metaSpend: 'own_ad_ad_metrics.metric_date (America/Montevideo calendar day)',
  metaFormStep3: 'same as metaSpend',
  czSolicitudes:
    'cz_funnel_solicitudes.fecha_reg mapped to Montevideo calendar day within range',
  preaprobados:
    'lifetime on attributed cz_id: CDV cohort (ever estado 8) OR ELM S2 referred/disbursed',
  granted:
    'lifetime on attributed cz_id: cz_funnel_granted_loans / estado 11 OR elm_lead_processes.disbursed_at',
  platformSpend:
    'Meta Insights publisher_platform slices when present on ingested raw_json.platform_slices',
  platformOutcomes:
    'not attributed — Credizona tracking has no verified publisher_platform dimension',
});

const LIMITATIONS = Object.freeze([
  'form_step_3 (Meta) and Credizona solicitudes (cz_id) are separate counters.',
  'Preaprobados and granted use financiera rules with one count per solicitud across CDV+ELM.',
  'Platform breakdown for outcomes shows "No atribuible por plataforma" unless future tracking exists.',
  'Meta platform spend requires ingest with breakdown=publisher_platform (platform_slices in raw_json).',
]);

async function fetchAllSolicitudesInUtcWindow(utcStart, utcEndExclusive) {
  var from = 0;
  var all = [];
  while (true) {
    var res = await supabase
      .from('cz_funnel_solicitudes')
      .select('cz_id, ci, fecha_reg, tracking_data_summary')
      .gte('fecha_reg', utcStart)
      .lt('fecha_reg', utcEndExclusive)
      .order('fecha_reg', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (res.error) {
      throw new Error('cz_funnel_solicitudes read failed');
    }
    var chunk = res.data || [];
    for (var i = 0; i < chunk.length; i++) {
      all.push(chunk[i]);
    }
    if (chunk.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function fetchAdMetricsForDimension(entityId, from, to) {
  var fromIdx = 0;
  var all = [];
  while (true) {
    var res = await supabase
      .from('own_ad_ad_metrics')
      .select(
        'entity_id,campaign_id,ad_id,metric_date,created_at',
      )
      .eq('entity_id', entityId)
      .gte('metric_date', from)
      .lte('metric_date', to)
      .order('metric_date', { ascending: true })
      .range(fromIdx, fromIdx + PAGE_SIZE - 1);
    if (res.error) {
      throw new Error('own_ad_ad_metrics read failed');
    }
    var chunk = res.data || [];
    for (var i = 0; i < chunk.length; i++) {
      all.push(chunk[i]);
    }
    if (chunk.length < PAGE_SIZE) break;
    fromIdx += PAGE_SIZE;
  }
  return dedupeAdMetricRowsByAdDate(all);
}

async function fetchRowsInChunks(table, column, ids, select, orderCol) {
  var out = [];
  var list = Array.isArray(ids) ? ids.slice() : [];
  for (var i = 0; i < list.length; i += IN_CHUNK) {
    var chunk = list.slice(i, i + IN_CHUNK);
    var res = await supabase
      .from(table)
      .select(select)
      .in(column, chunk)
      .order(orderCol || column, { ascending: true });
    if (res.error) {
      throw new Error(table + ' read failed');
    }
    out = out.concat(res.data || []);
  }
  return out;
}

async function buildOutcomeByCzId(attributedCzIds, solicitudRows) {
  var outcomeByCzId = new Map();
  if (!attributedCzIds.length) return outcomeByCzId;

  var historicoEstado8 = await fetchRowsInChunks(
    'cz_funnel_solicitud_estados',
    'cz_solicitud_id',
    attributedCzIds,
    'cz_solicitud_id, solicitudes_estados_id, fechahora_src',
    'cz_historico_id',
  );
  historicoEstado8 = historicoEstado8.filter(function (row) {
    return Number(row.solicitudes_estados_id) === PREAPROBADOS_ESTADO_ID;
  });

  var currentEstado8 = (solicitudRows || []).filter(function (row) {
    return (
      attributedCzIds.indexOf(Number(row.cz_id)) >= 0 &&
      Number(row.solicitudes_estados_id) === PREAPROBADOS_ESTADO_ID
    );
  });

  var cohortMap = buildCohortByCzId(historicoEstado8, currentEstado8);

  var grantedRows = await fetchRowsInChunks(
    'cz_funnel_granted_loans',
    'cz_id',
    attributedCzIds,
    'cz_id, monto_otorgado, updated_at_src',
    'cz_id',
  );
  var grantedByCzId = new Map();
  grantedRows.forEach(function (g) {
    if (g && g.cz_id != null) grantedByCzId.set(Number(g.cz_id), g);
  });

  var solByCz = new Map();
  (solicitudRows || []).forEach(function (s) {
    if (s && s.cz_id != null) solByCz.set(Number(s.cz_id), s);
  });

  var elmRows = await fetchRowsInChunks(
    'elm_lead_processes',
    'cz_solicitud_id',
    attributedCzIds,
    'cz_solicitud_id, s2_status, disbursed_at, provider_status',
    'cz_solicitud_id',
  );
  var elmByCz = new Map();
  elmRows.forEach(function (p) {
    if (p && p.cz_solicitud_id != null) {
      elmByCz.set(Number(p.cz_solicitud_id), p);
    }
  });

  attributedCzIds.forEach(function (czId) {
    var sol = solByCz.get(czId) || null;
    var elm = elmByCz.get(czId) || null;
    var elmDisbursed = !!(elm && elm.disbursed_at);
    var elmReferred =
      !!(
        elm &&
        String(elm.s2_status || '') === 'referred' &&
        !elmDisbursed
      );
    var facts = computeSolicitudOutcomeFacts({
      cdvCohort: cohortMap.has(czId),
      grantedCdv: isGrantedForSolicitud(czId, grantedByCzId, sol),
      elmReferred: elmReferred,
      elmDisbursed: elmDisbursed,
    });
    outcomeByCzId.set(czId, facts);
  });

  return outcomeByCzId;
}

function calendarDateInZoneUy(d) {
  return fechaRegCalendarDateUy(d, function (now) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: ACCOUNT_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
    } catch (e) {
      return null;
    }
  });
}

/**
 * @param {{ from: string, to: string, entityId?: string }} input
 */
async function buildCzAttributionAggregates(input) {
  var validated = validateAttributionDateRange(input.from, input.to);
  if (!validated.ok) {
    var err = new Error(validated.message);
    err.code = validated.code;
    err.status = 400;
    throw err;
  }

  var entityId = input.entityId || OWN_ENTITY;
  var from = validated.from;
  var to = validated.to;

  var utcStart = uyDayStartUtcIso(from);
  var utcEndExclusive = uyDayEndExclusiveUtcIso(to);

  var solicitudesRaw = await fetchAllSolicitudesInUtcWindow(
    utcStart,
    utcEndExclusive,
  );
  var solicitudes = filterSolicitudesByFechaRegPeriod(
    solicitudesRaw,
    from,
    to,
    calendarDateInZoneUy,
  );

  var adMetricRows = await fetchAdMetricsForDimension(entityId, from, to);
  var adDim = buildAdDimensionMap(adMetricRows, entityId);
  var attribution = computeCzAdAttribution(
    solicitudes,
    adDim,
    entityId,
    calendarDateInZoneUy,
  );

  var czToAd = buildAttributedCzToAdMap(solicitudes, adDim, entityId);
  var attributedCzIds = Array.from(czToAd.keys());

  var pendingCzIds = [];
  solicitudes.forEach(function (row) {
    if (!row || row.cz_id == null) return;
    var summary =
      row.tracking_data_summary && typeof row.tracking_data_summary === 'object'
        ? row.tracking_data_summary
        : {};
    var bucket = classifyCzSolicitudBucket(summary, adDim, entityId);
    if (bucket === CZ_ATTRIBUTION_BUCKETS.META_AD_PENDING) {
      pendingCzIds.push(Number(row.cz_id));
    }
  });
  var outcomeCzIds = attributedCzIds.slice();
  pendingCzIds.forEach(function (id) {
    if (outcomeCzIds.indexOf(id) < 0) outcomeCzIds.push(id);
  });

  var solicitudesWithEstado = solicitudesRaw;
  if (outcomeCzIds.length) {
    solicitudesWithEstado = await fetchRowsInChunks(
      'cz_funnel_solicitudes',
      'cz_id',
      outcomeCzIds,
      'cz_id, ci, fecha_reg, solicitudes_estados_id, tracking_data_summary',
      'cz_id',
    );
  }

  var outcomeByCzId = await buildOutcomeByCzId(
    outcomeCzIds,
    solicitudesWithEstado,
  );
  attribution.byAdId = mergeOutcomesIntoByAdId(
    attribution.byAdId,
    czToAd,
    outcomeByCzId,
  );
  attribution.byCampaignId = computeCampaignCzRollups(
    solicitudes,
    adDim,
    entityId,
    attribution.byAdId,
    outcomeByCzId,
  );
  attribution.dateSemantics = DATE_SEMANTICS;
  attribution.limitations = LIMITATIONS;

  return sanitizePublicAttributionPayload(attribution, {
    entityId: entityId,
    timezone: ACCOUNT_TIME_ZONE,
    from: from,
    to: to,
  });
}

module.exports = {
  OWN_ENTITY,
  buildCzAttributionAggregates,
  fetchAllSolicitudesInUtcWindow,
  fetchAdMetricsForDimension,
};
