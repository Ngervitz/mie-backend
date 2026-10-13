'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  surveyConversionByRejectionMonth,
} = require('../src/lib/czSurveyConversion');

function monthKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
  if (!ymd || ymd.length < 7) return null;
  return ymd.slice(0, 7);
}

function findMonth(rows, month) {
  return rows.find(function (r) {
    return r.month === month;
  });
}

let nextSol = 1;
let nextHist = 1;

function rejection(ci, iso, estadoId) {
  const czId = nextSol;
  nextSol += 1;
  const histId = nextHist;
  nextHist += 1;
  return {
    solicitud: { cz_id: czId, ci: ci, fecha_reg: iso },
    estado: {
      cz_solicitud_id: czId,
      solicitudes_estados_id: estadoId == null ? 3 : estadoId,
      fechahora_src: iso,
      cz_historico_id: histId,
    },
  };
}

function run(parts, surveys) {
  return surveyConversionByRejectionMonth(
    {
      estadoRows: parts.map(function (p) {
        return p.estado;
      }),
      solicitudRows: parts.map(function (p) {
        return p.solicitud;
      }),
      surveyRows: surveys || [],
    },
    monthKey,
  );
}

function referenceCohort(startCi, monthIso, noneCount, afterCount, beforeCount, afterInLaterMonth) {
  const parts = [];
  const surveys = [];
  let ci = startCi;
  const later = afterInLaterMonth || 0;
  for (let i = 0; i < noneCount; i += 1) {
    parts.push(rejection(ci, monthIso));
    ci += 1;
  }
  for (let i = 0; i < afterCount; i += 1) {
    const at = i < later ? '2026-11-02T15:00:00.000Z' : '2026-10-20T15:00:00.000Z';
    parts.push(rejection(ci, monthIso));
    surveys.push({ ci: ci, completed_at: at });
    ci += 1;
  }
  for (let i = 0; i < beforeCount; i += 1) {
    parts.push(rejection(ci, monthIso));
    surveys.push({ ci: ci, completed_at: '2026-08-01T15:00:00.000Z' });
    ci += 1;
  }
  return { parts: parts, surveys: surveys };
}

// Repeated rejections in one month stay a single CI, anchored on the first event.
{
  const parts = [
    rejection(1001, '2026-10-03T15:00:00.000Z'),
    rejection(1001, '2026-10-20T15:00:00.000Z'),
  ];
  const rows = run(parts, [{ ci: 1001, completed_at: '2026-10-10T15:00:00.000Z' }]);
  const oct = findMonth(rows, '2026-10');
  assert.strictEqual(oct.denominator, 1);
  assert.strictEqual(oct.numerator, 1);
  assert.strictEqual(oct.rate, 100);
}

// A CI rejected in two months is counted in each cohort from that month's first rejection.
{
  const parts = [
    rejection(1002, '2026-09-05T15:00:00.000Z'),
    rejection(1002, '2026-10-15T15:00:00.000Z'),
  ];
  const rows = run(parts, [{ ci: 1002, completed_at: '2026-10-02T15:00:00.000Z' }]);
  const sep = findMonth(rows, '2026-09');
  const oct = findMonth(rows, '2026-10');
  assert.strictEqual(sep.denominator, 1);
  assert.strictEqual(sep.numerator, 1);
  assert.strictEqual(oct.denominator, 0);
  assert.strictEqual(oct.numerator, 0);
  assert.strictEqual(oct.rate, null);
}

// A completion after the rejection month stays in the original cohort.
{
  const parts = [rejection(1003, '2026-09-01T15:00:00.000Z')];
  const rows = run(parts, [{ ci: 1003, completed_at: '2026-11-01T15:00:00.000Z' }]);
  const sep = findMonth(rows, '2026-09');
  assert.strictEqual(sep.denominator, 1);
  assert.strictEqual(sep.numerator, 1);
  assert.strictEqual(findMonth(rows, '2026-11'), undefined);
}

// A survey completed before the first rejection is outside the denominator.
{
  const parts = [rejection(1004, '2026-10-10T15:00:00.000Z')];
  const rows = run(parts, [{ ci: 1004, completed_at: '2026-09-01T15:00:00.000Z' }]);
  const oct = findMonth(rows, '2026-10');
  assert.strictEqual(oct.denominator, 0);
  assert.strictEqual(oct.numerator, 0);
  assert.strictEqual(oct.rate, null);
}

