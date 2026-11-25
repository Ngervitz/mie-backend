'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  miPlanInterestConversion,
  MIPLAN_WAITLIST_CTA_LAUNCH_MS,
  monthAvailable,
} = require('../src/lib/czMiplanInterestConversion');

function monthKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
  return ymd && ymd.length >= 7 ? ymd.slice(0, 7) : null;
}

// Month before launch: N/D semantics (not 0%); pre-launch encuestas excluded from overall.
{
  assert.strictEqual(monthAvailable('2026-09'), false);
  assert.strictEqual(monthAvailable('2026-10'), true);
  const enc = [
    {
      ci: 1001,
      tipo: 'prestamo-rechazado',
      completed_at: '2026-09-30T20:00:00.000Z',
    },
  ];
  const out = miPlanInterestConversion(
    { encuestaRows: enc, outreachRows: [] },
    { monthKey, nowMs: Date.parse('2026-11-25T12:00:00.000Z'), currentMonthKey: '2026-11' },
  );
  assert.strictEqual(out.miPlanInterestConversionByMonth.length, 0);
  assert.strictEqual(out.miPlanInterestConversionOverall.denominator, 0);
}

// Wrong tipo / source excluded; encuesta before launch excluded.
{
  const enc = [
    { ci: 2001, tipo: 'prestamo-otorgado', completed_at: '2026-11-01T12:00:00.000Z' },
    {
      ci: 2002,
      tipo: 'prestamo-rechazado',
      completed_at: '2026-10-10T12:00:00.000Z',
    },
    {
      ci: 2002,
      tipo: 'prestamo-rechazado',
      completed_at: '2026-10-12T12:00:00.000Z',
    },
  ];
  const outreach = [
    {
      ci: 2002,
      mi_plan_interest_at: '2026-10-15T12:00:00.000Z',
      mi_plan_interest_source: 'credizona_rejected_thank_you',
    },
    {
      ci: 2003,
      mi_plan_interest_at: '2026-10-15T12:00:00.000Z',
      mi_plan_interest_source: 'evil',
    },
  ];
  const out = miPlanInterestConversion(
    { encuestaRows: enc, outreachRows: outreach },
    { monthKey, nowMs: Date.parse('2026-10-31T18:00:00.000Z'), currentMonthKey: '2026-10' },
  );
  const oct = out.miPlanInterestConversionByMonth.find((r) => r.month === '2026-10');
  assert.strictEqual(oct.denominator, 1);
  assert.strictEqual(oct.numerator, 1);
  assert.strictEqual(oct.rate, 100);
  assert.strictEqual(out.miPlanInterestConversionOverall.denominator, 1);
  assert.ok(MIPLAN_WAITLIST_CTA_LAUNCH_MS < Date.parse('2026-10-06T12:00:00.000Z'));
}

// Interest after month cut-off does not count for that month cohort.
{
  const enc = [
    {
      ci: 3001,
      tipo: 'prestamo-rechazado',
      completed_at: '2026-10-15T12:00:00.000Z',
    },
  ];
  const outreach = [
    {
      ci: 3001,
      mi_plan_interest_at: '2026-11-05T12:00:00.000Z',
      mi_plan_interest_source: 'credizona_rejected_thank_you',
    },
  ];
  const out = miPlanInterestConversion(
    { encuestaRows: enc, outreachRows: outreach },
    { monthKey, nowMs: Date.parse('2026-11-25T12:00:00.000Z'), currentMonthKey: '2026-11' },
  );
  const oct = out.miPlanInterestConversionByMonth.find((r) => r.month === '2026-10');
  assert.strictEqual(oct.denominator, 1);
  assert.strictEqual(oct.numerator, 0);
}

const route = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'reports.js'),
  'utf8',
);
const summary = route.slice(
  route.indexOf("router.get('/cz-funnel-summary'"),
  route.indexOf("router.get('/cz-funnel-channel-utility'"),
);
assert.ok(summary.includes('miPlanInterestConversion'));

const dashboard = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'mie-dashboard.js'),
  'utf8',
);
assert.ok(dashboard.includes('renderMiPlanInterestCard'));
assert.ok(dashboard.includes('miPlanInterestConversionByMonth'));
assert.ok(dashboard.includes('miPlanInterestConversionOverall'));
assert.ok(dashboard.includes('Acum. desde 06/10/2026'));

console.log('unit-cz-miplan-interest-conversion: ok');