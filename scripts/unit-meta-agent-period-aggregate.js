'use strict';

/**
 * node scripts/unit-meta-agent-period-aggregate.js
 * Period aggregation + CPL + campaign_id grouping for Meta Ads agent (Fase 1).
 */

const assert = require('assert');
const path = require('path');

const ui = require('../public/meta-agent.js');

function legacyRow(opts) {
  return ui.mapOwnAdMetricsToLegacyRow({
    campaign_id: opts.campaign_id,
    campaign_name: opts.campaign_name,
    metric_date: opts.metric_date,
    spend: opts.spend,
    impressions: opts.impressions,
    clicks: opts.clicks,
    frequency: opts.frequency || 1,
    created_at: opts.created_at || '2026-10-01T12:00:00.000Z',
    raw_json: opts.raw_json || {
      conversions: [
        {
          action_type: 'offsite_conversion.fb_pixel_custom.form_step_3',
          value: String(opts.leads != null ? opts.leads : 0),
        },
      ],
    },
  });
}

function test(name, fn) {
  return { name: name, fn: fn };
}

/** Noon in America/Montevideo (UTCÔêÆ3) ÔåÆ 15:00 UTC, stable for date-only presets. */
function uyNoonUtc(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d, 15, 0, 0));
}

const tests = [
  test('mapOwnAdMetricsToLegacyRow does not throw when clicks > 0 (spendNum CPC)', function () {
    const row = legacyRow({
      campaign_id: '111',
      campaign_name: 'Test',
      metric_date: '2026-10-10',
      spend: 10,
      impressions: 100,
      clicks: 5,
      leads: 2,
    });
    assert.strictEqual(row.campaign_id, '111');
    assert.ok(row.cpc !== '');
    const cpc = parseFloat(row.cpc);
    assert.ok(Number.isFinite(cpc));
    assert.strictEqual(cpc, 2);
  }),

  test('buildCampListByCampaignId groups by campaign_id not name', function () {
    const rows = [
      legacyRow({
        campaign_id: '999',
        campaign_name: 'Name A',
        metric_date: '2026-10-01',
        spend: 5,
        impressions: 100,
        clicks: 10,
        leads: 1,
      }),
      legacyRow({
        campaign_id: '999',
        campaign_name: 'Name B typo',
        metric_date: '2026-10-02',
        spend: 7,
        impressions: 100,
        clicks: 10,
        leads: 2,
      }),
    ];
    const list = ui.buildCampListByCampaignId(rows);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].campaign_id, '999');
    assert.strictEqual(list[0].gasto, 12);
    assert.strictEqual(list[0].conversiones, 3);
    assert.strictEqual(list[0].cpl, 4);
  }),

  test('aggregateAccountPeriod sums and recomputes CTR/CPC/CPM/CPL', function () {
    const rows = [
      legacyRow({
        campaign_id: '1',
        campaign_name: 'C1',
        metric_date: '2026-10-01',
        spend: 10,
        impressions: 1000,
        clicks: 100,
        leads: 5,
      }),
      legacyRow({
        campaign_id: '2',
        campaign_name: 'C2',
        metric_date: '2026-10-02',
        spend: 20,
        impressions: 2000,
        clicks: 50,
        leads: 5,
      }),
    ];
    const agg = ui.aggregateAccountPeriod(rows);
    assert.strictEqual(agg.spend, 30);
    assert.strictEqual(agg.clicks, 150);
    assert.strictEqual(agg.impressions, 3000);
    assert.strictEqual(agg.leads, 10);
    assert.strictEqual(agg.ctr, 5);
    assert.strictEqual(agg.cpc, 0.2);
    assert.strictEqual(agg.cpm, 10);
    assert.strictEqual(agg.cpl, 3);
  }),

  test('CPL is null when no form_step_3 conversions', function () {
    const row = ui.mapOwnAdMetricsToLegacyRow({
      campaign_id: '1',
      campaign_name: 'C',
      metric_date: '2026-10-01',
      spend: 50,
      impressions: 100,
      clicks: 10,
      raw_json: { conversions: [] },
    });
    const list = ui.buildCampListByCampaignId([row]);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].cpl, null);
    assert.strictEqual(list[0].cplSinConversiones, true);
    const agg = ui.aggregateAccountPeriod([row]);
    assert.strictEqual(agg.cpl, null);
    assert.strictEqual(agg.leads, null);
  }),

  test('filterRowsByMetricDate and coverage detect missing sync days', function () {
    const rows = [
      legacyRow({
        campaign_id: '1',
        campaign_name: 'C',
        metric_date: '2026-10-01',
        spend: 1,
        impressions: 10,
        clicks: 1,
        leads: 0,
      }),
      legacyRow({
        campaign_id: '1',
        campaign_name: 'C',
        metric_date: '2026-10-03',
        spend: 1,
        impressions: 10,
        clicks: 1,
        leads: 0,
      }),
    ];
    const range = { from: '2026-10-01', to: '2026-10-03' };
    const filtered = ui.filterRowsByMetricDate(rows, range.from, range.to);
    assert.strictEqual(filtered.length, 2);
    const cov = ui.computeCoverage(filtered, range, rows);
    assert.strictEqual(cov.expectedDayCount, 3);
    assert.strictEqual(cov.presentDayCount, 2);
    assert.strictEqual(cov.missingDayCount, 1);
  }),

  test('resolvePeriodRange today uses Montevideo calendar date', function () {
    const now = uyNoonUtc(2026, 10, 15);
    const r = ui.resolvePeriodRange('today', '', '', now);
    assert.strictEqual(r.from, '2026-10-15');
    assert.strictEqual(r.to, '2026-10-15');
    assert.strictEqual(r.preset, 'today');
  }),

  test('resolvePeriodRange yesterday crosses single day in UY', function () {
    const now = uyNoonUtc(2026, 10, 15);
    const r = ui.resolvePeriodRange('yesterday', '', '', now);
    assert.strictEqual(r.from, '2026-10-14');
    assert.strictEqual(r.to, '2026-10-14');
  }),

  test('resolvePeriodRange 30d is 30 inclusive days ending today (UY)', function () {
    const now = uyNoonUtc(2026, 10, 15);
    const r = ui.resolvePeriodRange('30d', '', '', now);
    assert.strictEqual(r.from, '2026-09-16');
    assert.strictEqual(r.to, '2026-10-15');
    assert.strictEqual(r.preset, '30d');
  }),

  test('resolvePeriodRange 30d and yesterday at year boundary (UY)', function () {
    const now = uyNoonUtc(2026, 1, 1);
    const r30 = ui.resolvePeriodRange('30d', '', '', now);
    assert.strictEqual(r30.to, '2026-01-01');
    assert.strictEqual(r30.from, '2025-12-03');
    const ry = ui.resolvePeriodRange('yesterday', '', '', now);
    assert.strictEqual(ry.from, '2025-12-31');
    assert.strictEqual(ry.to, '2025-12-31');
  }),

  test('resolvePeriodRange invalid custom falls back to 7d (UY)', function () {
    const now = uyNoonUtc(2026, 3, 10);
    const r = ui.resolvePeriodRange('custom', 'not-a-date', '2026-03-10', now);
    assert.strictEqual(r.preset, '7d');
    assert.strictEqual(r.to, '2026-03-10');
    assert.strictEqual(r.from, '2026-03-04');
  }),

  test('lookbackStartDateIso uses Montevideo and crosses month/year', function () {
    assert.strictEqual(ui.METRIC_LOOKBACK_DAYS, 30);
    const jan1 = uyNoonUtc(2026, 1, 1);
    assert.strictEqual(ui.lookbackStartDateIso(jan1), '2025-12-02');
    const mar1 = uyNoonUtc(2026, 3, 1);
    assert.strictEqual(ui.lookbackStartDateIso(mar1), '2026-01-30');
  }),

  test('computeDerivedForState period with spend and zero conversions', function () {
    const rows = [
      legacyRow({
        campaign_id: '1',
        campaign_name: 'C',
        metric_date: '2026-10-10',
        spend: 40,
        impressions: 100,
        clicks: 10,
        leads: 0,
      }),
      legacyRow({
        campaign_id: '1',
        campaign_name: 'C',
        metric_date: '2026-10-11',
        spend: 10,
        impressions: 100,
        clicks: 10,
        leads: 0,
      }),
    ];
    const derived = ui.computeDerivedForState(rows, 'custom', '2026-10-10', '2026-10-11');
    assert.strictEqual(derived.period.spend, 50);
    assert.strictEqual(derived.period.leads, 0);
    assert.strictEqual(derived.period.cpl, null);
    assert.strictEqual(derived.campList.length, 1);
    assert.strictEqual(derived.campList[0].cplSinConversiones, true);
  }),

  test('computeLatestDateStats uses metaLeadsFromRow (form_step_3 via raw_json)', function () {
    const row = ui.mapOwnAdMetricsToLegacyRow({
      campaign_id: '1',
      campaign_name: 'C',
      metric_date: '2026-10-12',
      spend: 10,
      impressions: 100,
      clicks: 5,
      raw_json: {
        conversions: [
          {
            action_type: 'offsite_conversion.fb_pixel_custom.form_step_3',
            value: '3',
          },
        ],
      },
    });
    row.meta_leads = '';
    const stats = ui.computeLatestDateStats([row]);
    assert.strictEqual(stats.leads, 3);
  }),

  test('dedupeRowsByCampaignDate keeps newest created_at', function () {
    const older = legacyRow({
      campaign_id: '1',
      campaign_name: 'C',
      metric_date: '2026-10-05',
      spend: 1,
      impressions: 10,
      clicks: 1,
      leads: 1,
      created_at: '2026-10-05T08:00:00.000Z',
    });
    const newer = legacyRow({
      campaign_id: '1',
      campaign_name: 'C',
      metric_date: '2026-10-05',
      spend: 9,
      impressions: 10,
      clicks: 1,
      leads: 2,
      created_at: '2026-10-05T18:00:00.000Z',
    });
    const out = ui.dedupeRowsByCampaignDate([older, newer]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(parseFloat(out[0].spend), 9);
  }),
];

(async function main() {
  for (const item of tests) {
    try {
      await item.fn();
      console.log('ok ' + item.name);
    } catch (err) {
      console.error('FAIL ' + item.name);
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log('all meta-agent period aggregate checks passed');
})();