// Several survey rows: the earliest completed_at is the lifetime completion.
{
  const before = rejection(1005, '2026-10-10T15:00:00.000Z');
  const after = rejection(1006, '2026-10-10T15:00:00.000Z');
  const rows = run([before, after], [
    { ci: 1005, completed_at: '2026-10-20T15:00:00.000Z' },
    { ci: 1005, completed_at: '2026-09-01T15:00:00.000Z' },
    { ci: 1006, completed_at: '2026-10-30T15:00:00.000Z' },
    { ci: 1006, completed_at: '2026-10-12T15:00:00.000Z' },
  ]);
  const oct = findMonth(rows, '2026-10');
  assert.strictEqual(oct.denominator, 1);
  assert.strictEqual(oct.numerator, 1);
}

// Cohort whose every CI already had a survey: no eligible rejected CIs, no fake 0%.
{
  const parts = [
    rejection(1007, '2026-12-02T15:00:00.000Z'),
    rejection(1008, '2026-12-03T15:00:00.000Z'),
  ];
  const rows = run(parts, [
    { ci: 1007, completed_at: '2026-11-01T15:00:00.000Z' },
    { ci: 1008, completed_at: '2026-11-02T15:00:00.000Z' },
  ]);
  const dec = findMonth(rows, '2026-12');
  assert.strictEqual(dec.denominator, 0);
  assert.strictEqual(dec.numerator, 0);
  assert.strictEqual(dec.rate, null);
  assert.strictEqual(findMonth(rows, '2026-01'), undefined);
}

// Same timestamp collapses to one CI. Completion exactly at T0 counts.
{
  const a = rejection(1009, '2026-07-04T15:00:00.000Z');
  const b = rejection(1009, '2026-07-04T15:00:00.000Z');
  const ignored = rejection(1010, '2026-07-04T15:00:00.000Z', 4);
  const rows = run([b, a, ignored], [
    { ci: 1009, completed_at: '2026-07-04T15:00:00.000Z' },
  ]);
  const jul = findMonth(rows, '2026-07');
  assert.strictEqual(jul.denominator, 1);
  assert.strictEqual(jul.numerator, 1);
}

// Montevideo month boundary: 2026-10-01 02:30 UTC is still 30 September locally.
{
  const parts = [rejection(1011, '2026-10-01T02:30:00.000Z')];
  const rows = run(parts, []);
  assert.strictEqual(findMonth(rows, '2026-09').denominator, 1);
  assert.strictEqual(findMonth(rows, '2026-10'), undefined);
}

// Reference shape from the audit: October 17/49 = 34.7%, September 88/209 = 42.1%.
{
  const oct = referenceCohort(20000, '2026-10-05T15:00:00.000Z', 32, 17, 2, 0);
  const sep = referenceCohort(30000, '2026-09-05T15:00:00.000Z', 121, 88, 1, 5);
  const rows = run(oct.parts.concat(sep.parts), oct.surveys.concat(sep.surveys));
  const octRow = findMonth(rows, '2026-10');
  const sepRow = findMonth(rows, '2026-09');
  assert.deepStrictEqual(
    { n: octRow.numerator, d: octRow.denominator, rate: octRow.rate },
    { n: 17, d: 49, rate: 34.7 },
  );
  assert.deepStrictEqual(
    { n: sepRow.numerator, d: sepRow.denominator, rate: sepRow.rate },
    { n: 88, d: 209, rate: 42.1 },
  );
  assert.strictEqual(
    (34.7).toLocaleString('es-UY', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %',
    '34,7 %',
  );
  assert.strictEqual(
    (42.1).toLocaleString('es-UY', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %',
    '42,1 %',
  );
}

const dashboard = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'mie-dashboard.js'),
  'utf8',
);
assert.ok(dashboard.includes("renderKpiCard(String(count), '📋 Encuestas del mes', 'neutral')"));
assert.ok(dashboard.includes("'⭐ Score promedio'"));
assert.ok(dashboard.includes("'⭐ Score promedio V2 (0–27)'"));
assert.ok(dashboard.includes('Conversión de encuestas · '));
assert.ok(dashboard.includes('renderCalidad(encRow, conversionRow)'));
assert.ok(dashboard.includes('data.surveyConversionByMonth'));
assert.ok(!dashboard.includes('resolveLastRejectionByCi'));

const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reports.js'), 'utf8');
const summaryStart = route.indexOf("router.get('/cz-funnel-summary'");
const summaryEnd = route.indexOf("router.get('/cz-funnel-channel-utility'");
const summary = route.slice(summaryStart, summaryEnd);
assert.ok(summary.includes('surveyConversionByRejectionMonth'));
assert.ok(summary.includes('surveyConversionByMonth'));
assert.ok(!summary.includes('resolveLastRejectionByCi'));

const lib = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lib', 'czSurveyConversion.js'),
  'utf8',
);
assert.ok(!lib.includes('resolveLastRejectionByCi'));

console.log('unit-cz-survey-conversion: ok');
