'use strict';

/**
 * Mi Deuda Stage 1D — endpoint/read helper tests (no production I/O).
 * Run: node scripts/unit-mi-deuda-bags-endpoint.js
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

// Mock env BEFORE any src module that loads config/env.
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
  },
};

const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {},
};

const {
  MAP_STATUS,
  buildMiDeudaBagModel,
} = require('../src/lib/miDeudaBags');
const {
  formatMiDeudaBagsResponse,
  loadMiDeudaBags,
} = require('../src/lib/miDeudaBagsRead');
const { resolveSectionForPath } = require('../src/middleware/dashboardSections');
const {
  requireDashboardPermission,
} = require('../src/middleware/requireDashboardPermission');

function hasMnMeTotals(obj) {
  const s = JSON.stringify(obj);
  return /moroso_total|castigado_total|reestructurado_total|deuda_total|monto_gestionable/i.test(
    s,
  );
}

function makeRangeClient(pages) {
  return {
    from: function (table) {
      return {
        select: function () {
          return {
            range: async function (from, to) {
              const all = pages[table] || [];
              return { data: all.slice(from, to + 1), error: null };
            },
          };
        },
      };
    },
  };
}

function installSupabase(client) {
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: client,
  };
  const routePath = require.resolve('../src/routes/rechazados');
  delete require.cache[routePath];
  // Keep miDeudaBagsRead cached — it does not close over supabase client.
  return require('../src/routes/rechazados');
}

async function listen(router) {
  const app = express();
  app.use('/rechazados', router);
  const server = http.createServer(app);
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        server: server,
        base: 'http://127.0.0.1:' + server.address().port,
      });
    });
  });
}

async function getJson(base, path) {
  const res = await fetch(base + path);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_e) {
    /* ignore */
  }
  return { status: res.status, json: json };
}

