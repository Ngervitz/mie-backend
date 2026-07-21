function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function todayUtc() {
  return new Date().toISOString().split('T')[0];
}

/** Calendar date in Uruguay (America/Montevideo). Returns YYYY-MM-DD. */
function todayUruguay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
}

function shiftDateUtc(dateStr, deltaDays) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

function daysBetween(startDateStr, endDateStr) {
  const [y1, m1, d1] = String(startDateStr).split('-').map(Number);
  const [y2, m2, d2] = String(endDateStr).split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function enumerateDaysHalfOpen(startDateStr, endDateStr) {
  const days = [];
  let current = startDateStr;
  while (current < endDateStr) {
    days.push(current);
    current = shiftDateUtc(current, 1);
  }
  return days;
}

function toDateOnly(value) {
  if (!value) return null;
  const s = String(value);
  if (isValidDateOnly(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

module.exports = {
  isValidDateOnly,
  todayUtc,
  todayUruguay,
  shiftDateUtc,
  daysBetween,
  enumerateDaysHalfOpen,
  toDateOnly,
};
