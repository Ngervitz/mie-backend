const express = require('express');
const multer = require('multer');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  isMarketExitConfirmed,
  normalizeSnapshotStatus,
} = require('../steps/market-exit');
const {
  generateSeoLandingDraft,
  regenerateSeoLandingDraft,
  hasActiveDraft,
} = require('../services/seo-landing-generator');
const {
  MAX_FILE_BYTES,
  importGoogleSerpHtml,
  listGoogleSerpImports,
  getGoogleSerpImportAds,
  getGoogleSerpCompetitorPresence,
  normalizeDomain,
} = require('../steps/collectGoogleSerpImports');
const { computeAuctionPressure } = require('../services/auction-pressure');
const {
  getPropertyId,
  buildGa4Client,
  metricCellToNumber,
} = require('../steps/collectGa4Metrics');
const {
  formatYmdMontevideo,
  addCalendarDays,
  mondayOfYmd,
  YMD_RE,
} = require('../lib/montevideo-week');

const router = express.Router();

const MOVEMENT_EVENT_TYPES = [
  'new_ad',
  'copy_changed',
  'ad_reactivated',
  'ad_deactivated',
];
const EVENTS_PAGE_SIZE = 1000;
const MAX_ACTIVITY_WEEKLY_WEEKS = 26;
const PHASE_TIEBREAK_ORDER = ['alta_demanda', 'mitad_mes', 'cierre_mes'];

/** Last N complete Mon–Sun weeks (America/Montevideo), excluding current week. */
function resolveLastCompleteWeeks(count = 8) {
  const currentMonday = mondayOfYmd(formatYmdMontevideo(new Date()));
  const lastCompleteMonday = addCalendarDays(currentMonday, -7);
  const weeks = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    weeks.push(addCalendarDays(lastCompleteMonday, -7 * i));
  }
  return weeks;
}

/**
 * Optional ?from=&to= (YYYY-MM-DD), snapped to Monday. Default: last 8 complete weeks.
 * @returns {{ weeks: string[] } | { error: string }}
 */
function resolveWeeksFromRange(fromRaw, toRaw) {
  const hasFrom = fromRaw != null && String(fromRaw).trim() !== '';
  const hasTo = toRaw != null && String(toRaw).trim() !== '';
  if (!hasFrom && !hasTo) {
    return { weeks: resolveLastCompleteWeeks(8) };
  }
  if (!hasFrom || !hasTo) {
    return {
      error: 'from y to deben enviarse juntos (YYYY-MM-DD), o ninguno',
    };
  }
  const fromStr = String(fromRaw).trim();
  const toStr = String(toRaw).trim();
  if (!YMD_RE.test(fromStr) || !YMD_RE.test(toStr)) {
    return { error: 'from y to deben tener formato YYYY-MM-DD' };
  }
  const fromMonday = mondayOfYmd(fromStr);
  const toMonday = mondayOfYmd(toStr);
  if (fromMonday > toMonday) {
    return { error: 'from no puede ser posterior a to' };
  }
  const weeks = [];
  for (let w = fromMonday; w <= toMonday; w = addCalendarDays(w, 7)) {
    weeks.push(w);
    if (weeks.length > MAX_ACTIVITY_WEEKLY_WEEKS) {
      return {
        error:
          'El rango no puede superar ' +
          MAX_ACTIVITY_WEEKLY_WEEKS +
          ' semanas',
      };
    }
  }
  return { weeks };
}

/**
 * Majority cycle_phase for Mon–Sun week. Tie → PHASE_TIEBREAK_ORDER.
 * No logged days → null.
 * @param {string} weekOf
 * @param {Map<string, string>} phaseByDate
 * @returns {string|null}
 */
function dominantPhaseForWeek(weekOf, phaseByDate) {
  const counts = { alta_demanda: 0, mitad_mes: 0, cierre_mes: 0 };
  let any = 0;
  for (let d = 0; d < 7; d += 1) {
    const day = addCalendarDays(weekOf, d);
    const phase = phaseByDate.get(day);
    if (phase && Object.prototype.hasOwnProperty.call(counts, phase)) {
      counts[phase] += 1;
      any += 1;
    }
  }
  if (!any) return null;
  let best = null;
  let bestN = -1;
  for (const phase of PHASE_TIEBREAK_ORDER) {
    if (counts[phase] > bestN) {
      bestN = counts[phase];
      best = phase;
    }
  }
  return best;
}

async function loadMovementEventsForEntities(entityIds, minDate, maxDate) {
  const rows = [];
  if (!entityIds.length) return rows;
  for (let from = 0; ; from += EVENTS_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('events')
      .select('id, entity_id, detected_at, event_type')
      .in('entity_id', entityIds)
      .in('event_type', MOVEMENT_EVENT_TYPES)
      .gte('detected_at', minDate)
      .lte('detected_at', maxDate)
      .order('detected_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + EVENTS_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Failed to load events: ${error.message}`);
    }
    rows.push(...(data || []));
    if (!data || data.length < EVENTS_PAGE_SIZE) break;
  }
  return rows;
}

const serpHtmlUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const name = String(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const okExt = name.endsWith('.html') || name.endsWith('.htm');
    const okMime =
      !mime ||
      mime === 'text/html' ||
      mime === 'application/xhtml+xml' ||
      mime === 'application/octet-stream';
    if (okExt || okMime) return cb(null, true);
    const err = new Error('Solo se aceptan archivos .html');
    err.statusCode = 400;
    err.code = 'INVALID_FILE_TYPE';
    return cb(err);
  },
});

const EVENT_TYPE_TO_STAT = {
  new_ad: 'newAds',
  copy_changed: 'copyChanges',
  ad_reactivated: 'reactivations',
  ad_deactivated: 'deactivations',
};

function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function todayUtc() {
  return new Date().toISOString().split('T')[0];
}

function emptyEntityCounts() {
  return {
    totalEvents: 0,
    newAds: 0,
    copyChanges: 0,
    reactivations: 0,
    deactivations: 0,
  };
}

const STRATEGIC_ENTITIES = [
  'Creditel',
  'Crédito de Valor',
  'Pronto+',
  'Cash',
  'Crediton',
  'Credifama',
];

const STRATEGIC_SET = new Set(STRATEGIC_ENTITIES);

const HISTORY_WINDOW_DAYS = 30;

const ATTENTION_RANK = ['normal', 'interesting', 'high_activity', 'strategic_movement'];

function isStrategicName(entityName) {
  return entityName !== null && entityName !== undefined && STRATEGIC_SET.has(entityName);
}

// Shift a YYYY-MM-DD string by deltaDays in UTC, returning YYYY-MM-DD.
function shiftDateUtc(dateStr, deltaDays) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

function tallyEvent(counts, eventType, unknownTypes) {
  counts.totalEvents += 1;
  const statKey = EVENT_TYPE_TO_STAT[eventType];
  if (statKey) {
    counts[statKey] += 1;
  } else {
    unknownTypes.add(eventType);
  }
}

router.get('/daily-summary', async (req, res) => {
  const rawDate = req.query?.date;

  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (!isValidDateOnly(String(rawDate))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
  }

  const date = rawDate ? String(rawDate) : todayUtc();

  logger.info('Reports daily-summary requested', { date });

  try {
    const { data: eventRows, error: eventsError } = await supabase
      .from('events')
      .select('entity_id, ad_id, event_type, severity, detected_at, previous_value, new_value')
      .eq('detected_at', date);

    if (eventsError) {
      throw new Error(`Failed to fetch events: ${eventsError.message}`);
    }

    const events = eventRows || [];

    const entityIds = [...new Set(events.map((e) => e.entity_id).filter(Boolean))];
    const entityNameMap = new Map();

    if (entityIds.length > 0) {
      const { data: entityRows, error: entitiesError } = await supabase
        .from('monitored_entities')
        .select('id, name')
        .in('id', entityIds);

      if (entitiesError) {
        throw new Error(`Failed to fetch monitored_entities: ${entitiesError.message}`);
      }

      for (const row of entityRows || []) {
        entityNameMap.set(row.id, row.name ?? null);
      }
    }

    const stats = {
      totalEvents: 0,
      newAds: 0,
      copyChanges: 0,
      reactivations: 0,
      deactivations: 0,
      activeEntities: entityIds.length,
    };

    const byEntityMap = new Map();
    const cleanEvents = [];

    for (const event of events) {
      const entityId = event.entity_id;
      const entityName = entityNameMap.get(entityId) ?? null;
      const statKey = EVENT_TYPE_TO_STAT[event.event_type];

      stats.totalEvents += 1;
      if (statKey) {
        stats[statKey] += 1;
      }

      if (!byEntityMap.has(entityId)) {
        byEntityMap.set(entityId, {
          entityId,
          entityName,
          ...emptyEntityCounts(),
        });
      }

      const entityBucket = byEntityMap.get(entityId);
      entityBucket.totalEvents += 1;
      if (statKey) {
        entityBucket[statKey] += 1;
      }

      cleanEvents.push({
        entityId,
        entityName,
        adId: event.ad_id ?? null,
        eventType: event.event_type,
        severity: event.severity ?? null,
        detectedAt: event.detected_at,
        previousValue: event.previous_value ?? null,
        newValue: event.new_value ?? null,
      });
    }

    cleanEvents.sort((a, b) => {
      const sevDiff = (b.severity ?? 0) - (a.severity ?? 0);
      if (sevDiff !== 0) return sevDiff;

      const nameDiff = String(a.entityName ?? '').localeCompare(String(b.entityName ?? ''));
      if (nameDiff !== 0) return nameDiff;

      return String(a.eventType).localeCompare(String(b.eventType));
    });

    const byEntity = [...byEntityMap.values()].sort((a, b) => {
      const totalDiff = b.totalEvents - a.totalEvents;
      if (totalDiff !== 0) return totalDiff;

      return String(a.entityName ?? '').localeCompare(String(b.entityName ?? ''));
    });

    return res.json({
      date,
      stats,
      byEntity,
      events: cleanEvents,
    });
  } catch (err) {
    logger.error('Reports daily-summary failed', { date, error: err.message });
    return res.status(500).json({ error: 'Failed to build daily summary' });
  }
});

