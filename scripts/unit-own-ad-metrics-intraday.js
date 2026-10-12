'use strict';

/**
 * node scripts/unit-own-ad-metrics-intraday.js
 * Does not call Meta, Supabase, or Railway.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
    metaMarketingApiToken: 'test-token',
    metaAdAccountId: 'act_1327861319208450',
    metaMarketingApiVersion: 'v25.0',
    metaAgenteEnabled: false,
  },
};

const upserts = [];
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: function (table) {
      return {
        upsert: async function (rows, options) {
          upserts.push({ table: table, rows: rows, options: options });
          return { error: null };
        },
      };
    },
  },
};

const metrics = require('../src/steps/collectOwnMetrics');

const tests = [];
function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

test('Montevideo range stays on the account day after UTC midnight', function () {
  const lateUtc = new Date('2026-10-13T01:30:00Z');
  const range = metrics.resolveMontevideoReportingRange(lateUtc);
  assert.strictEqual(metrics.calendarDateInZone('America/Montevideo', lateUtc), '2026-10-12');
  assert.deepStrictEqual(range, { since: '2026-10-11', until: '2026-10-12' });
});

test('Montevideo range rolls forward at 00:30 Uruguay', function () {
  const afterMidnight = new Date('2026-10-13T03:30:00Z');
  const range = metrics.resolveMontevideoReportingRange(afterMidnight);
  assert.strictEqual(
    metrics.calendarDateInZone('America/Montevideo', afterMidnight),
    '2026-10-13',
  );
  assert.deepStrictEqual(range, { since: '2026-10-12', until: '2026-10-13' });
});

test('insights URL splits yesterday and today with time_increment=1', function () {
  const url = metrics.buildInsightsUrl({
    version: 'v25.0',
    adAccountId: 'act_1327861319208450',
    reportingRange: { since: '2026-10-11', until: '2026-10-12' },
  });
  const parsed = new URL(url);
  assert.strictEqual(parsed.searchParams.get('level'), 'campaign');
  assert.strictEqual(parsed.searchParams.get('time_increment'), '1');
  assert.strictEqual(
    parsed.searchParams.get('time_range'),
    JSON.stringify({ since: '2026-10-11', until: '2026-10-12' }),
  );
  assert.ok(!parsed.searchParams.get('filtering'));
  assert.ok(parsed.searchParams.get('fields').includes('actions'));
  assert.ok(parsed.searchParams.get('fields').includes('conversions'));
});

test('CPL counts only form_step_3 and keeps the other events in raw_json', function () {
  const mapped = metrics.mapRowToMetric({
    row: {
      campaign_id: '120252694284250508',
      campaign_name: 'Paso 3',
      date_start: '2026-10-12',
      spend: '9.11',
      impressions: '2296',
      clicks: '229',
      frequency: '1.2',
      actions: [
        { action_type: 'link_click', value: '135' },
        { action_type: 'offsite_conversion.fb_pixel_custom', value: '45' },
        { action_type: 'landing_page_view', value: '116' },
        { action_type: 'lead', value: '3' },
        { action_type: 'custom_event_actions_add_20_s_calls', value: '45' },
      ],
      conversions: [
        { action_type: 'offsite_conversion.fb_pixel_custom.form_step_1', value: '80' },
        { action_type: 'offsite_conversion.fb_pixel_custom.form_step_3', value: '45' },
      ],
      action_values: [{ action_type: 'lead', value: '12.5' }],
      conversion_values: [
        { action_type: 'offsite_conversion.fb_pixel_custom.form_step_3', value: '9' },
      ],
    },
    entityId: 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df',
    runId: '11111111-1111-1111-1111-111111111111',
  });
  assert.strictEqual(mapped.actions, 45);
  assert.strictEqual(mapped.actions_value, 9);
  assert.strictEqual(mapped.clicks, 229);
  assert.strictEqual(mapped.raw_json.actions.length, 5);
  assert.strictEqual(mapped.raw_json.conversions.length, 2);
  assert.strictEqual(
    metrics.META_CPL_ACTION_TYPE,
    'offsite_conversion.fb_pixel_custom.form_step_3',
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(mapped, 'id'));
});

test('aggregate custom pixel, lead, clicks and PageView are not Application Success', function () {
  const row = {
    campaign_id: '1',
    date_start: '2026-10-12',
    spend: '9.11',
    clicks: '10',
    actions: [
      { action_type: 'link_click', value: '135' },
      { action_type: 'offsite_conversion.fb_pixel_custom', value: '45' },
      { action_type: 'landing_page_view', value: '116' },
      { action_type: 'lead', value: '3' },
      { action_type: 'custom_event_actions_add_20_s_calls', value: '45' },
      { action_type: 'offsite_conversion.fb_pixel_custom.PageView', value: '200' },
    ],
    conversions: [
      { action_type: 'offsite_conversion.fb_pixel_custom.form_step_1', value: '15' },
      { action_type: 'offsite_conversion.fb_pixel_custom.application_no', value: '12' },
    ],
  };
  const mapped = metrics.mapRowToMetric({
    row: row,
    entityId: 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df',
    runId: '11111111-1111-1111-1111-111111111111',
  });
  assert.strictEqual(mapped.actions, null);
  assert.strictEqual(metrics.metaApplicationSuccessCount(row), null);
});

test('conversions win over a duplicate form_step_3 row in actions', function () {
  const count = metrics.metaApplicationSuccessCount({
    conversions: [
      { action_type: 'offsite_conversion.fb_pixel_custom.form_step_3', value: '45' },
    ],
    actions: [
      { action_type: 'offsite_conversion.fb_pixel_custom.form_step_3', value: '45' },
      { action_type: 'offsite_conversion.fb_pixel_custom', value: '45' },
    ],
  });
  assert.strictEqual(count, 45);
});

test('two writes of the same campaign and date collapse to one upsert key', function () {
  const entityId = 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df';
  const first = metrics.mapRowToMetric({
    row: {
      campaign_id: '99',
      date_start: '2026-10-12',
      spend: '1',
      impressions: '10',
      clicks: '1',
    },
    entityId: entityId,
    runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  const second = metrics.mapRowToMetric({
    row: {
      campaign_id: '99',
      date_start: '2026-10-12',
      spend: '4',
      impressions: '40',
      clicks: '4',
    },
    entityId: entityId,
    runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  const yesterday = metrics.mapRowToMetric({
    row: {
      campaign_id: '99',
      date_start: '2026-10-11',
      spend: '2',
      impressions: '20',
      clicks: '2',
    },
    entityId: entityId,
    runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });

  const collapsed = metrics.collapseMetricRows([first, second, yesterday]);
  assert.strictEqual(collapsed.length, 2);
  const today = collapsed.find(function (row) {
    return row.metric_date === '2026-10-12';
  });
  assert.strictEqual(today.spend, 4);
  assert.strictEqual(today.run_id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

  const store = new Map();
  function apply(rows) {
    for (const row of rows) {
      const key = [row.entity_id, row.campaign_id, row.metric_date].join('|');
      store.set(key, row);
    }
  }

  apply([first]);
  apply(collapsed.filter(function (row) {
    return row.metric_date === '2026-10-12' || row.metric_date === '2026-10-11';
  }));
  assert.strictEqual(store.size, 2);
  assert.strictEqual(store.get(entityId + '|99|2026-10-12').spend, 4);
  assert.strictEqual(store.get(entityId + '|99|2026-10-11').spend, 2);
  assert.notStrictEqual(first.metric_date, yesterday.metric_date);
});

test('upsert uses the natural key and a second call replaces the same row', async function () {
  const entityId = 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df';
  const first = metrics.mapRowToMetric({
    row: { campaign_id: '99', date_start: '2026-10-12', spend: '1', clicks: '1' },
    entityId: entityId,
    runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  const second = metrics.mapRowToMetric({
    row: { campaign_id: '99', date_start: '2026-10-12', spend: '4', clicks: '4' },
    entityId: entityId,
    runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  upserts.length = 0;
  await metrics.upsertMetrics([first]);
  await metrics.upsertMetrics([second]);
  assert.strictEqual(upserts.length, 2);
  assert.strictEqual(upserts[0].options.onConflict, metrics.UPSERT_CONFLICT);
  assert.strictEqual(upserts[1].options.onConflict, metrics.UPSERT_CONFLICT);
  const store = new Map();
  for (const call of upserts) {
    for (const row of call.rows) {
      store.set([row.entity_id, row.campaign_id, row.metric_date].join('|'), row);
    }
  }
  assert.strictEqual(store.size, 1);
  assert.strictEqual(store.get(entityId + '|99|2026-10-12').spend, 4);
  assert.strictEqual(store.get(entityId + '|99|2026-10-12').run_id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
});

test('migration deletes only the two Make runs and adds the natural unique key', function () {
  const sql = fs.readFileSync(
    path.join(__dirname, '../migrations/20261012_own_ad_metrics_dedupe_unique.sql'),
    'utf8',
  );
  assert.ok(sql.includes('BEGIN;'));
  assert.ok(sql.includes('COMMIT;'));
  assert.ok(sql.includes('DELETE FROM public.own_ad_metrics'));
  assert.ok(sql.includes('d4a56399-e005-42e3-885a-c2ee033e9437'));
  assert.ok(sql.includes('6a2a0188-2f3a-43ef-914c-7140eb327b5c'));
  assert.ok(!/DELETE\s+FROM\s+public\.own_ad_metric_runs/i.test(sql));
  assert.ok(
    /UNIQUE\s*\(\s*entity_id\s*,\s*campaign_id\s*,\s*metric_date\s*\)/i.test(sql),
  );
  assert.strictEqual((sql.match(/DELETE\s+FROM/gi) || []).length, 1);
});

test('dashboard keeps performance open, marks the current day, and collapses liquidity', function () {
  const js = fs.readFileSync(
    path.join(__dirname, '../public/meta-agent.js'),
    'utf8',
  );
  assert.ok(
    js.includes(
      "var META_CPL_ACTION_TYPE = 'offsite_conversion.fb_pixel_custom.form_step_3'",
    ),
  );
  assert.ok(!js.includes("var META_LEAD_ACTION_TYPE = 'lead'"));
  assert.ok(js.includes('día en curso'));
  assert.ok(js.includes('partialDay'));
  assert.ok(js.includes("label: 'CPL META'"));
  assert.ok(js.includes('Sin datos'));
  assert.ok(js.includes('liquidityListOpen: false'));
  assert.ok(js.includes('toggle-liquidity'));
  assert.ok(js.includes('ma-kpi-section-performance'));
  assert.ok(!js.includes('toggle-performance'));
  assert.ok(js.includes('data-ma-action="toggle-liquidity"'));
});

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
  console.log('all own-ad intraday checks passed');
})();