(async function main() {
  // auth section mapping
  assert.strictEqual(resolveSectionForPath('/rechazados'), 'rechazados');
  assert.strictEqual(
    resolveSectionForPath('/rechazados/mi-deuda/bags'),
    'rechazados',
  );

  // middleware: unauthorized
  await new Promise(function (resolve, reject) {
    const mw = requireDashboardPermission('rechazados');
    const req = { dashboardUserId: null, dashboardAuthViaCron: false };
    const res = {
      statusCode: null,
      body: null,
      status: function (code) {
        this.statusCode = code;
        return this;
      },
      json: function (body) {
        this.body = body;
        try {
          assert.strictEqual(this.statusCode, 401);
          assert.strictEqual(this.body.error, 'No autenticado');
          resolve();
        } catch (e) {
          reject(e);
        }
        return this;
      },
    };
    mw(req, res, function () {
      reject(new Error('expected 401'));
    });
  });

  // middleware: cron authorized
  await new Promise(function (resolve, reject) {
    const mw = requireDashboardPermission('rechazados');
    const req = { dashboardUserId: null, dashboardAuthViaCron: true };
    mw(
      req,
      {
        status: function () {
          reject(new Error('no status'));
          return this;
        },
        json: function () {
          reject(new Error('no json'));
          return this;
        },
      },
      function () {
        resolve();
      },
    );
  });

  // format contract
  const model = buildMiDeudaBagModel({
    snapshots: [
      {
        id: 's1',
        ci: 1,
        consulted_on: '2026-09-01',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    institutions: [
      {
        snapshot_id: 's1',
        institution_name: 'CASH S.A.',
        category: '5',
        moroso_mn: 100,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
      },
      {
        snapshot_id: 's1',
        institution_name: 'BANCO DE LA REPÚBLICA ORIENTAL DEL URUGUAY',
        category: '5',
        moroso_mn: null,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
        creditos_reestructurados_mn: 50,
        creditos_reestructurados_me: 0,
      },
      {
        snapshot_id: 's1',
        institution_name: 'Unknown Bank S.A.',
        category: '5',
        moroso_mn: 10,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
      },
    ],
  });
  const data = formatMiDeudaBagsResponse(model);
  assert.ok(data.bags);
  assert.ok(data.counts);
  assert.ok(Array.isArray(data.reestructurado_universe));
  assert.ok(Array.isArray(data.unmapped_rows));
  assert.ok(Array.isArray(data.ambiguous_cases));
  assert.strictEqual(data.bags[0].moroso_mn, 100);
  assert.strictEqual(data.bags[0].moroso_me, 0);
  assert.strictEqual(hasMnMeTotals(data), false);
  assert.strictEqual(data.unmapped_rows[0].map_status, MAP_STATUS.UNMAPPED);
  assert.strictEqual(
    data.reestructurado_universe.filter(function (r) {
      return !r.also_bag_member;
    }).length,
    1,
  );

  // ambiguous
  const amb = formatMiDeudaBagsResponse(
    buildMiDeudaBagModel({
      snapshots: [
        {
          id: 's1',
          ci: 2,
          consulted_on: '2026-09-01',
          created_at: '2026-09-01T00:00:00Z',
        },
      ],
      institutions: [
        {
          snapshot_id: 's1',
          institution_name: 'Banco de la República Oriental del Uruguay',
          category: '5',
          moroso_mn: 1,
          moroso_me: null,
          castigado_mn: null,
          castigado_me: null,
        },
        {
          snapshot_id: 's1',
          institution_name: 'BANCO DE LA REPÚBLICA ORIENTAL DEL URUGUAY',
          category: '5',
          moroso_mn: null,
          moroso_me: null,
          castigado_mn: 2,
          castigado_me: null,
        },
      ],
    }),
  );
  assert.strictEqual(amb.ambiguous_cases.length, 1);
  assert.strictEqual(amb.bags.length, 0);

  // load helper
  const loaded = await loadMiDeudaBags(
    makeRangeClient({
      rejected_bcu_snapshots: [
        {
          id: 's1',
          ci: 10,
          consulted_on: '2026-09-01',
          created_at: '2026-09-01T00:00:00Z',
          source: 'html_import',
        },
      ],
      rejected_bcu_institutions: [
        {
          id: 'i1',
          snapshot_id: 's1',
          institution_name: 'OCA S.A.',
          category: '5',
          moroso_mn: null,
          moroso_me: null,
          castigado_mn: 10,
          castigado_me: 5,
          creditos_reestructurados_mn: null,
          creditos_reestructurados_me: null,
        },
      ],
    }),
  );
  assert.strictEqual(loaded.bags[0].castigado_mn, 10);
  assert.strictEqual(loaded.bags[0].castigado_me, 5);

  // HTTP 200
  const okRouter = installSupabase(
    makeRangeClient({
      rejected_bcu_snapshots: [
        {
          id: 's1',
          ci: 1,
          consulted_on: '2026-09-01',
          created_at: '2026-09-01T00:00:00Z',
          source: 'html_import',
        },
      ],
      rejected_bcu_institutions: [
        {
          id: 'i1',
          snapshot_id: 's1',
          institution_name: 'SOCUR S.A.',
          category: '5',
          moroso_mn: 20,
          moroso_me: 0,
          castigado_mn: null,
          castigado_me: null,
          creditos_reestructurados_mn: null,
          creditos_reestructurados_me: null,
        },
      ],
    }),
  );
  const okSrv = await listen(okRouter);
  const ok = await getJson(okSrv.base, '/rechazados/mi-deuda/bags');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.ok, true);
  assert.strictEqual(ok.json.data.bags[0].institution_canonical, 'SOCUR S.A.');
  assert.strictEqual(ok.json.data.bags[0].moroso_mn, 20);
  assert.strictEqual(ok.json.data.bags[0].moroso_me, 0);
  assert.strictEqual(hasMnMeTotals(ok.json), false);
  okSrv.server.close();

  // HTTP 500 controlled
  const failRouter = installSupabase({
    from: function () {
      return {
        select: function () {
          return {
            range: async function () {
              return { data: null, error: { message: 'boom', code: 'XX' } };
            },
          };
        },
      };
    },
  });
  const failSrv = await listen(failRouter);
  const fail = await getJson(failSrv.base, '/rechazados/mi-deuda/bags');
  assert.strictEqual(fail.status, 500);
  assert.strictEqual(fail.json.error, 'Error interno');
  failSrv.server.close();

  console.log('unit-mi-deuda-bags-endpoint: PASS');
})().catch(function (err) {
  console.error('unit-mi-deuda-bags-endpoint: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
