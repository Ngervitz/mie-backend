'use strict';

const {
  lastCompleteWeekMonday,
} = require('../../lib/competitor-activity-weeks');
const { addCalendarDays } = require('../../lib/montevideo-week');
const {
  success,
  empty,
  error,
  withTransientRetry,
} = require('../toolContract');

const SOURCE_TABLE = 'events';
const PAGE_SIZE = 1000;

const TOOL_DEFINITION = Object.freeze({
  name: 'get_competitor_activity',
  description:
    'Actividad de competidores (anuncios nuevos) en las dos últimas semanas civiles completas (lun–dom, America/Montevideo). ' +
    'status success con ceros = entidades elegibles observadas, sin new_ad en esas semanas. ' +
    'status empty = no hay competidores activos elegibles. ' +
    'status error = no se pudo consultar; no implica ausencia de actividad.',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
});

function getDefaultSupabase() {
  return require('../../clients/supabase');
}

function weekBounds(now) {
  const thisMon = lastCompleteWeekMonday(now);
  const priorMon = addCalendarDays(thisMon, -7);
  const rangeEndExclusive = addCalendarDays(thisMon, 7);
  return { thisMon, priorMon, rangeEndExclusive };
}

/**
 * supabase-js equivalent of the audited CTE query.
 * Distinction empty vs zeros: eligible entities are loaded first.
 * 0 entities → empty. N entities → success, including all-zero rows.
 *
 * @param {object} client
 * @param {Date} [now]
 */
async function queryCompetitorActivity(client, now) {
  const { thisMon, priorMon, rangeEndExclusive } = weekBounds(now);

  const { data: entityRows, error: entitiesError } = await client
    .from('monitored_entities')
    .select('id, name')
    .eq('is_self', false)
    .eq('active', true);

  if (entitiesError) {
    const err = new Error(entitiesError.message || 'entities query failed');
    err.code = entitiesError.code;
    err.transient = /timeout|fetch|network|connection/i.test(
      String(entitiesError.message || ''),
    );
    throw err;
  }

  const entities = Array.isArray(entityRows) ? entityRows : [];
  if (entities.length === 0) {
    return { kind: 'empty' };
  }

  const entityIds = entities.map((e) => e.id).filter(Boolean);
  const eventRows = [];
  if (entityIds.length > 0) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error: eventsError } = await client
        .from('events')
        .select('id, entity_id, detected_at, event_type')
        .in('entity_id', entityIds)
        .eq('event_type', 'new_ad')
        .gte('detected_at', priorMon)
        .lt('detected_at', rangeEndExclusive)
        .order('detected_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (eventsError) {
        const err = new Error(eventsError.message || 'events query failed');
        err.code = eventsError.code;
        err.transient = /timeout|fetch|network|connection/i.test(
          String(eventsError.message || ''),
        );
        throw err;
      }
      eventRows.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
    }
  }

  /** @type {Map<string, { new_ads_this_week: number, new_ads_prior_week: number }>} */
  const byName = new Map();
  for (const ent of entities) {
    const name = ent && ent.name != null ? String(ent.name) : '';
    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, { new_ads_this_week: 0, new_ads_prior_week: 0 });
    }
  }

  const idToName = new Map();
  for (const ent of entities) {
    if (ent && ent.id != null && ent.name != null) {
      idToName.set(String(ent.id), String(ent.name));
    }
  }

  for (const row of eventRows) {
    const name =
      row && row.entity_id != null
        ? idToName.get(String(row.entity_id))
        : null;
    if (!name || !byName.has(name)) continue;
    const day =
      row && row.detected_at != null
        ? String(row.detected_at).slice(0, 10)
        : '';
    if (day >= thisMon && day < rangeEndExclusive) {
      byName.get(name).new_ads_this_week += 1;
    } else if (day >= priorMon && day < thisMon) {
      byName.get(name).new_ads_prior_week += 1;
    }
  }

  const rows = Array.from(byName.entries())
    .map(([name, counts]) => ({
      name,
      new_ads_this_week: counts.new_ads_this_week,
      new_ads_prior_week: counts.new_ads_prior_week,
    }))
    .sort((a, b) => {
      if (b.new_ads_this_week !== a.new_ads_this_week) {
        return b.new_ads_this_week - a.new_ads_this_week;
      }
      return a.name.localeCompare(b.name, 'es');
    });

  return { kind: 'rows', rows };
}

/**
 * @param {object} [_input]
 * @param {{
 *   supabase?: object,
 *   now?: Date,
 *   onRetry?: () => void,
 * }} [deps]
 */
function isForceToolErrorEnabled(deps) {
  return Boolean(deps && deps.forceToolError === true);
}

async function getCompetitorActivity(_input, deps) {
  const client =
    deps && deps.supabase ? deps.supabase : getDefaultSupabase();
  const now = deps && deps.now ? deps.now : new Date();
  const onRetry = deps && deps.onRetry;

  if (isForceToolErrorEnabled(deps)) {
    return error(
      'Forced tool error (ASSIST_ALLOW_FORCE_TOOL_ERROR)',
      SOURCE_TABLE,
    );
  }

  try {
    const { value } = await withTransientRetry(
      () => queryCompetitorActivity(client, now),
      { onRetry },
    );
    if (value.kind === 'empty') {
      return empty(SOURCE_TABLE);
    }
    return success(value.rows, SOURCE_TABLE);
  } catch (err) {
    return error(
      err && err.message ? err.message : 'Failed to query competitor activity',
      SOURCE_TABLE,
    );
  }
}

module.exports = {
  TOOL_DEFINITION,
  SOURCE_TABLE,
  weekBounds,
  queryCompetitorActivity,
  getCompetitorActivity,
};
