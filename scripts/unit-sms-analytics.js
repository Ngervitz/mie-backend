'use strict';

/**
 * node scripts/unit-sms-analytics.js
 *
 * Unit tests for SMS Performance Analytics:
 * 1. Ratio calculation and null vs 0 semantics
 * 2. Montevideo cohort month resolution and boundary testing
 * 3. GET /sms/analytics/performance router endpoint (valid response, error handling, invalid series_id)
 * 4. Distinct granularity engine replica test (proves distinct cz_id rollup across campaigns)
 * 5. Deduplication invariants and ratios
 */

const assert = require('assert');
const { formatYmdMontevideo } = require('../src/lib/montevideo-week');

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
    sessionSecret: 'test-secret',
    apifyToken: 'test-apify',
  },
};

const supabaseClient = require('../src/clients/supabase');

function installSupabase(mock) {
  Object.keys(supabaseClient).forEach(function (k) {
    delete supabaseClient[k];
  });
  Object.assign(supabaseClient, mock);
}

const smsRouter = require('../src/routes/sms');

/**
 * Pure-JS functional replica of the SQL CTEs in get_sms_performance_analytics
 * Exercising actual distinct logic across granularities on raw simulated tables.
 */
function simulateSqlPerformanceAnalytics({ smsMessages, smsCampaigns, marketingImpacts, marketingImpactEvents, czSolicitudes }) {
  // 1. base_sms
  const baseSms = smsMessages.map((m) => {
    const c = smsCampaigns.find((camp) => camp.id === m.campaign_id) || {};
    const i = marketingImpacts.find((imp) => imp.id === m.marketing_impact_id) || null;
    const dateObj = new Date(m.created_at);
    const cohort_month = formatYmdMontevideo(dateObj).slice(0, 7);
    return {
      unique_id: m.unique_id,
      campaign_id: m.campaign_id,
      campaign_name: c.name || null,
      campaign_series_id: c.campaign_series_id || null,
      message_status: m.status,
      sms_created_at: m.created_at,
      cohort_month,
      marketing_impact_id: m.marketing_impact_id,
      tracking_token: i ? i.tracking_token : null,
    };
  });

  // 2. sms_events (group by impact_id)
  const eventsByImpact = {};
  for (const ev of marketingImpactEvents) {
    if (!eventsByImpact[ev.impact_id]) {
      eventsByImpact[ev.impact_id] = { has_click: false, has_step_1: false, has_step_2: false, has_step_3: false };
    }
    if (ev.event_name === 'click') eventsByImpact[ev.impact_id].has_click = true;
    if (ev.event_name === 'form_step_1') eventsByImpact[ev.impact_id].has_step_1 = true;
    if (ev.event_name === 'form_step_2') eventsByImpact[ev.impact_id].has_step_2 = true;
    if (ev.event_name === 'form_step_3') eventsByImpact[ev.impact_id].has_step_3 = true;
  }

  // 3. solicitudes_per_impact
  const solCountByToken = {};
  for (const sol of czSolicitudes) {
    const jt = sol.tracking_data_summary && sol.tracking_data_summary.jt;
    if (jt) {
      if (!solCountByToken[jt]) solCountByToken[jt] = new Set();
      solCountByToken[jt].add(sol.cz_id);
    }
  }

  // 4. solicitudes_campaign: Map<"campaign_id:cohort_month", Set<cz_id>>
  const solCampaignMap = {};
  for (const b of baseSms) {
    if (b.tracking_token && solCountByToken[b.tracking_token]) {
      const key = `${b.campaign_id}:${b.cohort_month}`;
      if (!solCampaignMap[key]) solCampaignMap[key] = new Set();
      for (const cz_id of solCountByToken[b.tracking_token]) {
        solCampaignMap[key].add(cz_id);
      }
    }
  }

  // 5. solicitudes_month: Map<cohort_month, Set<cz_id>>
  const solMonthMap = {};
  for (const b of baseSms) {
    if (b.tracking_token && solCountByToken[b.tracking_token]) {
      const key = b.cohort_month;
      if (!solMonthMap[key]) solMonthMap[key] = new Set();
      for (const cz_id of solCountByToken[b.tracking_token]) {
        solMonthMap[key].add(cz_id);
      }
    }
  }

  // 6. solicitudes_overall: Set<cz_id>
  const solOverallSet = new Set();
  for (const b of baseSms) {
    if (b.tracking_token && solCountByToken[b.tracking_token]) {
      for (const cz_id of solCountByToken[b.tracking_token]) {
        solOverallSet.add(cz_id);
      }
    }
  }

  // Build Campaign Level Rows (using Sets to simulate COUNT(DISTINCT b.marketing_impact_id) FILTER (...))
  const campGroups = {};
  for (const b of baseSms) {
    const key = `${b.campaign_id}:${b.cohort_month}`;
    if (!campGroups[key]) {
      campGroups[key] = {
        aggregation_level: 'campaign',
        campaign_id: b.campaign_id,
        campaign_name: b.campaign_name,
        campaign_series_id: b.campaign_series_id,
        campaign_series_name: null,
        cohort_month: b.cohort_month,
        messages_sent: 0,
        messages_delivered: 0,
        _impacts: new Set(),
        _clicks: new Set(),
        _step1: new Set(),
        _step2: new Set(),
        _step3: new Set(),
        _impactsWithSol: new Set(),
        total_solicitudes: (solCampaignMap[key] && solCampaignMap[key].size) || 0,
        first_sms_at: b.sms_created_at,
        last_sms_at: b.sms_created_at,
      };
    }
    const g = campGroups[key];
    g.messages_sent += 1;
    if (String(b.message_status).toLowerCase() === 'delivered') g.messages_delivered += 1;
    if (b.marketing_impact_id) {
      g._impacts.add(b.marketing_impact_id);
      const ev = eventsByImpact[b.marketing_impact_id];
      if (ev && ev.has_click) g._clicks.add(b.marketing_impact_id);
      if (ev && ev.has_step_1) g._step1.add(b.marketing_impact_id);
      if (ev && ev.has_step_2) g._step2.add(b.marketing_impact_id);
      if (ev && ev.has_step_3) g._step3.add(b.marketing_impact_id);
      if (b.tracking_token && solCountByToken[b.tracking_token] && solCountByToken[b.tracking_token].size > 0) {
        g._impactsWithSol.add(b.marketing_impact_id);
      }
    }
  }

  // Build Month Level Rows
  const monthGroups = {};
  for (const b of baseSms) {
    const key = b.cohort_month;
    if (!monthGroups[key]) {
      monthGroups[key] = {
        aggregation_level: 'month',
        campaign_id: null,
        campaign_name: null,
        campaign_series_id: null,
        campaign_series_name: null,
        cohort_month: key,
        messages_sent: 0,
        messages_delivered: 0,
        _impacts: new Set(),
        _clicks: new Set(),
        _step1: new Set(),
        _step2: new Set(),
        _step3: new Set(),
        _impactsWithSol: new Set(),
        total_solicitudes: (solMonthMap[key] && solMonthMap[key].size) || 0,
        first_sms_at: b.sms_created_at,
        last_sms_at: b.sms_created_at,
      };
    }
    const g = monthGroups[key];
    g.messages_sent += 1;
    if (String(b.message_status).toLowerCase() === 'delivered') g.messages_delivered += 1;
    if (b.marketing_impact_id) {
      g._impacts.add(b.marketing_impact_id);
      const ev = eventsByImpact[b.marketing_impact_id];
      if (ev && ev.has_click) g._clicks.add(b.marketing_impact_id);
      if (ev && ev.has_step_1) g._step1.add(b.marketing_impact_id);
      if (ev && ev.has_step_2) g._step2.add(b.marketing_impact_id);
      if (ev && ev.has_step_3) g._step3.add(b.marketing_impact_id);
      if (b.tracking_token && solCountByToken[b.tracking_token] && solCountByToken[b.tracking_token].size > 0) {
        g._impactsWithSol.add(b.marketing_impact_id);
      }
    }
  }

  // Build Overall Level Row
  const overall = {
    aggregation_level: 'overall',
    campaign_id: null,
    campaign_name: null,
    campaign_series_id: null,
    campaign_series_name: null,
    cohort_month: null,
    messages_sent: 0,
    messages_delivered: 0,
    _impacts: new Set(),
    _clicks: new Set(),
    _step1: new Set(),
    _step2: new Set(),
    _step3: new Set(),
    _impactsWithSol: new Set(),
    total_solicitudes: solOverallSet.size,
    first_sms_at: baseSms[0] ? baseSms[0].sms_created_at : null,
    last_sms_at: baseSms[0] ? baseSms[0].sms_created_at : null,
  };
  for (const b of baseSms) {
    overall.messages_sent += 1;
    if (String(b.message_status).toLowerCase() === 'delivered') overall.messages_delivered += 1;
    if (b.marketing_impact_id) {
      overall._impacts.add(b.marketing_impact_id);
      const ev = eventsByImpact[b.marketing_impact_id];
      if (ev && ev.has_click) overall._clicks.add(b.marketing_impact_id);
      if (ev && ev.has_step_1) overall._step1.add(b.marketing_impact_id);
      if (ev && ev.has_step_2) overall._step2.add(b.marketing_impact_id);
      if (ev && ev.has_step_3) overall._step3.add(b.marketing_impact_id);
      if (b.tracking_token && solCountByToken[b.tracking_token] && solCountByToken[b.tracking_token].size > 0) {
        overall._impactsWithSol.add(b.marketing_impact_id);
      }
    }
  }

  function finalizeRow(r) {
    return {
      ...r,
      total_impacts: r._impacts.size,
      total_clicks: r._clicks.size,
      total_form_step_1: r._step1.size,
      total_form_step_2: r._step2.size,
      total_form_step_3: r._step3.size,
      impacts_with_solicitud: r._impactsWithSol.size,
    };
  }

  return [
    ...Object.values(campGroups).map(finalizeRow),
    ...Object.values(monthGroups).map(finalizeRow),
    finalizeRow(overall),
  ];
}

