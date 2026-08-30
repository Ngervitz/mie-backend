'use strict';

/**
 * node scripts/unit-sms-tracking-view-api.js
 *
 * Tests for GET /sms/tracking/impact?tracking_token=...
 * Covers all 7 required cases:
 * 1. 400 when tracking_token is missing (undefined / empty)
 * 2. 400 when tracking_token format is invalid
 * 3. 404 when token is valid but not found in marketing_impacts_tracking_view
 * 4. 200 for impact with zero Credizona solicitudes (solicitudes: [])
 * 5. 200 for impact with a single Credizona solicitud and state history
 * 6. 200 for impact with multiple distinct solicitudes, verifying deduplication,
 *    separate current states, separate state history, and distinct detailed states.
 * 7. 500 when Supabase returns an error
 */

const assert = require('assert');

const TOKEN_VALID = 'abcdefghijABCDEFGHIJ12';
const TOKEN_CANARY = 'dWhn30oZBUq0umThOGn-9w';
const IMPACT_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
const SERIES_ID = '33333333-3333-4333-8333-333333333333';

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

function createMock(handler) {
  return {
    from: function (table) {
      assert.strictEqual(table, 'marketing_impacts_tracking_view');
      return {
        select: function (columns) {
          assert.strictEqual(columns, '*');
          return {
            eq: function (column, value) {
              assert.strictEqual(column, 'tracking_token');
              if (typeof handler === 'function') {
                return handler(value);
              }
              return Promise.resolve(handler || { data: [], error: null });
            },
          };
        },
      };
    },
  };
}

async function requestTrackingImpact(queryString) {
  return new Promise((resolve) => {
    const query = {};
    if (queryString) {
      const params = new URLSearchParams(queryString);
      for (const [k, v] of params.entries()) {
        query[k] = v;
      }
    }

    const req = {
      method: 'GET',
      url: '/tracking/impact' + (queryString ? `?${queryString}` : ''),
      query: query,
      headers: {},
    };

    let statusCode = 200;
    const resHeaders = {};

    const res = {
      status: function (code) {
        statusCode = code;
        return res;
      },
      set: function (key, val) {
        resHeaders[key] = val;
        return res;
      },
      setHeader: function (key, val) {
        resHeaders[key] = val;
        return res;
      },
      json: function (body) {
        resolve({
          statusCode: statusCode,
          headers: resHeaders,
          body: body,
        });
      },
      send: function (body) {
        resolve({
          statusCode: statusCode,
          headers: resHeaders,
          body: body,
        });
      },
    };

    const next = function (err) {
      if (err) {
        resolve({
          statusCode: 500,
          headers: resHeaders,
          body: { error: err.message },
        });
      } else {
        resolve({
          statusCode: 404,
          headers: resHeaders,
          body: 'Not found',
        });
      }
    };

    smsRouter.handle(req, res, next);
  });
}

