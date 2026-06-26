const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const router = express.Router();

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

module.exports = router;
