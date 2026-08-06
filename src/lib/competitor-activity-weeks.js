'use strict';

const {
  formatYmdMontevideo,
  addCalendarDays,
  mondayOfYmd,
  YMD_RE,
} = require('./montevideo-week');

const MAX_ACTIVITY_WEEKLY_WEEKS = 26;

/**
 * Monday of the last complete Mon–Sun week (America/Montevideo), relative to `now`.
 * Excludes the in-progress week.
 */
function lastCompleteWeekMonday(now = new Date()) {
  const currentMonday = mondayOfYmd(formatYmdMontevideo(now));
  return addCalendarDays(currentMonday, -7);
}

/** Last N complete Mon–Sun weeks (America/Montevideo), excluding current week. */
function resolveLastCompleteWeeks(count = 8, now = new Date()) {
  const lastCompleteMonday = lastCompleteWeekMonday(now);
  const weeks = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    weeks.push(addCalendarDays(lastCompleteMonday, -7 * i));
  }
  return weeks;
}

/**
 * Optional ?from=&to= (YYYY-MM-DD), snapped to Monday. Default: last 8 complete weeks.
 * Caps `to` at lastCompleteWeekMonday(now) so in-progress / future weeks are excluded.
 * @returns {{ weeks: string[] } | { error: string }}
 */
function resolveWeeksFromRange(fromRaw, toRaw, now = new Date()) {
  const hasFrom = fromRaw != null && String(fromRaw).trim() !== '';
  const hasTo = toRaw != null && String(toRaw).trim() !== '';
  if (!hasFrom && !hasTo) {
    return { weeks: resolveLastCompleteWeeks(8, now) };
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
  const lastComplete = lastCompleteWeekMonday(now);
  const effectiveToMonday =
    toMonday <= lastComplete ? toMonday : lastComplete;
  if (effectiveToMonday < fromMonday) {
    return { weeks: [] };
  }
  const weeks = [];
  for (
    let w = fromMonday;
    w <= effectiveToMonday;
    w = addCalendarDays(w, 7)
  ) {
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

module.exports = {
  MAX_ACTIVITY_WEEKLY_WEEKS,
  lastCompleteWeekMonday,
  resolveLastCompleteWeeks,
  resolveWeeksFromRange,
};
