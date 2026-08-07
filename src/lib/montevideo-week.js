'use strict';

/**
 * Civil-week helpers for America/Montevideo (Mon–Sun).
 * Single source of truth — do not reimplement in feature modules.
 */

const TZ = 'America/Montevideo';
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Civil YYYY-MM-DD in America/Montevideo for an Instant.
 * @param {Date} [date]
 */
function formatYmdMontevideo(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}

/**
 * Instant as ISO-like local timestamp in America/Montevideo (offset from Intl, not hardcoded).
 * Example: 2026-08-07T10:15:30-03:00
 * @param {Date} [date]
 */
function formatInstantMontevideo(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  /** @type {Record<string, string>} */
  const bag = {};
  dtf.formatToParts(date).forEach((part) => {
    if (part.type !== 'literal') bag[part.type] = part.value;
  });
  let offset = String(bag.timeZoneName || 'GMT')
    .replace(/^GMT/i, '')
    .replace(/^UTC/i, '');
  if (!offset) offset = '+00:00';
  if (/^[+-]\d{1,2}$/.test(offset)) {
    offset = offset[0] + offset.slice(1).padStart(2, '0') + ':00';
  } else if (/^[+-]\d{2}$/.test(offset)) {
    offset = offset + ':00';
  } else if (/^[+-]\d{2}\d{2}$/.test(offset)) {
    offset = offset.slice(0, 3) + ':' + offset.slice(3);
  }
  return (
    bag.year +
    '-' +
    bag.month +
    '-' +
    bag.day +
    'T' +
    bag.hour +
    ':' +
    bag.minute +
    ':' +
    bag.second +
    offset
  );
}

/**
 * Weekday short name (Mon..Sun) for a civil YMD interpreted in Montevideo.
 * Uruguay is UTC-3 year-round; midday UTC maps to local morning/noon.
 * @param {string} ymd
 */
function weekdayShortForYmd(ymd) {
  const probe = new Date(`${ymd}T15:00:00.000Z`);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
  }).format(probe);
}

/**
 * @param {string} ymd
 * @param {number} deltaDays
 */
function addCalendarDays(ymd, deltaDays) {
  const m = YMD_RE.exec(ymd);
  if (!m) throw new Error(`Invalid YMD: ${ymd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d) + deltaDays * 86_400_000;
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function daysBackToMonday(weekdayShort) {
  const map = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  if (map[weekdayShort] == null) {
    throw new Error(`Unexpected weekday: ${weekdayShort}`);
  }
  return map[weekdayShort];
}

/**
 * Monday (YYYY-MM-DD) of the Montevideo civil week containing ymd.
 * @param {string} ymd
 */
function mondayOfYmd(ymd) {
  return addCalendarDays(ymd, -daysBackToMonday(weekdayShortForYmd(ymd)));
}

module.exports = {
  formatYmdMontevideo,
  formatInstantMontevideo,
  weekdayShortForYmd,
  addCalendarDays,
  daysBackToMonday,
  mondayOfYmd,
  YMD_RE,
};