// Shared builder reused by GET /reports/hugo-context and POST /hugo/run.
// `inputDate` must already be a valid YYYY-MM-DD string (validated by callers)
// or omitted, in which case today (UTC) is used. Throws on query errors.
async function buildHugoContext({ date: inputDate } = {}) {
  const date = inputDate ? String(inputDate) : todayUtc();
  const startDate = shiftDateUtc(date, -(HISTORY_WINDOW_DAYS - 1));
  const endExclusive = shiftDateUtc(date, 1);

  logger.info('Hugo context build started', { date, startDate, endExclusive });

  {
    // --- Query 1: events for the selected date (same selection as daily-summary).
    const { data: todayRows, error: todayError } = await supabase
      .from('events')
      .select('entity_id, event_type, detected_at')
      .eq('detected_at', date);

    if (todayError) {
      throw new Error(`Failed to fetch today events: ${todayError.message}`);
    }

    // --- Query 2: events in the 30-day window ending on the selected date.
    const { data: windowRows, error: windowError } = await supabase
      .from('events')
      .select('entity_id, event_type, detected_at')
      .gte('detected_at', startDate)
      .lt('detected_at', endExclusive);

    if (windowError) {
      throw new Error(`Failed to fetch window events: ${windowError.message}`);
    }

    // --- Query 3: active ads by entity.
    const { data: activeAdRows, error: activeAdsError } = await supabase
      .from('ads')
      .select('entity_id')
      .eq('is_active', true);

    if (activeAdsError) {
      throw new Error(`Failed to fetch active ads: ${activeAdsError.message}`);
    }

    // --- Query 4: monitored entities (all columns; we only output id/name).
    const { data: entityRows, error: entitiesError } = await supabase
      .from('monitored_entities')
      .select('*');

    if (entitiesError) {
      throw new Error(`Failed to fetch monitored_entities: ${entitiesError.message}`);
    }

    // --- Query 5: latest snapshot per entity for the selected date.
    const { data: snapshotRows, error: snapshotsError } = await supabase
      .from('ad_snapshots')
      .select('entity_id, status, ads_found, snapshot_date, created_at')
      .eq('snapshot_date', date)
      .order('created_at', { ascending: false });

    if (snapshotsError) {
      throw new Error(`Failed to fetch ad_snapshots: ${snapshotsError.message}`);
    }

    const todayEvents = todayRows || [];
    const windowEvents = windowRows || [];
    const activeAds = activeAdRows || [];
    const entities = entityRows || [];
    const snapshotsForDate = snapshotRows || [];

    const limitations = [];

    // Entity name map.
    const entityNameMap = new Map();
    let hasIsSelfColumn = false;
    for (const row of entities) {
      entityNameMap.set(row.id, row.name ?? null);
      if (Object.prototype.hasOwnProperty.call(row, 'is_self')) {
        hasIsSelfColumn = true;
      }
    }
    if (!hasIsSelfColumn) {
      limitations.push('monitored_entities has no is_self column; self-identification omitted.');
    }

    const nameFor = (entityId) => entityNameMap.get(entityId) ?? null;

    // Latest snapshot per entity for the selected date (rows ordered created_at DESC).
    const latestSnapshotByEntity = new Map();
    for (const row of snapshotsForDate) {
      if (!row.entity_id || latestSnapshotByEntity.has(row.entity_id)) {
        continue;
      }
      latestSnapshotByEntity.set(row.entity_id, row);
    }

    const captureByEntity = [];
    const unconfirmedEntities = [];
    const awaitingConfirmationEntities = [];

    for (const entity of entities) {
      const latest = latestSnapshotByEntity.get(entity.id);
      if (!latest) {
        continue;
      }

      const normalized = latest.status;
      let marketExitConfirmed = false;

      if (normalized === 'empty_confirmed') {
        marketExitConfirmed = await isMarketExitConfirmed(entity.id, latest);
      }

      const entry = {
        entityId: entity.id,
        entityName: entity.name ?? null,
        isStrategic: isStrategicName(entity.name),
        latestCaptureStatus: normalized,
        adsFound: latest.ads_found,
        marketExitConfirmed,
      };
      captureByEntity.push(entry);

      if (normalized === 'empty_unconfirmed') {
        unconfirmedEntities.push(entity.name);
      } else if (normalized === 'empty_confirmed' && !marketExitConfirmed) {
        awaitingConfirmationEntities.push(entity.name);
      }
    }

    const captureStatus = {
      byEntity: captureByEntity,
      unconfirmedEntities,
      awaitingConfirmationEntities,
      suppressMarketExitNarrative: unconfirmedEntities.length > 0 || awaitingConfirmationEntities.length > 0,
    };

    // --- Active ads tally by entity.
    const activeAdsMap = new Map();
    for (const row of activeAds) {
      if (!row.entity_id) continue;
      activeAdsMap.set(row.entity_id, (activeAdsMap.get(row.entity_id) || 0) + 1);
    }

    const unknownTypes = new Set();

    // --- Today aggregation.
    const todayStats = {
      totalEvents: 0,
      newAds: 0,
      copyChanges: 0,
      reactivations: 0,
      deactivations: 0,
    };
    const todayByEntityMap = new Map();

    for (const event of todayEvents) {
      const entityId = event.entity_id;
      tallyEvent(todayStats, event.event_type, unknownTypes);

      if (!todayByEntityMap.has(entityId)) {
        todayByEntityMap.set(entityId, emptyEntityCounts());
      }
      tallyEvent(todayByEntityMap.get(entityId), event.event_type, unknownTypes);
    }

    const todayByEntity = [...todayByEntityMap.entries()]
      .map(([entityId, counts]) => {
        const entityName = nameFor(entityId);
        return {
          entityId,
          entityName,
          isStrategic: isStrategicName(entityName),
          totalEvents: counts.totalEvents,
          newAds: counts.newAds,
          copyChanges: counts.copyChanges,
          reactivations: counts.reactivations,
          deactivations: counts.deactivations,
          activeAds: activeAdsMap.get(entityId) || 0,
        };
      })
      .sort((a, b) => {
        const diff = b.totalEvents - a.totalEvents;
        if (diff !== 0) return diff;
        return String(a.entityName ?? '').localeCompare(String(b.entityName ?? ''));
      });

    const today = {
      totalEvents: todayStats.totalEvents,
      newAds: todayStats.newAds,
      copyChanges: todayStats.copyChanges,
      reactivations: todayStats.reactivations,
      deactivations: todayStats.deactivations,
      activeEntities: todayByEntityMap.size,
      byEntity: todayByEntity,
    };

    // --- History aggregation (window).
    const byDayMap = new Map();
    const historyByEntityMap = new Map();

    for (const event of windowEvents) {
      const day = event.detected_at;
      const entityId = event.entity_id;

      if (!byDayMap.has(day)) {
        byDayMap.set(day, emptyEntityCounts());
      }
      tallyEvent(byDayMap.get(day), event.event_type, unknownTypes);

      if (!historyByEntityMap.has(entityId)) {
        historyByEntityMap.set(entityId, { counts: emptyEntityCounts(), days: new Set() });
      }
      const bucket = historyByEntityMap.get(entityId);
      tallyEvent(bucket.counts, event.event_type, unknownTypes);
      if (day) bucket.days.add(day);
    }

    const historyByDay = [...byDayMap.entries()]
      .map(([day, counts]) => ({
        date: day,
        totalEvents: counts.totalEvents,
        newAds: counts.newAds,
        copyChanges: counts.copyChanges,
        reactivations: counts.reactivations,
        deactivations: counts.deactivations,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const historyByEntity = [...historyByEntityMap.entries()]
      .map(([entityId, bucket]) => {
        const entityName = nameFor(entityId);
        return {
          entityId,
          entityName,
          isStrategic: isStrategicName(entityName),
          totalEvents: bucket.counts.totalEvents,
          newAds: bucket.counts.newAds,
          copyChanges: bucket.counts.copyChanges,
          reactivations: bucket.counts.reactivations,
          deactivations: bucket.counts.deactivations,
          activeDays: bucket.days.size,
        };
      })
      .sort((a, b) => {
        const diff = b.totalEvents - a.totalEvents;
        if (diff !== 0) return diff;
        return String(a.entityName ?? '').localeCompare(String(b.entityName ?? ''));
      });

    const history = {
      windowDays: HISTORY_WINDOW_DAYS,
      daysAvailable: historyByDay.length,
      byDay: historyByDay,
      byEntity: historyByEntity,
    };

    // --- Active ads by entity (output): one item per monitored entity,
    // including entities with zero active ads.
    const activeAdsByEntity = entities
      .map((entity) => {
        const entityName = entity.name ?? null;
        return {
          entityId: entity.id,
          entityName,
          isStrategic: isStrategicName(entityName),
          activeAds: activeAdsMap.get(entity.id) || 0,
        };
      })
      .sort((a, b) => {
        const diff = b.activeAds - a.activeAds;
        if (diff !== 0) return diff;
        return String(a.entityName ?? '').localeCompare(String(b.entityName ?? ''));
      });

    // --- Signals (deterministic, no interpretation).
    const strategicEntitiesWithActivity = todayByEntity
      .filter((e) => e.isStrategic && e.totalEvents > 0)
      .map((e) => e.entityName);

    const strategicActiveSet = new Set(strategicEntitiesWithActivity);
    const quietStrategicEntities = STRATEGIC_ENTITIES.filter((n) => !strategicActiveSet.has(n));

    const entitiesWithNewAdsToday = todayByEntity
      .filter((e) => e.newAds > 0)
      .map((e) => e.entityName);

    const entitiesWithCopyChangesToday = todayByEntity
      .filter((e) => e.copyChanges > 0)
      .map((e) => e.entityName);

    const mostActiveToday = todayByEntity.length > 0 ? todayByEntity[0].entityName : null;

    const strategicActiveCount = strategicEntitiesWithActivity.length;
    const total = today.totalEvents;
    const newPlusCopy = today.newAds + today.copyChanges;

    let attentionLevel = 'normal';
    let attentionReason = '';

    if (total === 0) {
      attentionLevel = 'normal';
      attentionReason = 'No events detected for the selected date.';

      const hasUnconfirmedEmptyCaptureOnQuietDay = captureByEntity.some(
        (entry) => entry.isStrategic && (
          entry.latestCaptureStatus === 'empty'
          || entry.latestCaptureStatus === 'empty_unconfirmed'
          || (entry.latestCaptureStatus === 'empty_confirmed' && !entry.marketExitConfirmed)
        ),
      );

      if (hasUnconfirmedEmptyCaptureOnQuietDay) {
        attentionReason = `${attentionReason} Capture guard: empty result not confirmed for market exit.`;
      }
    } else {
      let rank = 0;
      if (strategicActiveCount >= 1) rank = Math.max(rank, 1);
      if (total >= 10) rank = Math.max(rank, 2);
      if (newPlusCopy >= 10) rank = Math.max(rank, 2);
      if (total >= 20) rank = Math.max(rank, 3);
      if (strategicActiveCount >= 3) rank = Math.max(rank, 3);

      const onlyDeactivations =
        today.deactivations > 0 &&
        today.newAds === 0 &&
        today.copyChanges === 0 &&
        today.reactivations === 0;

      if (onlyDeactivations && total < 20) {
        rank = Math.min(rank, 1);
      }

      attentionLevel = ATTENTION_RANK[rank];

      const hasUnconfirmedEmptyCapture = captureByEntity.some(
        (entry) => entry.isStrategic && (
          entry.latestCaptureStatus === 'empty'
          || entry.latestCaptureStatus === 'empty_unconfirmed'
          || (entry.latestCaptureStatus === 'empty_confirmed' && !entry.marketExitConfirmed)
        ),
      );

      if (hasUnconfirmedEmptyCapture) {
        if (total === 0) {
          rank = 0;
        } else if (rank >= 1) {
          rank = 1;
        }
        attentionLevel = ATTENTION_RANK[rank];
      }

      if (attentionLevel === 'strategic_movement') {
        if (strategicActiveCount >= 3) {
          attentionReason = `Strategic movement detected: ${strategicActiveCount} strategic entities were active.`;
        } else {
          attentionReason = `Strategic movement detected with ${total} total events.`;
        }
      } else if (attentionLevel === 'high_activity') {
        if (total >= 10) {
          attentionReason = `High activity detected with ${total} total events.`;
        } else {
          attentionReason = `High activity detected with ${newPlusCopy} new ads and copy changes.`;
        }
      } else if (attentionLevel === 'interesting') {
        if (strategicActiveCount >= 1) {
          attentionReason = `Activity detected in strategic entities: ${strategicEntitiesWithActivity.join(', ')}.`;
        } else {
          attentionReason = `Activity detected with ${total} total events.`;
        }
      } else {
        attentionReason = `Activity detected with ${total} total events.`;
      }

      if (hasUnconfirmedEmptyCapture && attentionLevel !== 'strategic_movement') {
        attentionReason = `${attentionReason} Capture guard: empty result not confirmed for market exit.`;
      }
    }

    const signals = {
      attentionLevel,
      attentionReason,
      mostActiveToday,
      strategicEntitiesWithActivity,
      quietStrategicEntities,
      entitiesWithNewAdsToday,
      entitiesWithCopyChangesToday,
      captureGuard: {
        suppressMarketExitNarrative: captureStatus.suppressMarketExitNarrative,
        unconfirmedEntities: captureStatus.unconfirmedEntities,
        awaitingConfirmationEntities: captureStatus.awaitingConfirmationEntities,
      },
    };

    // --- Limitations.
    if (unknownTypes.size > 0) {
      limitations.push(
        `Unknown event types were found and counted only in totalEvents: ${[...unknownTypes].join(', ')}.`,
      );
    }

    const monitoredNames = new Set(entities.map((e) => e.name).filter(Boolean));
    const missingStrategic = STRATEGIC_ENTITIES.filter((n) => !monitoredNames.has(n));
    if (missingStrategic.length > 0) {
      limitations.push(
        `Some strategic entities were not found among monitored entities: ${missingStrategic.join(', ')}.`,
      );
    }

    const meta = {
      strategicEntities: STRATEGIC_ENTITIES,
      totalMonitoredEntities: entities.length,
      dataNote: 'Events are aggregated at date granularity (detected_at). This endpoint returns structured context only, with no interpretation.',
    };

    return {
      generatedAt: new Date().toISOString(),
      date,
      today,
      history,
      signals,
      captureStatus,
      activeAds: { byEntity: activeAdsByEntity },
      limitations,
      meta,
    };
  }
}

router.get('/hugo-context', async (req, res) => {
  const rawDate = req.query?.date;

  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (!isValidDateOnly(String(rawDate))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
  }

  const date = rawDate ? String(rawDate) : todayUtc();

  try {
    const context = await buildHugoContext({ date });
    return res.json(context);
  } catch (err) {
    logger.error('Reports hugo-context failed', { date, error: err.message });
    return res.status(500).json({ error: 'Failed to build hugo context' });
  }
});

const OWN_AD_CHANGES_MAX_RANGE_DAYS = 365;
const OWN_AD_CHANGES_DEFAULT_LIMIT = 50;
const OWN_AD_CHANGES_MAX_LIMIT = 100;

function daysBetweenUtc(startDateStr, endDateStr) {
  const [y1, m1, d1] = String(startDateStr).split('-').map(Number);
  const [y2, m2, d2] = String(endDateStr).split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/** YYYY-MM-DD → inclusive UTC day start as ISO timestamptz. */
function dateOnlyToUtcStartIso(dateStr) {
  return `${dateStr}T00:00:00.000Z`;
}

async function resolveSelfEntityId() {
  const { data, error } = await supabase
    .from('monitored_entities')
    .select('id')
    .eq('is_self', true)
    .limit(1);

  if (error) {
    throw new Error(`Failed to load self entity: ${error.message}`);
  }
  if (!data || !data.length || !data[0].id) {
    throw new Error('No monitored_entities row with is_self=true');
  }
  return data[0].id;
}

function mapOwnAdChangeRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    entityId: row.entity_id,
    eventTime: row.event_time ?? null,
    eventType: row.event_type ?? null,
    objectId: row.object_id ?? null,
    objectName: row.object_name ?? null,
    objectType: row.object_type ?? null,
    actorId: row.actor_id ?? null,
    actorName: row.actor_name ?? null,
    applicationId: row.application_id ?? null,
    applicationName: row.application_name ?? null,
    translatedEventType: row.translated_event_type ?? null,
    dateTimeInTimezone: row.date_time_in_timezone ?? null,
    extraData: row.extra_data ?? null,
    createdAt: row.created_at ?? null,
  };
}

// Next upcoming holiday + BPS payment window from economic_calendar_events.
// Read-only; missing/empty calendar → nulls, never an error.
router.get('/next-economic-events', async (req, res) => {
  const today = todayUtc();
  logger.info('Reports next-economic-events requested', { today });

  // Per-type errors (e.g. table not migrated yet) degrade to null — the card
  // shows "Sin datos" instead of breaking the panel.
  const nextOfType = async (eventType) => {
    const mapRow = (row, active) => ({
      title: row.title ?? null,
      date_start: row.date_start ?? null,
      date_end: row.date_end ?? null,
      description: row.description ?? null,
      active,
    });

    // 1) Currently-active window: started already and not yet ended.
    //    Single-day events (date_end null) are active only on their own day.
    const activeQuery = await supabase
      .from('economic_calendar_events')
      .select('title, date_start, date_end, description')
      .eq('event_type', eventType)
      .lte('date_start', today)
      .or(`date_end.gte.${today},and(date_end.is.null,date_start.eq.${today})`)
      .order('date_start', { ascending: true })
      .limit(1);

    if (activeQuery.error) {
      logger.error('next-economic-events active query failed', {
        eventType,
        error: activeQuery.error.message,
      });
      return null;
    }
    if (activeQuery.data && activeQuery.data.length) {
      return mapRow(activeQuery.data[0], true);
    }

    // 2) Fallback: nearest strictly-future start.
    const futureQuery = await supabase
      .from('economic_calendar_events')
      .select('title, date_start, date_end, description')
      .eq('event_type', eventType)
      .gt('date_start', today)
      .order('date_start', { ascending: true })
      .limit(1);

    if (futureQuery.error) {
      logger.error('next-economic-events future query failed', {
        eventType,
        error: futureQuery.error.message,
      });
      return null;
    }
    if (!futureQuery.data || !futureQuery.data.length) return null;
    return mapRow(futureQuery.data[0], false);
  };

  const [nextHoliday, nextBpsPayment] = await Promise.all([
    nextOfType('holiday'),
    nextOfType('bps_payment'),
  ]);
  return res.json({ nextHoliday, nextBpsPayment });
});

// Distinct event_type values for Credizona — register before the list route.
/**
 * Auction pressure widget — competitor Ad Library activity vs own CPM.
 * ownCpmRatio is explicitly null (never a fabricated 0) when own history
 * is thin or there is no CPM for the requested date.
 */
router.get('/auction-pressure', async (req, res) => {
  const rawDate = req.query?.date;
  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (!isValidDateOnly(String(rawDate))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
  }
  const date = rawDate ? String(rawDate) : todayUtc();

  try {
    const payload = await computeAuctionPressure({ date });
    return res.json(payload);
  } catch (err) {
    logger.error('Reports auction-pressure failed', {
      date,
      error: err && err.message,
    });
    return res.status(500).json({ error: 'Failed to compute auction pressure' });
  }
});

router.get('/own-ad-changes/event-types', async (req, res) => {
  logger.info('Reports own-ad-changes/event-types requested');

  try {
    const entityId = await resolveSelfEntityId();

    // Ordered by event_time DESC so the first non-empty translated_event_type
    // per event_type is the most recent (DISTINCT ON semantics in app code).
    const { data, error } = await supabase
      .from('own_ad_changes')
      .select('event_type, translated_event_type, event_time')
      .eq('entity_id', entityId)
      .not('event_type', 'is', null)
      .order('event_time', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch event types: ${error.message}`);
    }

    // First encounter per event_type wins for label when translated is non-empty
    // (rows are event_time DESC → most recent non-empty translated_event_type).
    const byType = new Map();
    for (const row of data || []) {
      const eventType = row.event_type != null ? String(row.event_type) : '';
      if (!eventType) continue;

      if (!byType.has(eventType)) {
        byType.set(eventType, {
          eventType,
          label: eventType,
          hasTranslated: false,
        });
      }

      const entry = byType.get(eventType);
      if (entry.hasTranslated) continue;

      const translated =
        row.translated_event_type != null
          ? String(row.translated_event_type).trim()
          : '';
      if (translated) {
        entry.label = translated;
        entry.hasTranslated = true;
      }
    }

    const types = [...byType.values()]
      .map(({ eventType, label }) => ({ eventType, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));

    return res.json(types);
  } catch (err) {
    logger.error('Reports own-ad-changes/event-types failed', {
      error: err.message,
    });
    return res.status(500).json({ error: 'Failed to fetch event types' });
  }
});

// Read-only log of Meta Ad Account activity (Credizona / is_self).
router.get('/own-ad-changes', async (req, res) => {
  const from = req.query?.from != null ? String(req.query.from).trim() : '';
  const to = req.query?.to != null ? String(req.query.to).trim() : '';
  const rawEventType =
    req.query?.eventType != null ? String(req.query.eventType).trim() : '';

  if (!from || !to) {
    return res.status(400).json({
      error: 'Query params from and to are required (YYYY-MM-DD).',
    });
  }
  if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from must be less than or equal to to.' });
  }
  if (daysBetweenUtc(from, to) > OWN_AD_CHANGES_MAX_RANGE_DAYS) {
    return res.status(400).json({
      error: `Date range must not exceed ${OWN_AD_CHANGES_MAX_RANGE_DAYS} days.`,
    });
  }

  let page = Number.parseInt(String(req.query?.page ?? '1'), 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  let limit = Number.parseInt(
    String(req.query?.limit ?? String(OWN_AD_CHANGES_DEFAULT_LIMIT)),
    10,
  );
  if (!Number.isFinite(limit) || limit < 1) limit = OWN_AD_CHANGES_DEFAULT_LIMIT;
  if (limit > OWN_AD_CHANGES_MAX_LIMIT) limit = OWN_AD_CHANGES_MAX_LIMIT;

  const rangeStartIso = dateOnlyToUtcStartIso(from);
  const rangeEndExclusiveIso = dateOnlyToUtcStartIso(shiftDateUtc(to, 1));
  const offset = (page - 1) * limit;

  logger.info('Reports own-ad-changes requested', {
    from,
    to,
    eventType: rawEventType || null,
    page,
    limit,
  });

  try {
    const entityId = await resolveSelfEntityId();

    let query = supabase
      .from('own_ad_changes')
      .select(
        [
          'id',
          'run_id',
          'entity_id',
          'event_time',
          'event_type',
          'object_id',
          'object_name',
          'object_type',
          'actor_id',
          'actor_name',
          'application_id',
          'application_name',
          'translated_event_type',
          'date_time_in_timezone',
          'extra_data',
          'created_at',
        ].join(', '),
        { count: 'exact' },
      )
      .eq('entity_id', entityId)
      .gte('event_time', rangeStartIso)
      .lt('event_time', rangeEndExclusiveIso)
      .order('event_time', { ascending: false })
      .range(offset, offset + limit - 1);

    if (rawEventType) {
      query = query.eq('event_type', rawEventType);
    }

    const { data, error, count } = await query;
    if (error) {
      throw new Error(`Failed to fetch own_ad_changes: ${error.message}`);
    }

    const total = typeof count === 'number' ? count : 0;
    const rows = (data || []).map(mapOwnAdChangeRow);

    return res.json({
      rows,
      pagination: {
        page,
        limit,
        total,
        hasMore: offset + rows.length < total,
      },
    });
  } catch (err) {
    logger.error('Reports own-ad-changes failed', {
      from,
      to,
      error: err.message,
    });
    return res.status(500).json({ error: 'Failed to fetch own ad changes' });
  }
});

/**
 * Shared read core for coverage-suggestions / keyword-research /
 * search-discoveries. Computed once, shaped per view at the end:
 *   - latest discovery row per (seed, term, query_type)
 *   - cross-reference vs monitored_entities (already covered?)
 *   - cross-reference vs confirmed_search_terms (decision or 'pending')
 *   - server-side growth_percent / is_breakout (parseTrendsFormattedValue)
 *   - marca/frase heuristic (suggestion aid only, human-overridable)
 */
async function loadSearchDiscoveries() {
  const { data: discoveries, error: discErr } = await supabase
    .from('search_term_discoveries')
    .select('seed, term, query_type, score, formatted_value, discovered_at')
    .order('discovered_at', { ascending: false })
    .limit(2000);
  if (discErr) {
    throw new Error(`Failed to fetch search_term_discoveries: ${discErr.message}`);
  }

  // Latest row per (seed, term, query_type) — rows are already sorted desc.
  const latestByKey = new Map();
  for (const row of discoveries || []) {
    const key = `${row.seed}::${row.term}::${row.query_type}`;
    if (!latestByKey.has(key)) latestByKey.set(key, row);
  }

  const { data: entities, error: entErr } = await supabase
    .from('monitored_entities')
    .select('id, name, is_self, active, website_domain');
  if (entErr) {
    throw new Error(`Failed to fetch monitored_entities: ${entErr.message}`);
  }
  const entityByLowerName = new Map(
    (entities || []).map((e) => [String(e.name || '').trim().toLowerCase(), e]),
  );
  const entityByWebsiteDomain = new Map();
  for (const e of entities || []) {
    const d = normalizeDomain(e.website_domain);
    if (d) entityByWebsiteDomain.set(d, e);
  }

  const { data: decided, error: decErr } = await supabase
    .from('confirmed_search_terms')
    .select('term, decision, term_type, source_seed, discovered_score, created_at');
  if (decErr) {
    throw new Error(`Failed to fetch confirmed_search_terms: ${decErr.message}`);
  }
  const decisionByLowerTerm = new Map(
    (decided || []).map((d) => [String(d.term || '').trim().toLowerCase(), d]),
  );

  const seeds = new Set();
  const items = [];
  const itemTerms = new Set();
  for (const row of latestByKey.values()) {
    const lower = String(row.term || '').trim().toLowerCase();
    const entity = entityByLowerName.get(lower) || null;
    const derived = parseTrendsFormattedValue(row.formatted_value);
    const termStr = String(row.term || '').trim();
    seeds.add(row.seed);
    itemTerms.add(lower);

    const decidedRow = decisionByLowerTerm.get(lower);
    items.push({
      term: row.term,
      seed: row.seed,
      queryType: row.query_type,
      score: row.score !== null && row.score !== undefined ? Number(row.score) : null,
      formattedValue: row.formatted_value || null,
      discoveredAt: row.discovered_at,
      growthPercent: derived.growth_percent,
      isBreakout: derived.is_breakout,
      alreadyCovered: Boolean(entity),
      coveredByEntity: entity ? { id: entity.id, name: entity.name } : null,
      decision: decidedRow ? decidedRow.decision : 'pending',
      termType: decidedRow ? decidedRow.term_type : 'generic',
      sourceSeed: decidedRow ? decidedRow.source_seed : row.seed,
      // Heuristic aid: single capitalized word -> possible brand.
      suggestedKind:
        !/\s/.test(termStr) && /^[A-ZÁÉÍÓÚÑ]/.test(termStr) ? 'brand' : 'intent',
    });
  }

  // Merge SERP-import unmatched domains queued for Pendientes (independent of Trends rows).
  for (const row of decided || []) {
    if (row.source_seed !== 'google_serp_import' || row.decision !== 'pending') continue;
    const termStr = String(row.term || '').trim();
    const lower = termStr.toLowerCase();
    if (!termStr || itemTerms.has(lower)) continue;

    const domain = normalizeDomain(termStr);
    const entity = domain ? entityByWebsiteDomain.get(domain) || null : null;
    seeds.add('google_serp_import');
    itemTerms.add(lower);

    items.push({
      term: termStr,
      seed: 'google_serp_import',
      queryType: 'serp',
      score: row.discovered_score !== null && row.discovered_score !== undefined
        ? Number(row.discovered_score)
        : null,
      formattedValue: null,
      discoveredAt: row.created_at || null,
      growthPercent: null,
      isBreakout: false,
      alreadyCovered: Boolean(entity),
      coveredByEntity: entity ? { id: entity.id, name: entity.name } : null,
      decision: 'pending',
      termType: row.term_type || 'competitor_candidate',
      sourceSeed: 'google_serp_import',
      suggestedKind: 'brand',
    });
  }

  return { items, seeds: Array.from(seeds).sort() };
}

function sortRisingFirstByScore(items) {
  return items.slice().sort((a, b) => {
    if (a.queryType !== b.queryType) return a.queryType === 'rising' ? -1 : 1;
    return (b.score || 0) - (a.score || 0);
  });
}

/**
 * GET /reports/search-discoveries?view=pending|research — unified read
 * endpoint over search_term_discoveries.
 * - view=pending: only undecided terms (triage screen shape)
 * - view=research: ALL terms with their decision status (research shape,
 *   supports the Top/Rising separation + seed filter client-side)
 */
router.get('/search-discoveries', async (req, res) => {
  const view = String(req.query.view || '');
  if (view !== 'pending' && view !== 'research') {
    return res.status(400).json({ error: 'Invalid view. Use view=pending or view=research' });
  }

  try {
    const { items, seeds } = await loadSearchDiscoveries();

    if (view === 'pending') {
      const suggestions = sortRisingFirstByScore(
        items.filter((i) => i.decision === 'pending'),
      );
      return res.json({ view, suggestions, total: suggestions.length });
    }

    return res.json({ view, keywords: items, seeds, total: items.length });
  } catch (err) {
    logger.error('Reports search-discoveries failed', { view, error: err.message });
    return res.status(500).json({ error: 'Failed to fetch search discoveries' });
  }
});

/**
 * GET /reports/coverage-suggestions — DEPRECATED (kept until nothing depends
 * on it; see /search-discoveries). Delegates to the shared core and preserves
 * the original response shape exactly (decision null when undecided).
 */
router.get('/coverage-suggestions', async (req, res) => {
  try {
    const includeDecided = String(req.query.includeDecided || '') === '1';
    const { items } = await loadSearchDiscoveries();

    const suggestions = sortRisingFirstByScore(
      items.filter((i) => includeDecided || i.decision === 'pending'),
    ).map((i) => ({
      term: i.term,
      seed: i.seed,
      queryType: i.queryType,
      score: i.score,
      formattedValue: i.formattedValue,
      discoveredAt: i.discoveredAt,
      alreadyCovered: i.alreadyCovered,
      coveredByEntity: i.coveredByEntity,
      decision: i.decision === 'pending' ? null : i.decision,
    }));

    return res.json({ suggestions, total: suggestions.length });
  } catch (err) {
    logger.error('Reports coverage-suggestions failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch coverage suggestions' });
  }
});

const COVERAGE_DECISIONS = new Set(['monitor_trends', 'added_as_competitor', 'discarded']);

/**
 * POST /reports/coverage-suggestions/decide
 * Body: { term, decision, termType?, sourceSeed?, discoveredScore? }
 * Records the decision and responds immediately. For decision='monitor_trends'
 * the landing draft generation runs asynchronously (fire-and-forget) AFTER
 * checking no active draft already exists for the term (double-click /
 * HTTP-retry protection). decision='added_as_competitor' does NOT insert
 * into monitored_entities — the existing "+ Agregar" flow handles that.
 */
router.post('/coverage-suggestions/decide', async (req, res) => {
  const body = req.body || {};
  const term = typeof body.term === 'string' ? body.term.trim() : '';
  const decision = typeof body.decision === 'string' ? body.decision : '';

  if (!term) {
    return res.status(400).json({ error: 'Missing required field: term' });
  }
  if (!COVERAGE_DECISIONS.has(decision)) {
    return res.status(400).json({
      error: 'Invalid decision. Use monitor_trends | added_as_competitor | discarded',
    });
  }

  const termType =
    body.termType === 'competitor_candidate' ? 'competitor_candidate' : 'generic';
  const sourceSeed = typeof body.sourceSeed === 'string' ? body.sourceSeed : null;
  const discoveredScore = Number.isFinite(Number(body.discoveredScore))
    ? Number(body.discoveredScore)
    : null;

  try {
    const { data: upserted, error } = await supabase
      .from('confirmed_search_terms')
      .upsert(
        {
          term,
          term_type: termType,
          decision,
          source_seed: sourceSeed,
          discovered_score: discoveredScore,
        },
        { onConflict: 'term' },
      )
      .select('id, term, decision')
      .single();

    if (error) {
      throw new Error(`Failed to record decision: ${error.message}`);
    }

    let landingGeneration = 'not_applicable';
    if (decision === 'monitor_trends') {
      const alreadyHasDraft = await hasActiveDraft(upserted.id);
      if (alreadyHasDraft) {
        landingGeneration = 'skipped_existing';
      } else {
        landingGeneration = 'started';
        // Fire-and-forget: the HTTP caller never waits for Claude+GPT.
        generateSeoLandingDraft({ termId: upserted.id, term: upserted.term }).catch((err) => {
          logger.error('Async SEO landing generation crashed', {
            termId: upserted.id,
            term: upserted.term,
            error: err && err.message,
          });
        });
      }
    }

    logger.info('Coverage suggestion decided', { term, decision, landingGeneration });
    return res.json({
      termId: upserted.id,
      term: upserted.term,
      decision: upserted.decision,
      landingGeneration,
    });
  } catch (err) {
    logger.error('Reports coverage-suggestions/decide failed', {
      term,
      decision,
      error: err.message,
    });
    return res.status(500).json({ error: 'Failed to record decision' });
  }
});

/**
 * GET /reports/seo-landing-drafts
 * Read-only list for the drafts review section.
 */
router.get('/seo-landing-drafts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seo_landing_drafts')
      .select(
        'id, term_id, status, generation_error, storage_path, generated_at, reviewed_at, published_at, created_at, confirmed_search_terms(term)',
      )
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) {
      throw new Error(`Failed to fetch seo_landing_drafts: ${error.message}`);
    }

    const drafts = (data || []).map((row) => ({
      id: row.id,
      termId: row.term_id,
      term:
        row.confirmed_search_terms && row.confirmed_search_terms.term
          ? row.confirmed_search_terms.term
          : null,
      status: row.status,
      generationError: row.generation_error || null,
      storagePath: row.storage_path || null,
      generatedAt: row.generated_at,
      reviewedAt: row.reviewed_at,
      publishedAt: row.published_at,
      createdAt: row.created_at,
    }));
    return res.json({ drafts, total: drafts.length });
  } catch (err) {
    logger.error('Reports seo-landing-drafts failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch landing drafts' });
  }
});

/**
 * GET /reports/seo-landing-drafts/:id/html
 * Returns the draft HTML for in-dashboard preview (text/html).
 */
router.get('/seo-landing-drafts/:id/html', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seo_landing_drafts')
      .select('id, html_content, status')
      .eq('id', req.params.id)
      .limit(1);
    if (error) {
      throw new Error(`Failed to fetch draft: ${error.message}`);
    }
    if (!data || !data.length) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    if (!data[0].html_content) {
      return res.status(404).json({ error: 'Draft has no HTML content (failed generation?)' });
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(data[0].html_content);
  } catch (err) {
    logger.error('Reports seo-landing-drafts/:id/html failed', {
      id: req.params.id,
      error: err.message,
    });
    return res.status(500).json({ error: 'Failed to fetch draft HTML' });
  }
});

/**
 * PATCH /reports/seo-landing-drafts/:id/status
 * Human review/publish transitions only:
 *   draft → reviewed  (sets reviewed_at)
 *   reviewed → published (sets published_at)
 * Other jumps return 400.
 *
 * TODO: when real hosting credentials exist, status='published' should also
 * upload the HTML to the live site (cPanel/FTP/etc). For now this only
 * updates the row status — Storage public URL remains the download source.
 */
router.patch('/seo-landing-drafts/:id/status', async (req, res) => {
  const nextStatus = req.body && typeof req.body.status === 'string' ? req.body.status.trim() : '';
  if (nextStatus !== 'reviewed' && nextStatus !== 'published') {
    return res.status(400).json({
      error: "status must be 'reviewed' or 'published'",
    });
  }

  try {
    const { data: rows, error: fetchError } = await supabase
      .from('seo_landing_drafts')
      .select(
        'id, status, reviewed_at, published_at, confirmed_search_terms(term)',
      )
      .eq('id', req.params.id)
      .limit(1);

    if (fetchError) {
      throw new Error(`Failed to fetch draft: ${fetchError.message}`);
    }
    if (!rows || !rows.length) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    const row = rows[0];
    const current = row.status;
    const allowed =
      (current === 'draft' && nextStatus === 'reviewed') ||
      (current === 'reviewed' && nextStatus === 'published');

    if (!allowed) {
      return res.status(400).json({
        error: `Invalid transition: ${current} → ${nextStatus}. Allowed: draft→reviewed, reviewed→published.`,
        currentStatus: current,
        requestedStatus: nextStatus,
      });
    }

    const now = new Date().toISOString();
    const patch = { status: nextStatus };
    if (nextStatus === 'reviewed') {
      patch.reviewed_at = now;
    }
    if (nextStatus === 'published') {
      // TODO: upload HTML to real hosting here once credentials are available.
      // Currently only marks the draft as published in seo_landing_drafts.
      patch.published_at = now;
    }

    const { data: updated, error: updateError } = await supabase
      .from('seo_landing_drafts')
      .update(patch)
      .eq('id', row.id)
      .select(
        'id, term_id, status, generation_error, storage_path, generated_at, reviewed_at, published_at, created_at, confirmed_search_terms(term)',
      )
      .single();

    if (updateError) {
      throw new Error(`Failed to update draft status: ${updateError.message}`);
    }

    logger.info('SEO landing draft status updated', {
      draftId: updated.id,
      from: current,
      to: nextStatus,
    });

    return res.json({
      id: updated.id,
      termId: updated.term_id,
      term:
        updated.confirmed_search_terms && updated.confirmed_search_terms.term
          ? updated.confirmed_search_terms.term
          : null,
      status: updated.status,
      generationError: updated.generation_error || null,
      storagePath: updated.storage_path || null,
      generatedAt: updated.generated_at,
      reviewedAt: updated.reviewed_at,
      publishedAt: updated.published_at,
      createdAt: updated.created_at,
      previousStatus: current,
    });
  } catch (err) {
    logger.error('Reports seo-landing-drafts/:id/status failed', {
      id: req.params.id,
      error: err.message,
    });
    return res.status(500).json({ error: 'Failed to update draft status' });
  }
});

/**
 * POST /reports/seo-landing-drafts/:id/regenerate
 * Intentional manual regeneration of an existing draft (e.g. after a prompt
 * fix). Updates the SAME row in place — html_content, storage_path,
 * generated_at — and resets status to 'draft'. Deliberately bypasses the
 * "skip if active draft exists" guard used by automatic generation.
 * Fire-and-forget like the /decide trigger: responds immediately.
 */
router.post('/seo-landing-drafts/:id/regenerate', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seo_landing_drafts')
      .select('id, term_id, confirmed_search_terms(term)')
      .eq('id', req.params.id)
      .limit(1);
    if (error) {
      throw new Error(`Failed to fetch draft: ${error.message}`);
    }
    if (!data || !data.length) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    const row = data[0];
    const term =
      row.confirmed_search_terms && row.confirmed_search_terms.term
        ? row.confirmed_search_terms.term
        : null;
    if (!term) {
      return res.status(422).json({ error: 'Draft has no associated term' });
    }

    const rawInstructions =
      req.body && typeof req.body.customInstructions === 'string'
        ? req.body.customInstructions.trim()
        : '';
    const customInstructions = rawInstructions ? rawInstructions.slice(0, 4000) : null;

    // Fire-and-forget: the HTTP caller never waits for Claude+GPT.
    regenerateSeoLandingDraft({
      draftId: row.id,
      termId: row.term_id,
      term,
      customInstructions,
    }).catch((err) => {
      logger.error('Async SEO landing regeneration crashed', {
        draftId: row.id,
        term,
        error: err && err.message,
      });
    });

    return res.json({
      draftId: row.id,
      term,
      regeneration: 'started',
      customInstructionsApplied: Boolean(customInstructions),
    });
  } catch (err) {
    logger.error('Reports seo-landing-drafts/:id/regenerate failed', {
      id: req.params.id,
      error: err.message,
    });
    return res.status(500).json({ error: 'Failed to start regeneration' });
  }
});

/**
 * Parses Google Trends' formatted_value for rising queries into derived
 * fields, server-side (the string format is fragile — never parse it in the
 * frontend). Audited against real rows (2026-07-17, hl=es):
 *   - Breakout tier is literally "Aumento puntual" (localized, NOT "Breakout")
 *   - Percentages look like "+3.700 %" (space before %, dot = thousands
 *     separator, so "+3.700 %" must parse to 3700, not 3.7)
 *   - Top rows carry plain "100".."<1" (no %) -> both fields null
 */
function parseTrendsFormattedValue(formattedValue) {
  const raw = formattedValue === null || formattedValue === undefined ? '' : String(formattedValue).trim();
  if (!raw) return { growth_percent: null, is_breakout: null };

  if (/aumento puntual|breakout/i.test(raw)) {
    return { growth_percent: null, is_breakout: true };
  }

  if (raw.includes('%')) {
    // "+3.700 %" -> "3.700" -> drop thousands dots, comma = decimal -> 3700
    const numericPart = raw.replace(/[^\d.,]/g, '');
    const normalized = numericPart.replace(/\./g, '').replace(/,/g, '.');
    const value = Number(normalized);
    if (Number.isFinite(value)) {
      return { growth_percent: value, is_breakout: false };
    }
  }

  return { growth_percent: null, is_breakout: null };
}

/**
 * GET /reports/keyword-research — DEPRECATED (kept until nothing depends on
 * it; see /search-discoveries?view=research). Delegates to the shared core
 * and preserves the original snake_case response shape exactly.
 */
router.get('/keyword-research', async (req, res) => {
  try {
    const { items, seeds } = await loadSearchDiscoveries();

    const keywords = items.map((i) => ({
      term: i.term,
      query_type: i.queryType,
      score: i.score,
      formatted_value: i.formattedValue,
      seed: i.seed,
      discovered_at: i.discoveredAt,
      growth_percent: i.growthPercent,
      is_breakout: i.isBreakout,
    }));

    return res.json({ keywords, seeds, total: keywords.length });
  } catch (err) {
    logger.error('Reports keyword-research failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch keyword research data' });
  }
});

/**
 * GET /reports/ga4-metrics?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Read-only viewer feed for captured GA4 traffic (ga4_metrics). Default
 * range: last 30 calendar dates inclusive (today-29 .. today, UTC).
 * firstAvailableDate = earliest date in the table overall, so the frontend
 * can render an honest empty state without a second endpoint.
 *
 * Dates are UTC calendar days (YYYY-MM-DD), same convention as todayUtc()
 * elsewhere in this router — not America/Montevideo.
 *
 * `summary` is aggregated from a fully paginated scan of the date range
 * (independent of the table `rows` select, which may hit PostgREST caps).
 * `summary.true_unique_users` is a live GA4 Data API call (no dimensions),
 * cached briefly in-process; null if the live query fails.
 */
const GA4_SUMMARY_PAGE_SIZE = 1000;
const GA4_UNIQUE_USERS_TIMEOUT_MS = 10000;
const GA4_UNIQUE_USERS_CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { value: number, expiresAt: number }>} */
const ga4UniqueUsersCache = new Map();

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Live GA4 totalUsers for [from, to] with no dimensions (true unique users).
 * Returns null on any failure; never throws.
 */
async function fetchGa4TrueUniqueUsers(from, to) {
  const cacheKey = `${from}|${to}`;
  const cached = ga4UniqueUsersCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const propertyId = getPropertyId();
    const property = `properties/${propertyId}`;
    const client = buildGa4Client();

    const [response] = await withTimeout(
      client.runReport({
        property,
        dateRanges: [{ startDate: from, endDate: to }],
        metrics: [{ name: 'totalUsers' }],
        limit: 1,
        returnPropertyQuota: true,
      }),
      GA4_UNIQUE_USERS_TIMEOUT_MS,
      'GA4 true unique users',
    );

    const metricHeaders =
      response && response.metricHeaders ? response.metricHeaders : [];
    const metricIndex = {};
    metricHeaders.forEach((h, i) => {
      if (h && h.name) metricIndex[h.name] = i;
    });
    const idx = metricIndex.totalUsers;
    const firstRow =
      response && Array.isArray(response.rows) ? response.rows[0] : null;
    const metricValues =
      firstRow && firstRow.metricValues ? firstRow.metricValues : [];

    // Empty report / no rows → successful zero traffic, not an error.
    if (idx === undefined || !firstRow) {
      ga4UniqueUsersCache.set(cacheKey, {
        value: 0,
        expiresAt: Date.now() + GA4_UNIQUE_USERS_CACHE_TTL_MS,
      });
      return 0;
    }

    const parsed = metricCellToNumber(metricValues, idx);
    const value =
      parsed != null && Number.isFinite(Number(parsed))
        ? Math.trunc(Number(parsed))
        : 0;

    ga4UniqueUsersCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + GA4_UNIQUE_USERS_CACHE_TTL_MS,
    });
    return value;
  } catch (err) {
    logger.warn('GA4 true unique users query failed', {
      from,
      to,
      error: err && err.message ? err.message : 'unknown',
    });
    return null;
  }
}

function normalizeGa4Channel(value) {
  if (value == null) return 'Unassigned';
  const trimmed = String(value).trim();
  if (!trimmed) return 'Unassigned';
  const lower = trimmed.toLowerCase();
  if (
    lower === '(not set)' ||
    lower === '(none)' ||
    lower === '(not provided)' ||
    lower === 'unassigned'
  ) {
    return 'Unassigned';
  }
  return trimmed;
}

function roundGa4Summary2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function emptyGa4Summary() {
  return {
    total_sessions: 0,
    total_users: 0,
    total_key_events: 0,
    overall_conversion_rate: 0,
    by_channel: [],
    true_unique_users: null,
  };
}

/**
 * Aggregate summary over ALL rows in [from, to] via paginated .range().
 * Never rely on a single uncapped select (PostgREST ~1000 default).
 */
async function buildGa4Summary(from, to) {
  const byChannel = new Map();
  let totalSessions = 0;
  let totalUsers = 0;
  let totalKeyEvents = 0;

  for (let offset = 0; ; offset += GA4_SUMMARY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('ga4_metrics')
      .select('id, channel_group, sessions, total_users, key_events')
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + GA4_SUMMARY_PAGE_SIZE - 1);

    if (error) {
      throw new Error(
        `Failed to aggregate ga4_metrics summary: ${error.message}`,
      );
    }

    const page = data || [];
    for (const row of page) {
      const sessions = Number(row.sessions) || 0;
      const users = Number(row.total_users) || 0;
      const keyEvents = Number(row.key_events) || 0;
      const channel = normalizeGa4Channel(row.channel_group);

      totalSessions += sessions;
      totalUsers += users;
      totalKeyEvents += keyEvents;

      const bucket = byChannel.get(channel) || {
        channel,
        sessions: 0,
        users: 0,
        key_events: 0,
      };
      bucket.sessions += sessions;
      bucket.users += users;
      bucket.key_events += keyEvents;
      byChannel.set(channel, bucket);
    }

    if (page.length < GA4_SUMMARY_PAGE_SIZE) break;
  }

  const by_channel = [...byChannel.values()]
    .map((bucket) => ({
      channel: bucket.channel,
      sessions: bucket.sessions,
      users: bucket.users,
      key_events: bucket.key_events,
      percentage:
        totalSessions > 0
          ? roundGa4Summary2((bucket.sessions / totalSessions) * 100)
          : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  return {
    total_sessions: totalSessions,
    total_users: totalUsers,
    total_key_events: totalKeyEvents,
    overall_conversion_rate:
      totalSessions > 0
        ? roundGa4Summary2((totalKeyEvents / totalSessions) * 100)
        : 0,
    by_channel,
  };
}

router.get('/ga4-metrics', async (req, res) => {
  const rawFrom = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const rawTo = typeof req.query.to === 'string' ? req.query.to.trim() : '';

  const to = rawTo || todayUtc();
  const from = rawFrom || shiftDateOnlyUtc(to, -29);

  if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from must be less than or equal to to.' });
  }

  try {
    const { data, error } = await supabase
      .from('ga4_metrics')
      .select(
        'date, channel_group, landing_page, source, medium, sessions, total_users, key_events, conversion_rate',
      )
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: false })
      .order('sessions', { ascending: false });
    if (error) {
      throw new Error(`Failed to fetch ga4_metrics: ${error.message}`);
    }

    const { data: firstRow, error: firstError } = await supabase
      .from('ga4_metrics')
      .select('date')
      .order('date', { ascending: true })
      .limit(1);
    if (firstError) {
      throw new Error(`Failed to fetch first ga4_metrics date: ${firstError.message}`);
    }

    const [summaryBase, trueUniqueUsers] = await Promise.all([
      buildGa4Summary(from, to),
      fetchGa4TrueUniqueUsers(from, to),
    ]);
    const summary = {
      ...summaryBase,
      true_unique_users: trueUniqueUsers,
    };

    return res.json({
      rows: data || [],
      range: { from, to },
      firstAvailableDate:
        firstRow && firstRow.length && firstRow[0].date ? firstRow[0].date : null,
      summary: summary || emptyGa4Summary(),
    });
  } catch (err) {
    logger.error('Reports ga4-metrics failed', { from, to, error: err.message });
    return res.status(500).json({ error: 'Failed to fetch GA4 metrics' });
  }
});

function shiftDateOnlyUtc(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

/**
 * POST /reports/import-google-serp
 * multipart/form-data: file (required .html) + optional searchTerm.
 * Capture date is always the Uruguay calendar day (server-side); body.date is ignored.
 * Thin pass-through into collectGoogleSerpImports.importGoogleSerpHtml.
 */
router.post('/import-google-serp', (req, res) => {
  serpHtmlUpload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const isSize =
        uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE';
      const status = uploadErr.statusCode || (isSize ? 400 : 400);
      logger.warn('Reports import-google-serp upload rejected', {
        error: uploadErr.message,
        code: uploadErr.code || null,
      });
      return res.status(status).json({
        error: isSize
          ? `El archivo supera el límite de ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB`
          : uploadErr.message || 'Upload rechazado',
        code: uploadErr.code || (isSize ? 'FILE_TOO_LARGE' : 'UPLOAD_REJECTED'),
      });
    }

    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          error: 'Archivo HTML requerido (campo file)',
          code: 'MISSING_FILE',
        });
      }

      const searchTermFallback =
        req.body && req.body.searchTerm != null ? String(req.body.searchTerm) : null;

      logger.info('Reports import-google-serp requested', {
        bytes: req.file.buffer.length,
        hasSearchTermFallback: Boolean(searchTermFallback && searchTermFallback.trim()),
      });

      const result = await importGoogleSerpHtml({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        searchTermFallback,
      });

      // Release multer buffer promptly after the insert/archive completes.
      req.file.buffer = null;

      const status = result.parserFoundNoResults ? 422 : 200;
      return res.status(status).json(result);
    } catch (err) {
      if (req.file) req.file.buffer = null;
      const status = err.statusCode || 500;
      logger.error('Reports import-google-serp failed', {
        error: err.message,
        code: err.code || null,
      });
      return res.status(status).json({
        error: err.message || 'Failed to import Google SERP HTML',
        code: err.code || 'IMPORT_FAILED',
        parserFoundNoAdMarkers: Boolean(err.parserFoundNoAdMarkers),
      });
    }
  });
});

/**
 * GET /reports/google-serp-imports — prior captures (one HTML upload each).
 */
router.get('/google-serp-imports', async (req, res) => {
  try {
    const limit = req.query.limit;
    const result = await listGoogleSerpImports({ limit });
    return res.json(result);
  } catch (err) {
    logger.error('Reports google-serp-imports list failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to list Google SERP imports' });
  }
});

/**
 * GET /reports/google-serp-imports/ads?path=...&captureId=...
 * Drill-down into ads for one capture (prefer captureId; path still works).
 */
router.get('/google-serp-imports/ads', async (req, res) => {
  const path = req.query.path != null ? String(req.query.path) : '';
  const captureId = req.query.captureId != null ? String(req.query.captureId) : '';
  try {
    const result = await getGoogleSerpImportAds({ path, captureId });
    return res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    logger.error('Reports google-serp-imports ads failed', {
      path,
      captureId,
      error: err.message,
    });
    return res.status(status).json({
      error: err.message || 'Failed to fetch Google SERP ads',
    });
  }
});

/**
 * GET /reports/google-serp-competitor-presence
 * Count-based presence only (no ratios or period comparisons).
 */
router.get('/google-serp-competitor-presence', async (req, res) => {
  try {
    const result = await getGoogleSerpCompetitorPresence();
    return res.json(result);
  } catch (err) {
    logger.error('Reports google-serp-competitor-presence failed', {
      error: err.message,
    });
    return res.status(500).json({ error: 'Failed to fetch competitor presence' });
  }
});

/**
 * GET /reports/competitor-activity-weekly
 * Optional ?from=&to= (YYYY-MM-DD, snapped to Monday). Default: last 8 complete weeks.
 */
router.get('/competitor-activity-weekly', async (req, res) => {
  try {
    const resolved = resolveWeeksFromRange(req.query.from, req.query.to);
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }
    const weeks = resolved.weeks;
    const rangeStart = weeks[0];
    const rangeEnd = addCalendarDays(weeks[weeks.length - 1], 6);

    const { data: entityRows, error: entitiesError } = await supabase
      .from('monitored_entities')
      .select('id, name')
      .eq('is_self', false)
      .eq('active', true)
      .order('name', { ascending: true });

    if (entitiesError) {
      logger.error('competitor-activity-weekly entities failed', {
        error: entitiesError.message,
      });
      return res.status(500).json({ error: entitiesError.message });
    }

    const entitiesMeta = Array.isArray(entityRows) ? entityRows : [];
    const entityIds = entitiesMeta.map((e) => e.id).filter(Boolean);

    const eventRows = await loadMovementEventsForEntities(
      entityIds,
      rangeStart,
      rangeEnd,
    );

    /** @type {Map<string, Map<string, { count: number, by_type: Record<string, number> }>>} */
    const countsByEntityWeek = new Map();
    entityIds.forEach((id) => {
      const weekMap = new Map();
      weeks.forEach((w) => weekMap.set(w, { count: 0, by_type: {} }));
      countsByEntityWeek.set(String(id), weekMap);
    });

    for (const row of eventRows) {
      const entityId = row && row.entity_id != null ? String(row.entity_id) : '';
      const day =
        row && row.detected_at != null
          ? String(row.detected_at).slice(0, 10)
          : '';
      if (!entityId || !YMD_RE.test(day)) continue;
      const weekMap = countsByEntityWeek.get(entityId);
      if (!weekMap) continue;
      const weekOf = mondayOfYmd(day);
      if (!weekMap.has(weekOf)) continue;
      const bucket = weekMap.get(weekOf);
      const eventType = row.event_type != null ? String(row.event_type) : '';
      bucket.count += 1;
      if (eventType) {
        bucket.by_type[eventType] = (bucket.by_type[eventType] || 0) + 1;
      }
    }

    const { data: phaseRows, error: phaseError } = await supabase
      .from('liquidity_cycle_daily_log')
      .select('log_date, cycle_phase')
      .gte('log_date', rangeStart)
      .lte('log_date', rangeEnd);

    if (phaseError) {
      logger.error('competitor-activity-weekly liquidity phases failed', {
        error: phaseError.message,
      });
      return res.status(500).json({ error: phaseError.message });
    }

    /** @type {Map<string, string>} */
    const phaseByDate = new Map();
    (Array.isArray(phaseRows) ? phaseRows : []).forEach((row) => {
      const day =
        row && row.log_date != null ? String(row.log_date).slice(0, 10) : '';
      if (!YMD_RE.test(day) || !row.cycle_phase) return;
      phaseByDate.set(day, String(row.cycle_phase));
    });

    const phase_by_week = weeks.map((week_of) => ({
      week_of,
      dominant_phase: dominantPhaseForWeek(week_of, phaseByDate),
    }));

    const entities = entitiesMeta
      .map((ent) => {
        const weekMap = countsByEntityWeek.get(String(ent.id));
        const series = weeks.map((week_of) => {
          const bucket = weekMap
            ? weekMap.get(week_of) || { count: 0, by_type: {} }
            : { count: 0, by_type: {} };
          return {
            week_of,
            count: bucket.count,
            by_type: bucket.by_type,
          };
        });
        const total_events = series.reduce((sum, p) => sum + p.count, 0);
        return {
          entity_id: String(ent.id),
          name: ent.name || 'Entidad',
          total_events,
          series,
        };
      })
      .sort((a, b) => {
        if (b.total_events !== a.total_events) {
          return b.total_events - a.total_events;
        }
        return String(a.name).localeCompare(String(b.name), 'es');
      });

    return res.status(200).json({ weeks, entities, phase_by_week });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /reports/competitor-activity-weekly unexpected', {
      error: message,
    });
    return res.status(500).json({ error: message });
  }
});

module.exports = router;
module.exports.buildHugoContext = buildHugoContext;
module.exports.isValidDateOnly = isValidDateOnly;
module.exports.todayUtc = todayUtc;
module.exports.HISTORY_WINDOW_DAYS = HISTORY_WINDOW_DAYS;
module.exports.parseTrendsFormattedValue = parseTrendsFormattedValue;
