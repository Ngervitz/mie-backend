const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

/**
 * Uruguay holidays — deterministic calculation from the holiday law.
 *
 * Legal basis (verified against the IMPO text of Ley 16.805, art. 1 y 2,
 * redacción dada por Ley 17.414):
 *   A) Feriados que caen sábado, domingo o lunes se observan ese mismo día.
 *   B) Martes o miércoles → se observan el lunes inmediato ANTERIOR.
 *   C) Jueves o viernes → se observan el lunes inmediato SIGUIENTE.
 * Exceptuados (inamovibles, art. 2): Carnaval, Semana de Turismo,
 * 1 y 6 de enero, 1 de mayo, 19 de junio, 18 de julio, 25 de agosto,
 * 2 de noviembre y 25 de diciembre.
 *
 * LIMITATION: ad-hoc "días no laborables con fines turísticos" declared by
 * government decree for specific years (e.g. 2026 had extra ones) CANNOT be
 * calculated from the law and require manual entry when announced.
 */

const SOURCE = 'calculated';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateOnly(dt) {
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function shiftDays(dt, deltaDays) {
  const copy = new Date(dt.getTime());
  copy.setUTCDate(copy.getUTCDate() + deltaDays);
  return copy;
}

/** Easter Sunday (Gregorian) — Meeus/Jones/Butcher algorithm. */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

/**
 * Ley 16.805 art. 1 shift rule (complete, all weekdays covered):
 * Sat(6)/Sun(0)/Mon(1) → same day; Tue(2)/Wed(3) → previous Monday;
 * Thu(4)/Fri(5) → next Monday.
 */
function applyShiftRule(dt) {
  const dow = dt.getUTCDay();
  if (dow === 2) return shiftDays(dt, -1);
  if (dow === 3) return shiftDays(dt, -2);
  if (dow === 4) return shiftDays(dt, 4);
  if (dow === 5) return shiftDays(dt, 3);
  return dt;
}

function buildUruguayHolidays(year) {
  const events = [];

  const pushSingle = (title, dt, description, observedFrom) => {
    events.push({
      event_type: 'holiday',
      title,
      date_start: toDateOnly(dt),
      date_end: null,
      description,
      source: SOURCE,
      raw_text: observedFrom
        ? `Fecha original ${observedFrom}; observado según Ley 16.805 art. 1 (mod. Ley 17.414)`
        : `Feriado inamovible (Ley 16.805 art. 2, mod. Ley 17.414)`,
    });
  };

  // --- Non-movable fixed holidays (art. 2) ---
  pushSingle('Año Nuevo', utcDate(year, 1, 1), 'Feriado no laborable');
  pushSingle('Día de Reyes', utcDate(year, 1, 6), 'Feriado laborable');
  pushSingle('Día de los Trabajadores', utcDate(year, 5, 1), 'Feriado no laborable');
  pushSingle('Natalicio de Artigas', utcDate(year, 6, 19), 'Feriado laborable');
  pushSingle('Jura de la Constitución', utcDate(year, 7, 18), 'Feriado no laborable');
  pushSingle('Declaratoria de la Independencia', utcDate(year, 8, 25), 'Feriado no laborable');
  pushSingle('Día de los Difuntos', utcDate(year, 11, 2), 'Feriado laborable');
  pushSingle('Navidad (Día de la Familia)', utcDate(year, 12, 25), 'Feriado no laborable');

  // --- Easter-derived, non-movable (art. 2) ---
  const easter = easterSunday(year);
  const carnivalMonday = shiftDays(easter, -48);
  const carnivalTuesday = shiftDays(easter, -47);
  pushSingle('Carnaval (lunes)', carnivalMonday, 'Feriado laborable — calculado desde Pascua');
  pushSingle('Carnaval (martes)', carnivalTuesday, 'Feriado laborable — calculado desde Pascua');

  // Semana de Turismo: Monday through Saturday before Easter Sunday.
  const turismoStart = shiftDays(easter, -6);
  const turismoEnd = shiftDays(easter, -1);
  events.push({
    event_type: 'holiday',
    title: 'Semana de Turismo',
    date_start: toDateOnly(turismoStart),
    date_end: toDateOnly(turismoEnd),
    description: 'Semana previa a Pascua — feriados laborables',
    source: SOURCE,
    raw_text: 'Calculada desde Pascua; inamovible (Ley 16.805 art. 2, mod. Ley 17.414)',
  });

  // --- Movable holidays (art. 1 complete shift rule) ---
  const movables = [
    { title: 'Desembarco de los 33 Orientales', dt: utcDate(year, 4, 19) },
    { title: 'Batalla de las Piedras', dt: utcDate(year, 5, 18) },
    { title: 'Día de la Raza', dt: utcDate(year, 10, 12) },
  ];
  for (const m of movables) {
    const observed = applyShiftRule(m.dt);
    pushSingle(
      m.title,
      observed,
      'Feriado laborable trasladable',
      toDateOnly(m.dt) !== toDateOnly(observed) ? toDateOnly(m.dt) : null,
    );
  }

  return events;
}

/**
 * Calculate and upsert Uruguay holidays for a year (default: current UTC year).
 * Idempotent via onConflict (event_type, date_start, title, source).
 */
async function calculateUruguayHolidays({ year } = {}) {
  const targetYear =
    Number.isInteger(year) && year > 1900 ? year : new Date().getUTCFullYear();

  const events = buildUruguayHolidays(targetYear);

  const { error } = await supabase
    .from('economic_calendar_events')
    .upsert(events, { onConflict: 'event_type,date_start,title,source' });

  if (error) {
    throw new Error(`Failed to upsert holidays: ${error.message}`);
  }

  logger.info('Uruguay holidays calculated', {
    year: targetYear,
    eventsUpserted: events.length,
  });

  return { year: targetYear, eventsUpserted: events.length, events };
}

module.exports = {
  calculateUruguayHolidays,
  buildUruguayHolidays,
  applyShiftRule,
  easterSunday,
};
