/**
 * Liquidity cycle API.
 * GET /api/liquidity-cycle/history — last 30 days + today's phase (Montevideo).
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { phaseForDayOfMonth } = require('../jobs/liquidityCycleSync');

const router = express.Router();
const PAGE_SIZE = 1000;

function toDateOnly(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

function shiftDateOnly(dateStr, deltaDays) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function enumerateDates(minDate, maxDate) {
  const dates = [];
  let current = minDate;
  while (current <= maxDate) {
    dates.push(current);
    current = shiftDateOnly(current, 1);
  }
  return dates;
}

function minMaxDates(history) {
  let minDate = null;
  let maxDate = null;
  for (const row of history) {
    const date = toDateOnly(row && row.log_date);
    if (!date) continue;
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
  }
  return { minDate, maxDate };
}

function expandHoliday(row) {
  const start = toDateOnly(row && row.date_start);
  if (!start) return [];
  const rawEnd = toDateOnly(row && row.date_end);
  const end = rawEnd && rawEnd > start ? rawEnd : start;
  const title =
    row && typeof row.title === 'string' && row.title.trim()
      ? row.title.trim()
      : 'Feriado';

  return enumerateDates(start, end).map((date) => ({ date, title }));
}

async function loadOwnMetricRows(entityIds, minDate, maxDate) {
  if (!entityIds.length) return [];
  const rows = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('own_ad_metrics')
      .select(
        'id, entity_id, campaign_id, metric_date, spend, clicks, created_at',
      )
      .in('entity_id', entityIds)
      .gte('metric_date', minDate)
      .lte('metric_date', maxDate)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to load own_ad_metrics: ${error.message}`);
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return rows;
}

async function loadCompetitorEventRows(selfEntityIds, minDate, maxDate) {
  const rows = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from('events')
      .select('id, entity_id, detected_at')
      .gte('detected_at', minDate)
      .lte('detected_at', maxDate)
      .order('detected_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (selfEntityIds.length) {
      query = query.not(
        'entity_id',
        'in',
        `(${selfEntityIds.join(',')})`,
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load competitor events: ${error.message}`);
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return rows;
}

function buildOwnCpcByDate(rows) {
  // Keep newest capture per self entity/campaign/date.
  const latest = new Map();
  for (const row of rows) {
    const date = toDateOnly(row.metric_date);
    if (!date) continue;
    const key = `${row.entity_id}|${row.campaign_id || ''}|${date}`;
    if (!latest.has(key)) latest.set(key, row);
  }

  const totals = new Map();
  for (const row of latest.values()) {
    const date = toDateOnly(row.metric_date);
    const current = totals.get(date) || { spend: 0, clicks: 0 };
    if (row.spend != null && Number.isFinite(Number(row.spend))) {
      current.spend += Number(row.spend);
    }
    if (row.clicks != null && Number.isFinite(Number(row.clicks))) {
      current.clicks += Number(row.clicks);
    }
    totals.set(date, current);
  }

  const cpcByDate = new Map();
  for (const [date, total] of totals.entries()) {
    cpcByDate.set(
      date,
      total.clicks > 0 ? total.spend / total.clicks : null,
    );
  }
  return cpcByDate;
}

function buildEventCountsByDate(rows) {
  const counts = new Map();
  for (const row of rows) {
    const date = toDateOnly(row.detected_at);
    if (!date) continue;
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  return counts;
}

function buildBcuRateByDate(rateRows, minDate, maxDate) {
  const rates = (rateRows || [])
    .map((row) => ({
      date: toDateOnly(row.effective_from),
      rate: Number(row.rate_percent),
    }))
    .filter((row) => row.date && Number.isFinite(row.rate))
    .sort((a, b) => a.date.localeCompare(b.date));

  const result = new Map();
  let pointer = 0;
  let currentRate = null;

  for (const date of enumerateDates(minDate, maxDate)) {
    while (pointer < rates.length && rates[pointer].date <= date) {
      currentRate = rates[pointer].rate;
      pointer += 1;
    }
    result.set(date, currentRate);
  }
  return result;
}

async function resolveMontevideoToday() {
  const { data: yesterday, error } = await supabase.rpc('montevideo_yesterday');
  if (error) {
    throw new Error(`montevideo_yesterday failed: ${error.message}`);
  }
  // today = yesterday + 1 calendar day (same zone as the RPC).
  const y = String(yesterday);
  const [yy, mm, dd] = y.split('-').map(Number);
  const dt = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yyyy = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mo}-${day}`;
}

router.get('/history', async (req, res) => {
  try {
    const today = await resolveMontevideoToday();
    const dayOfMonth = Number(today.slice(8, 10));
    const todayPhase = phaseForDayOfMonth(dayOfMonth);

    const { data, error } = await supabase
      .from('liquidity_cycle_daily_log')
      .select(
        [
          'log_date',
          'cycle_phase',
          'day_of_month',
          'meta_spend_day',
          'competitor_pressure_ratio',
          'own_cpm_ratio',
          'auction_pressure_index',
        ].join(', '),
      )
      .order('log_date', { ascending: false })
      .limit(30);

    if (error) {
      logger.error('GET /api/liquidity-cycle/history failed', {
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    const rawHistory = data || [];
    if (!rawHistory.length) {
      return res.json({ history: [], holidays: [] });
    }

    const { minDate, maxDate } = minMaxDates(rawHistory);
    if (!minDate || !maxDate) {
      return res.json({ history: [], holidays: [] });
    }

    const { data: selfRows, error: selfError } = await supabase
      .from('monitored_entities')
      .select('id')
      .eq('is_self', true);

    if (selfError) {
      throw new Error(`Failed to load self entities: ${selfError.message}`);
    }
    const selfEntityIds = (selfRows || [])
      .map((row) => row.id)
      .filter(Boolean);

    const [
      holidayResult,
      ownMetricRows,
      bcuResult,
      competitorEventRows,
    ] = await Promise.all([
      supabase
        .from('economic_calendar_events')
        .select('title, date_start, date_end')
        .eq('event_type', 'holiday')
        .lte('date_start', maxDate)
        .or(
          `date_end.gte.${minDate},and(date_end.is.null,date_start.gte.${minDate})`,
        ),
      loadOwnMetricRows(selfEntityIds, minDate, maxDate),
      supabase
        .from('bcu_usura_rate_history')
        .select('rate_percent, effective_from')
        .lte('effective_from', maxDate)
        .order('effective_from', { ascending: true }),
      loadCompetitorEventRows(selfEntityIds, minDate, maxDate),
    ]);

    if (holidayResult.error) {
      throw new Error(
        `Failed to load holidays: ${holidayResult.error.message}`,
      );
    }
    if (bcuResult.error) {
      throw new Error(
        `Failed to load BCU rate history: ${bcuResult.error.message}`,
      );
    }

    const holidayByDate = new Map();
    for (const row of holidayResult.data || []) {
      for (const holiday of expandHoliday(row)) {
        if (holiday.date < minDate || holiday.date > maxDate) continue;
        if (!holidayByDate.has(holiday.date)) {
          holidayByDate.set(holiday.date, holiday);
        }
      }
    }

    const holidays = [...holidayByDate.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const cpcByDate = buildOwnCpcByDate(ownMetricRows);
    const eventCountsByDate = buildEventCountsByDate(competitorEventRows);
    const bcuRateByDate = buildBcuRateByDate(
      bcuResult.data || [],
      minDate,
      maxDate,
    );

    const history = rawHistory.map((row) => {
      const date = toDateOnly(row.log_date);
      return {
        ...row,
        log_date: date || row.log_date,
        own_cpc: date ? cpcByDate.get(date) ?? null : null,
        // Blocked until reliable lead attribution/CAPI data exists.
        own_cpl: null,
        bcu_usura_rate: date ? bcuRateByDate.get(date) ?? null : null,
        total_competitor_events: date
          ? eventCountsByDate.get(date) || 0
          : 0,
      };
    });

    return res.json({
      today: {
        date: today,
        dayOfMonth,
        cyclePhase: todayPhase,
      },
      history,
      holidays,
    });
  } catch (err) {
    logger.error('GET /api/liquidity-cycle/history unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

module.exports = router;