async function requestAnalyticsPerformance(queryString) {
  return new Promise((resolve) => {
    const query = {};
    if (queryString) {
      const params = new URLSearchParams(queryString);
      for (const [k, v] of params.entries()) {
        query[k] = v;
      }
    }

    const req = {
      query: query,
      headers: {},
      get: function (header) {
        return this.headers[header.toLowerCase()];
      },
    };

    let statusCode = 200;
    const res = {
      status: function (code) {
        statusCode = code;
        return this;
      },
      json: function (payload) {
        resolve({ status: statusCode, body: payload });
      },
    };

    const routeLayer = smsRouter.stack.find(
      (layer) => layer.route && layer.route.path === '/analytics/performance' && layer.route.methods.get,
    );

    if (!routeLayer) {
      throw new Error('GET /analytics/performance route layer not found on smsRouter');
    }

    routeLayer.route.stack[0].handle(req, res, (err) => {
      if (err) {
        resolve({ status: 500, body: { error: err.message } });
      }
    });
  });
}

async function runTests() {
  console.log('--- Starting SMS Performance Analytics Unit Tests ---');

  // -------------------------------------------------------------------------
  // Test 1: Montevideo Cohort Month Boundary Resolution
  // -------------------------------------------------------------------------
  console.log('Test 1: Montevideo Cohort Month Resolution');
  {
    const augEdgeUtc = new Date('2026-09-01T01:30:00.000Z');
    const ymdAug = formatYmdMontevideo(augEdgeUtc);
    assert.strictEqual(ymdAug, '2026-08-31', '01:30 UTC on Sep 1 is Aug 31 in Montevideo');
    assert.strictEqual(ymdAug.slice(0, 7), '2026-08', 'Cohort month must resolve to 2026-08');

    const sepEdgeUtc = new Date('2026-09-01T03:00:00.000Z');
    const ymdSep = formatYmdMontevideo(sepEdgeUtc);
    assert.strictEqual(ymdSep, '2026-09-01', '03:00 UTC on Sep 1 is Sep 1 in Montevideo');
    assert.strictEqual(ymdSep.slice(0, 7), '2026-09', 'Cohort month must resolve to 2026-09');
  }
  console.log('  ✓ Passed Montevideo cohort month boundary test');

  // -------------------------------------------------------------------------
  // Test 2: Invalid series_id UUID returns 400
  // -------------------------------------------------------------------------
  console.log('Test 2: Invalid series_id format validation');
  {
    const res = await requestAnalyticsPerformance('series_id=not-a-valid-uuid');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'campaign_series_id must be a UUID');
  }
  console.log('  ✓ Passed invalid series_id test');

  // -------------------------------------------------------------------------
  // Test 3: Database error returns 500
  // -------------------------------------------------------------------------
  console.log('Test 3: Supabase RPC error handling');
  {
    installSupabase({
      rpc: function (funcName, params) {
        assert.strictEqual(funcName, 'get_sms_performance_analytics');
        return Promise.resolve({ data: null, error: { message: 'Database connection failed' } });
      },
    });

    const res = await requestAnalyticsPerformance('');
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error, 'Failed to load SMS performance analytics');
  }
  console.log('  ✓ Passed error handling test');

  // -------------------------------------------------------------------------
  // Test 4: Full analytics endpoint with canary data & ratios
  // -------------------------------------------------------------------------
  console.log('Test 4: Full analytics endpoint with canary data & ratios');
  {
    const currentMonthKey = formatYmdMontevideo(new Date()).slice(0, 7);

    const mockRpcRows = [
      {
        aggregation_level: 'campaign',
        campaign_id: 'a5651b31-11a7-4814-85d9-db37c3418da2',
        campaign_name: 'Canary SMS 2026-08-28 Tanda 1',
        campaign_series_id: 'fd126de6-202d-4326-bbd8-c3cb10b0ce8e',
        campaign_series_name: 'Canary SMS individual tracking 2026-08-28',
        cohort_month: '2026-08',
        messages_sent: '2',
        messages_delivered: '0',
        total_impacts: '2',
        total_clicks: '1',
        total_form_step_1: '0',
        total_form_step_2: '0',
        total_form_step_3: '0',
        impacts_with_solicitud: '0',
        total_solicitudes: '0',
        first_sms_at: '2026-08-28T18:52:11.349444+00:00',
        last_sms_at: '2026-08-28T18:52:11.349444+00:00',
      },
      {
        aggregation_level: 'campaign',
        campaign_id: 'b024cd01-3cb2-4e54-8e75-3c7f168c2e5b',
        campaign_name: 'Canary SMS 2026-08-28 Tanda 2',
        campaign_series_id: 'fd126de6-202d-4326-bbd8-c3cb10b0ce8e',
        campaign_series_name: 'Canary SMS individual tracking 2026-08-28',
        cohort_month: '2026-08',
        messages_sent: '1',
        messages_delivered: '0',
        total_impacts: '1',
        total_clicks: '1',
        total_form_step_1: '1',
        total_form_step_2: '0',
        total_form_step_3: '0',
        impacts_with_solicitud: '0',
        total_solicitudes: '0',
        first_sms_at: '2026-08-28T19:36:06.101612+00:00',
        last_sms_at: '2026-08-28T19:36:06.101612+00:00',
      },
      {
        aggregation_level: 'campaign',
        campaign_id: 'c3333333-3333-3333-3333-333333333333',
        campaign_name: 'Completed Campaign Example',
        campaign_series_id: null,
        campaign_series_name: null,
        cohort_month: '2026-07',
        messages_sent: '10',
        messages_delivered: '10',
        total_impacts: '10',
        total_clicks: '0',
        total_form_step_1: '0',
        total_form_step_2: '0',
        total_form_step_3: '0',
        impacts_with_solicitud: '0',
        total_solicitudes: '0',
        first_sms_at: '2026-07-15T12:00:00.000Z',
        last_sms_at: '2026-07-15T12:00:00.000Z',
      },
      {
        aggregation_level: 'month',
        cohort_month: '2026-08',
        messages_sent: '3',
        messages_delivered: '0',
        total_impacts: '3',
        total_clicks: '2',
        total_form_step_1: '1',
        total_form_step_2: '0',
        total_form_step_3: '0',
        impacts_with_solicitud: '0',
        total_solicitudes: '0',
      },
      {
        aggregation_level: 'month',
        cohort_month: '2026-07',
        messages_sent: '10',
        messages_delivered: '10',
        total_impacts: '10',
        total_clicks: '0',
        total_form_step_1: '0',
        total_form_step_2: '0',
        total_form_step_3: '0',
        impacts_with_solicitud: '0',
        total_solicitudes: '0',
      },
      {
        aggregation_level: 'overall',
        messages_sent: '13',
        messages_delivered: '10',
        total_impacts: '13',
        total_clicks: '2',
        total_form_step_1: '1',
        total_form_step_2: '0',
        total_form_step_3: '0',
        impacts_with_solicitud: '0',
        total_solicitudes: '0',
      },
    ];

    installSupabase({
      rpc: function (funcName, params) {
        assert.strictEqual(funcName, 'get_sms_performance_analytics');
        return Promise.resolve({ data: mockRpcRows, error: null });
      },
    });

    const res = await requestAnalyticsPerformance('');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);

    const data = res.body.data;
    assert.strictEqual(data.current_cohort_month, currentMonthKey);
    assert(Array.isArray(data.monthly_summary), 'monthly_summary should be an array');
    assert(Array.isArray(data.campaign_breakdown), 'campaign_breakdown should be an array');

    // Check Tanda 1 ratios (delivered=0, clicks=1)
    const tanda1 = data.campaign_breakdown.find((c) => c.campaign_id === 'a5651b31-11a7-4814-85d9-db37c3418da2');
    assert(tanda1, 'Tanda 1 breakdown must exist');
    assert.strictEqual(tanda1.messages_delivered, 0);
    assert.strictEqual(tanda1.total_clicks, 1);
    assert.strictEqual(tanda1.ctr_delivered_pct, null, 'delivered=0 must produce ctr_delivered_pct = null');
    assert.strictEqual(tanda1.step_1_pct, null, 'delivered=0 must produce step_1_pct = null');
    assert.strictEqual(tanda1.step_1_from_click_pct, 0.0, 'step1=0 and clicks=1 must produce step_1_from_click_pct = 0.0');

    // Check Tanda 2 ratios (delivered=0, clicks=1, step1=1, step2=0)
    const tanda2 = data.campaign_breakdown.find((c) => c.campaign_id === 'b024cd01-3cb2-4e54-8e75-3c7f168c2e5b');
    assert(tanda2, 'Tanda 2 breakdown must exist');
    assert.strictEqual(tanda2.total_form_step_1, 1);
    assert.strictEqual(tanda2.total_form_step_2, 0);
    assert.strictEqual(tanda2.step_1_from_click_pct, 100.0, '1 step1 from 1 click = 100.0%');
    assert.strictEqual(tanda2.step_2_from_step_1_pct, 0.0, 'step1=1 and step2=0 must produce step_2_from_step_1_pct = 0.0');
    assert.strictEqual(tanda2.step_3_from_step_2_pct, null, 'step2=0 must produce step_3_from_step_2_pct = null');

    // Check Completed campaign (delivered=10, clicks=0)
    const comp = data.campaign_breakdown.find((c) => c.campaign_id === 'c3333333-3333-3333-3333-333333333333');
    assert(comp, 'Completed campaign breakdown must exist');
    assert.strictEqual(comp.messages_delivered, 10);
    assert.strictEqual(comp.total_clicks, 0);
    assert.strictEqual(comp.ctr_delivered_pct, 0.0, 'delivered=10 and clicks=0 must produce ctr_delivered_pct = 0.0');

    // Check Monthly Summary
    const augEntry = data.monthly_summary.find((m) => m.cohort_month === '2026-08');
    assert(augEntry, '2026-08 monthly summary must exist');
    assert.strictEqual(augEntry.messages_sent, 3);
    assert.strictEqual(augEntry.messages_delivered, 0);
    assert.strictEqual(augEntry.total_clicks, 2);
    assert.strictEqual(augEntry.total_form_step_1, 1);
    assert.strictEqual(augEntry.step_1_from_click_pct, 50.0);
    assert.strictEqual(augEntry.step_2_from_step_1_pct, 0.0);
    assert.strictEqual(augEntry.step_3_from_step_2_pct, null);
  }
  console.log('  ✓ Passed full analytics endpoint & ratio tests');

  // -------------------------------------------------------------------------
  // Test 5: Distinct cz_id Granularity Engine Test (Shared cz_id across 2 campaigns)
  // -------------------------------------------------------------------------
  console.log('Test 5: Distinct cz_id Granularity Engine (Single cz_id=500 in 2 campaigns in same month)');
  {
    const rawData = {
      smsCampaigns: [
        { id: 'camp-A', name: 'Campaign A' },
        { id: 'camp-B', name: 'Campaign B' },
      ],
      marketingImpacts: [
        { id: 'imp-1', tracking_token: 'JT_SHARED_A_B_00000000' },
        { id: 'imp-2', tracking_token: 'JT_SHARED_A_B_00000000' },
      ],
      smsMessages: [
        { unique_id: '101', campaign_id: 'camp-A', marketing_impact_id: 'imp-1', status: 'DELIVERED', created_at: '2026-08-10T15:00:00Z' },
        { unique_id: '102', campaign_id: 'camp-B', marketing_impact_id: 'imp-2', status: 'DELIVERED', created_at: '2026-08-11T15:00:00Z' },
      ],
      marketingImpactEvents: [
        { impact_id: 'imp-1', event_name: 'click' },
        { impact_id: 'imp-2', event_name: 'click' },
      ],
      czSolicitudes: [
        { cz_id: 500, tracking_data_summary: { jt: 'JT_SHARED_A_B_00000000' } },
      ],
    };

    const simulatedRows = simulateSqlPerformanceAnalytics(rawData);

    installSupabase({
      rpc: function () {
        return Promise.resolve({ data: simulatedRows, error: null });
      },
    });

    const res = await requestAnalyticsPerformance('');
    assert.strictEqual(res.status, 200);

    const campA = res.body.data.campaign_breakdown.find((c) => c.campaign_id === 'camp-A');
    const campB = res.body.data.campaign_breakdown.find((c) => c.campaign_id === 'camp-B');
    const month = res.body.data.monthly_summary.find((m) => m.cohort_month === '2026-08');
    const totals = res.body.data.totals;

    assert.strictEqual(campA.total_solicitudes, 1, 'Campaign A has 1 distinct solicitud (cz_id 500)');
    assert.strictEqual(campB.total_solicitudes, 1, 'Campaign B has 1 distinct solicitud (cz_id 500)');
    assert.strictEqual(month.total_solicitudes, 1, 'Monthly rollup must be 1 (DEDUPLICATED cz_id 500), NOT 2');
    assert.strictEqual(totals.total_solicitudes, 1, 'Overall rollup must be 1 (DEDUPLICATED cz_id 500), NOT 2');
  }
  console.log('  ✓ Passed distinct cz_id cross-campaign deduplication test');

  // -------------------------------------------------------------------------
  // Test 6: Distinct cz_id Granularity Engine (Two distinct cz_id: 501 and 502)
  // -------------------------------------------------------------------------
  console.log('Test 6: Distinct cz_id Granularity Engine (Two distinct cz_id: 501 and 502)');
  {
    const rawData = {
      smsCampaigns: [
        { id: 'camp-A', name: 'Campaign A' },
        { id: 'camp-B', name: 'Campaign B' },
      ],
      marketingImpacts: [
        { id: 'imp-1', tracking_token: 'JT_DISTINCT_1_00000000' },
        { id: 'imp-2', tracking_token: 'JT_DISTINCT_2_00000000' },
      ],
      smsMessages: [
        { unique_id: '201', campaign_id: 'camp-A', marketing_impact_id: 'imp-1', status: 'DELIVERED', created_at: '2026-08-10T15:00:00Z' },
        { unique_id: '202', campaign_id: 'camp-B', marketing_impact_id: 'imp-2', status: 'DELIVERED', created_at: '2026-08-11T15:00:00Z' },
      ],
      marketingImpactEvents: [
        { impact_id: 'imp-1', event_name: 'click' },
        { impact_id: 'imp-2', event_name: 'click' },
      ],
      czSolicitudes: [
        { cz_id: 501, tracking_data_summary: { jt: 'JT_DISTINCT_1_00000000' } },
        { cz_id: 502, tracking_data_summary: { jt: 'JT_DISTINCT_2_00000000' } },
      ],
    };

    const simulatedRows = simulateSqlPerformanceAnalytics(rawData);

    installSupabase({
      rpc: function () {
        return Promise.resolve({ data: simulatedRows, error: null });
      },
    });

    const res = await requestAnalyticsPerformance('');
    assert.strictEqual(res.status, 200);

    const campA = res.body.data.campaign_breakdown.find((c) => c.campaign_id === 'camp-A');
    const campB = res.body.data.campaign_breakdown.find((c) => c.campaign_id === 'camp-B');
    const month = res.body.data.monthly_summary.find((m) => m.cohort_month === '2026-08');
    const totals = res.body.data.totals;

    assert.strictEqual(campA.total_solicitudes, 1, 'Campaign A has 1 distinct solicitud (cz_id 501)');
    assert.strictEqual(campB.total_solicitudes, 1, 'Campaign B has 1 distinct solicitud (cz_id 502)');
    assert.strictEqual(month.total_solicitudes, 2, 'Monthly rollup must be 2 distinct solicitudes');
    assert.strictEqual(totals.total_solicitudes, 2, 'Overall rollup must be 2 distinct solicitudes');
  }
  console.log('  ✓ Passed distinct cz_id two-solicitud test');

  // -------------------------------------------------------------------------
  // Test 7: Distinct marketing_impact_id Engine (2 anomalous sms_messages pointing to 1 impact)
  // -------------------------------------------------------------------------
  console.log('Test 7: Distinct marketing_impact_id Engine (2 anomalous sms pointing to same impact with click + step1 + sol)');
  {
    const rawData = {
      smsCampaigns: [
        { id: 'camp-ANOMALY', name: 'Anomaly Campaign' },
      ],
      marketingImpacts: [
        { id: 'imp-SHARED-ANOMALY', tracking_token: 'JT_ANOMALY_00000000000' },
      ],
      smsMessages: [
        { unique_id: '301', campaign_id: 'camp-ANOMALY', marketing_impact_id: 'imp-SHARED-ANOMALY', status: 'DELIVERED', created_at: '2026-08-15T10:00:00Z' },
        { unique_id: '302', campaign_id: 'camp-ANOMALY', marketing_impact_id: 'imp-SHARED-ANOMALY', status: 'DELIVERED', created_at: '2026-08-15T10:01:00Z' },
      ],
      marketingImpactEvents: [
        { impact_id: 'imp-SHARED-ANOMALY', event_name: 'click' },
        { impact_id: 'imp-SHARED-ANOMALY', event_name: 'form_step_1' },
      ],
      czSolicitudes: [
        { cz_id: 999, tracking_data_summary: { jt: 'JT_ANOMALY_00000000000' } },
      ],
    };

    const simulatedRows = simulateSqlPerformanceAnalytics(rawData);

    installSupabase({
      rpc: function () {
        return Promise.resolve({ data: simulatedRows, error: null });
      },
    });

    const res = await requestAnalyticsPerformance('');
    assert.strictEqual(res.status, 200);

    const camp = res.body.data.campaign_breakdown.find((c) => c.campaign_id === 'camp-ANOMALY');
    assert(camp, 'Anomaly campaign must exist');
    assert.strictEqual(camp.messages_sent, 2, 'messages_sent = 2');
    assert.strictEqual(camp.messages_delivered, 2, 'messages_delivered = 2');
    assert.strictEqual(camp.total_impacts, 1, 'total_impacts = 1 (DEDUPLICATED impact_id)');
    assert.strictEqual(camp.total_clicks, 1, 'total_clicks = 1 (DEDUPLICATED impact_id)');
    assert.strictEqual(camp.total_form_step_1, 1, 'total_form_step_1 = 1 (DEDUPLICATED impact_id)');
    assert.strictEqual(camp.impacts_with_solicitud, 1, 'impacts_with_solicitud = 1 (DEDUPLICATED impact_id)');
    assert.strictEqual(camp.total_solicitudes, 1, 'total_solicitudes = 1');
  }
  console.log('  ✓ Passed distinct marketing_impact_id deduplication test');

  console.log('\n--- ALL SMS PERFORMANCE ANALYTICS TESTS PASSED ---\n');
}

runTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