(async function run() {
  console.log('Running unit tests for GET /sms/tracking/impact...');

  // -------------------------------------------------------------------------
  // 1. Missing tracking_token -> 400
  // -------------------------------------------------------------------------
  {
    installSupabase(createMock(() => Promise.resolve({ data: [], error: null })));
    
    // Completely omitted
    const res1 = await requestTrackingImpact('');
    assert.strictEqual(res1.statusCode, 400);
    assert.deepStrictEqual(res1.body, { error: 'tracking_token is required' });

    // Empty string
    const res2 = await requestTrackingImpact('tracking_token=');
    assert.strictEqual(res2.statusCode, 400);
    assert.deepStrictEqual(res2.body, { error: 'tracking_token is required' });

    // Whitespace only
    const res3 = await requestTrackingImpact('tracking_token=%20%20');
    assert.strictEqual(res3.statusCode, 400);
    assert.deepStrictEqual(res3.body, { error: 'tracking_token is required' });
  }

  // -------------------------------------------------------------------------
  // 2. Invalid tracking_token format -> 400
  // -------------------------------------------------------------------------
  {
    installSupabase(createMock(() => Promise.resolve({ data: [], error: null })));

    // Too short (<22 chars)
    const res1 = await requestTrackingImpact('tracking_token=short_token');
    assert.strictEqual(res1.statusCode, 400);
    assert.deepStrictEqual(res1.body, { error: 'Invalid tracking_token format' });

    // Too long (>22 chars)
    const res2 = await requestTrackingImpact('tracking_token=1234567890123456789012345');
    assert.strictEqual(res2.statusCode, 400);
    assert.deepStrictEqual(res2.body, { error: 'Invalid tracking_token format' });

    // Invalid characters (!@#$)
    const res3 = await requestTrackingImpact('tracking_token=abcdefghijABCDEFGHIJ!@');
    assert.strictEqual(res3.statusCode, 400);
    assert.deepStrictEqual(res3.body, { error: 'Invalid tracking_token format' });
  }

  // -------------------------------------------------------------------------
  // 3. Token not found in DB -> 404
  // -------------------------------------------------------------------------
  {
    installSupabase(createMock((token) => {
      assert.strictEqual(token, TOKEN_VALID);
      return Promise.resolve({ data: [], error: null });
    }));

    const res = await requestTrackingImpact(`tracking_token=${TOKEN_VALID}`);
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, {
      found: false,
      error: 'Marketing impact not found',
    });
  }

  // -------------------------------------------------------------------------
  // 4. Impact without Credizona Solicitud -> 200 (solicitudes: [])
  // -------------------------------------------------------------------------
  {
    installSupabase(createMock((token) => {
      assert.strictEqual(token, TOKEN_CANARY);
      return Promise.resolve({
        data: [
          {
            marketing_impact_id: IMPACT_ID,
            tracking_token: TOKEN_CANARY,
            channel: 'sms',
            contact_id: null,
            phone: '093885859',
            impact_created_at: '2026-08-28T19:36:06.288Z',
            campaign_series_id: SERIES_ID,
            campaign_series_name: 'Canary Series',
            campaign_id: CAMPAIGN_ID,
            campaign_name: 'Canary Campaign Tanda 2',
            clicked: true,
            clicked_at: '2026-08-28T19:39:30.398Z',
            form_step_1_at: '2026-08-28T19:39:31.000Z',
            form_step_2_at: null,
            form_step_3_at: null,
            last_event_at: '2026-08-28T19:39:31.000Z',
            total_events: 2,
            cz_solicitud_id: null,
            cz_ci: null,
            solicitud_fecha_reg: null,
            solicitud_estado_actual_id: null,
            solicitud_estados_historico: null,
            solicitud_estados_detalle: null,
            protected_clicked: true,
          },
        ],
        error: null,
      });
    }));

    const res = await requestTrackingImpact(`tracking_token=${TOKEN_CANARY}`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.found, true);
    assert.ok(res.body.impact);
    assert.strictEqual(res.body.impact.marketing_impact_id, IMPACT_ID);
    assert.strictEqual(res.body.impact.tracking_token, TOKEN_CANARY);
    assert.strictEqual(res.body.impact.phone, '093885859');
    assert.strictEqual(res.body.impact.campaign.id, CAMPAIGN_ID);
    assert.strictEqual(res.body.impact.campaign.name, 'Canary Campaign Tanda 2');
    assert.strictEqual(res.body.impact.campaign.campaign_series_id, SERIES_ID);
    assert.strictEqual(res.body.impact.campaign.campaign_series_name, 'Canary Series');
    assert.strictEqual(res.body.impact.events.clicked, true);
    assert.strictEqual(res.body.impact.events.form_step_1_at, '2026-08-28T19:39:31.000Z');
    assert.strictEqual(res.body.impact.events.total_events, 2);
    assert.strictEqual(res.body.impact.series_protection.protected_clicked, true);
    assert.deepStrictEqual(res.body.impact.solicitudes, []);
  }

  // -------------------------------------------------------------------------
  // 5. Impact with a single Credizona Solicitud and state history -> 200
  // -------------------------------------------------------------------------
  {
    const estadosDetalle = [
      { estado_id: 1, estado: '⏺ Autorizando', fechahora: '2026-08-27T16:03:47Z' },
      { estado_id: 3, estado: '🔴 Autorización negada', fechahora: '2026-08-27T16:03:49Z' },
    ];

    installSupabase(createMock((token) => {
      assert.strictEqual(token, TOKEN_VALID);
      return Promise.resolve({
        data: [
          {
            marketing_impact_id: IMPACT_ID,
            tracking_token: TOKEN_VALID,
            channel: 'sms',
            contact_id: null,
            phone: null,
            impact_created_at: '2026-08-27T19:00:07.912Z',
            campaign_series_id: null,
            campaign_series_name: null,
            campaign_id: null,
            campaign_name: null,
            clicked: false,
            clicked_at: null,
            form_step_1_at: '2026-08-27T19:03:19Z',
            form_step_2_at: '2026-08-27T19:03:35Z',
            form_step_3_at: '2026-08-27T19:03:42Z',
            last_event_at: '2026-08-27T19:03:42Z',
            total_events: 3,
            cz_solicitud_id: 1160,
            cz_ci: 11111111,
            solicitud_fecha_reg: '2026-08-27T16:03:47Z',
            solicitud_estado_actual_id: 3,
            solicitud_estados_historico: [1, 3],
            solicitud_estados_detalle: estadosDetalle,
            protected_clicked: false,
          },
        ],
        error: null,
      });
    }));

    const res = await requestTrackingImpact(`tracking_token=${TOKEN_VALID}`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.found, true);
    assert.strictEqual(res.body.impact.solicitudes.length, 1);
    
    const sol = res.body.impact.solicitudes[0];
    assert.strictEqual(sol.cz_solicitud_id, 1160);
    assert.strictEqual(sol.ci, 11111111);
    assert.strictEqual(sol.fecha_reg, '2026-08-27T16:03:47Z');
    assert.strictEqual(sol.estado_actual_id, 3);
    assert.deepStrictEqual(sol.estados_historico, [1, 3]);
    assert.deepStrictEqual(sol.estados_detalle, estadosDetalle);
  }

  // -------------------------------------------------------------------------
  // 6. Impact with multiple distinct Credizona Solicitudes and duplicate rows -> 200
  //    Verifies exact deduplication, no cross-mixing of states/history.
  // -------------------------------------------------------------------------
  {
    const sol1Estados = [
      { estado_id: 1, estado: '⏺ Autorizando', fechahora: '2026-08-27T16:03:47Z' },
      { estado_id: 3, estado: '🔴 Autorización negada', fechahora: '2026-08-27T16:03:49Z' },
    ];
    const sol2Estados = [
      { estado_id: 1, estado: '⏺ Autorizando', fechahora: '2026-08-28T10:00:00Z' },
      { estado_id: 7, estado: '🟢 Aprobado', fechahora: '2026-08-28T10:05:00Z' },
      { estado_id: 11, estado: '⭐ Otorgado', fechahora: '2026-08-28T10:10:00Z' },
    ];

    const baseRow = {
      marketing_impact_id: IMPACT_ID,
      tracking_token: TOKEN_VALID,
      channel: 'sms',
      contact_id: null,
      phone: '097100035',
      impact_created_at: '2026-08-27T19:00:07.912Z',
      campaign_series_id: SERIES_ID,
      campaign_series_name: 'Series X',
      campaign_id: CAMPAIGN_ID,
      campaign_name: 'Camp X',
      clicked: true,
      clicked_at: '2026-08-27T19:01:00Z',
      form_step_1_at: '2026-08-27T19:03:19Z',
      form_step_2_at: '2026-08-27T19:03:35Z',
      form_step_3_at: '2026-08-27T19:03:42Z',
      last_event_at: '2026-08-27T19:03:42Z',
      total_events: 4,
      protected_clicked: true,
    };

    // 4 rows total in DB view: 2 rows for Solicitud 1160 (simulating duplicate join), 2 rows for Solicitud 1161
    const rawRows = [
      Object.assign({}, baseRow, {
        cz_solicitud_id: 1160,
        cz_ci: 11111111,
        solicitud_fecha_reg: '2026-08-27T16:03:47Z',
        solicitud_estado_actual_id: 3,
        solicitud_estados_historico: [1, 3],
        solicitud_estados_detalle: sol1Estados,
      }),
      Object.assign({}, baseRow, {
        cz_solicitud_id: 1160,
        cz_ci: 11111111,
        solicitud_fecha_reg: '2026-08-27T16:03:47Z',
        solicitud_estado_actual_id: 3,
        solicitud_estados_historico: [1, 3],
        solicitud_estados_detalle: sol1Estados,
      }),
      Object.assign({}, baseRow, {
        cz_solicitud_id: 1161,
        cz_ci: 22222222,
        solicitud_fecha_reg: '2026-08-28T10:00:00Z',
        solicitud_estado_actual_id: 11,
        solicitud_estados_historico: [1, 7, 11],
        solicitud_estados_detalle: sol2Estados,
      }),
      Object.assign({}, baseRow, {
        cz_solicitud_id: 1161,
        cz_ci: 22222222,
        solicitud_fecha_reg: '2026-08-28T10:00:00Z',
        solicitud_estado_actual_id: 11,
        solicitud_estados_historico: [1, 7, 11],
        solicitud_estados_detalle: sol2Estados,
      }),
    ];

    installSupabase(createMock(() => Promise.resolve({ data: rawRows, error: null })));

    const res = await requestTrackingImpact(`tracking_token=${TOKEN_VALID}`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.found, true);
    
    // Exactly 2 distinct solicitudes returned
    assert.strictEqual(res.body.impact.solicitudes.length, 2);

    const s1 = res.body.impact.solicitudes.find((s) => s.cz_solicitud_id === 1160);
    const s2 = res.body.impact.solicitudes.find((s) => s.cz_solicitud_id === 1161);

    assert.ok(s1, 'Solicitud 1160 must exist');
    assert.ok(s2, 'Solicitud 1161 must exist');

    // Verify Solicitud 1 preserves its exact data without contamination
    assert.strictEqual(s1.cz_solicitud_id, 1160);
    assert.strictEqual(s1.ci, 11111111);
    assert.strictEqual(s1.fecha_reg, '2026-08-27T16:03:47Z');
    assert.strictEqual(s1.estado_actual_id, 3);
    assert.deepStrictEqual(s1.estados_historico, [1, 3]);
    assert.deepStrictEqual(s1.estados_detalle, sol1Estados);

    // Verify Solicitud 2 preserves its exact data without contamination
    assert.strictEqual(s2.cz_solicitud_id, 1161);
    assert.strictEqual(s2.ci, 22222222);
    assert.strictEqual(s2.fecha_reg, '2026-08-28T10:00:00Z');
    assert.strictEqual(s2.estado_actual_id, 11);
    assert.deepStrictEqual(s2.estados_historico, [1, 7, 11]);
    assert.deepStrictEqual(s2.estados_detalle, sol2Estados);
  }

  // -------------------------------------------------------------------------
  // 7. Supabase error -> 500
  // -------------------------------------------------------------------------
  {
    installSupabase(createMock(() => {
      return Promise.resolve({
        data: null,
        error: { message: 'Database connection failed', code: '57014' },
      });
    }));

    const res = await requestTrackingImpact(`tracking_token=${TOKEN_VALID}`);
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { error: 'Failed to load tracking details' });
  }

  console.log('OK: All unit tests in unit-sms-tracking-view-api.js passed successfully!');
})().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
