'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  surveyConversionByCi,
  endOfMonthCutoffMs,
} = require('../src/lib/czSurveyConversionByCi');

function monthKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
  return ymd && ymd.length >= 7 ? ymd.slice(0, 7) : null;
}

// Repeated CI in same month counts once in denominator.
{
  const rows = [
    { ci: 1001, fecha_reg: '2026-11-05T12:00:00.000Z' },
    { ci: 1001, fecha_reg: '2026-11-20T12:00:00.000Z' },
    { ci: 1002, fecha_reg: '2026-11-10T12:00:00.000Z' },
  ];
  const out = surveyConversionByCi(
    { solicitudRows: rows, surveyRows: [] },
    { monthKey, nowMs: Date.parse('2026-11-23T18:00:00.000Z'), currentMonthKey: '2026-11' },
  );
  const nov = out.surveyConversionByMonth.find((r) => r.month === '2026-11');
  assert.strictEqual(nov.denominator, 2);
  assert.strictEqual(nov.numerator, 0);
}

// Multiple surveys per CI count once in numerator.
{
  const sol = [{ ci: 2001, fecha_reg: '2026-11-01T12:00:00.000Z' }];
  const enc = [
    { ci: 2001, completed_at: '2026-11-02T12:00:00.000Z' },
    { ci: 2001, completed_at: '2026-11-15T12:00:00.000Z' },
  ];
  const out = surveyConversionByCi(
    { solicitudRows: sol, surveyRows: enc },
    { monthKey, nowMs: Date.parse('2026-11-23T18:00:00.000Z'), currentMonthKey: '2026-11' },
  );
  const nov = out.surveyConversionByMonth.find((r) => r.month === '2026-11');
  assert.strictEqual(nov.numerator, 1);
  assert.strictEqual(nov.rate, 100);
}

// Past month: survey after month end does not count for that month.
{
  const sol = [{ ci: 3001, fecha_reg: '2026-10-05T12:00:00.000Z' }];
  const enc = [{ ci: 3001, completed_at: '2026-11-05T12:00:00.000Z' }];
  const out = surveyConversionByCi(
    { solicitudRows: sol, surveyRows: enc },
    { monthKey, nowMs: Date.parse('2026-11-23T18:00:00.000Z'), currentMonthKey: '2026-11' },
  );
  const oct = out.surveyConversionByMonth.find((r) => r.month === '2026-10');
  assert.strictEqual(oct.denominator, 1);
  assert.strictEqual(oct.numerator, 0);
  assert.strictEqual(oct.rate, 0);
  const cut = endOfMonthCutoffMs('2026-10');
  assert.ok(Date.parse(enc[0].completed_at) > cut);
}

// Overall: numerator only from solicitud CI universe.
{
  const sol = [
    { ci: 4001, fecha_reg: '2026-09-01T12:00:00.000Z' },
    { ci: 4002, fecha_reg: '2026-09-02T12:00:00.000Z' },
  ];
  const enc = [
    { ci: 4001, completed_at: '2026-09-03T12:00:00.000Z' },
    { ci: 9999, completed_at: '2026-09-03T12:00:00.000Z' },
  ];
  const out = surveyConversionByCi(
    { solicitudRows: sol, surveyRows: enc },
    { monthKey, nowMs: Date.parse('2026-11-23T18:00:00.000Z'), currentMonthKey: '2026-11' },
  );
  assert.strictEqual(out.surveyConversionOverall.denominator, 2);
  assert.strictEqual(out.surveyConversionOverall.numerator, 1);
  assert.strictEqual(out.surveyConversionOverall.rate, 50);
}

// CI appears in two months when solicitud in both.
{
  const sol = [
    { ci: 5001, fecha_reg: '2026-09-01T12:00:00.000Z' },
    { ci: 5001, fecha_reg: '2026-10-01T12:00:00.000Z' },
  ];
  const enc = [{ ci: 5001, completed_at: '2026-10-15T12:00:00.000Z' }];
  const out = surveyConversionByCi(
    { solicitudRows: sol, surveyRows: enc },
    { monthKey, nowMs: Date.parse('2026-11-23T18:00:00.000Z'), currentMonthKey: '2026-11' },
  );
  const sep = out.surveyConversionByMonth.find((r) => r.month === '2026-09');
  const oct = out.surveyConversionByMonth.find((r) => r.month === '2026-10');
  assert.strictEqual(sep.denominator, 1);
  assert.strictEqual(sep.numerator, 0);
  assert.strictEqual(oct.denominator, 1);
  assert.strictEqual(oct.numerator, 1);
}

// Null CI excluded.
{
  const sol = [
    { ci: null, fecha_reg: '2026-11-01T12:00:00.000Z' },
    { ci: 6001, fecha_reg: '2026-11-01T12:00:00.000Z' },
  ];
  const out = surveyConversionByCi(
    { solicitudRows: sol, surveyRows: [] },
    { monthKey, nowMs: Date.parse('2026-11-23T18:00:00.000Z'), currentMonthKey: '2026-11' },
  );
  assert.strictEqual(out.surveyConversionOverall.denominator, 1);
}

const route = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'reports.js'),
  'utf8',
);
const summary = route.slice(
  route.indexOf("router.get('/cz-funnel-summary'"),
  route.indexOf("router.get('/cz-funnel-channel-utility'"),
);
assert.ok(summary.includes('surveyConversionByCi'));
assert.ok(summary.includes('...surveyConversionByCi('));

const dashboard = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'mie-dashboard.js'),
  'utf8',
);
assert.ok(dashboard.includes('Personas que completaron encuesta'));

console.log('unit-cz-survey-conversion-by-ci: ok');