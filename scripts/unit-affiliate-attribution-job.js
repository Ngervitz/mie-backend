'use strict';

/**
 * node scripts/unit-affiliate-attribution-job.js
 * Mocks only. Does not connect to Supabase.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  runAffiliateAttribution,
} = require('../src/jobs/affiliateAttributionRun');

const AFF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLICK_A = '22222222-2222-4222-8222-222222222222';
const T0 = '2026-09-21T14:21:00.000Z';
const T1 = '2026-10-21T14:21:00.000Z';
const T_BEFORE = '2026-05-06T14:13:02.000Z';
const T_AFTER = '2026-10-22T14:21:00.000Z';
const EVALUATED = '2026-10-21T18:00:00.000Z';
const SECRET_CI = 918273645;
const SECRET_NAME = 'Secreto Perez';

function sol(czId, ci, clickId, presentation, extra) {
  const summary = {
    utm_source: 'referral',
    presentation_at: presentation,
  };
  if (clickId) summary.cz_click = clickId;
  return Object.assign(
    {
      cz_id: czId,
      ci: ci,
      synced_at: '2026-10-21T16:00:00.000Z',
      fecha_reg: presentation,
      tracking_data_summary: summary,
    },
    extra || {},
  );
}

function jobDb(state) {
  const calls = [];
  function rowsFor(table, column, ids) {
    const wanted = new Set(ids.map(String));
    return (state[table] || []).filter(function (row) {
      return wanted.has(String(row[column]));
    });
  }
  function keyOf(table) {
    if (table === 'affiliate_originators') return 'ci';
    return 'cz_id';
  }
  return {
    calls: calls,
    rpc: function (name, args) {
      calls.push({ op: 'rpc', name: name, args: args });
      if (name === 'acquire_job_lock') {
        return Promise.resolve({
          data: state.lockBusy ? false : true,
          error: null,
        });
      }
      if (name === 'release_job_lock') {
        return Promise.resolve({ data: null, error: null });
      }
      if (name !== 'persist_affiliate_plan') {
        return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
      }
      if (state.failAttributionUpsert) {
        state.failAttributionUpsert = false;
        return Promise.resolve({ data: null, error: { message: 'persist failed' } });
      }
      if (state.forceSkip) {
        return Promise.resolve({
          data: {
            applied_ci: [],
            skipped_ci: args.p_ci_scope || [],
            skipped_cz_id: [],
            idempotent_ci: [],
          },
          error: null,
        });
      }
      const evaluatedAt = args.p_evaluated_at;
      const scope = new Set((args.p_ci_scope || []).map(String));
      state.affiliate_originators = (state.affiliate_originators || []).filter(function (row) {
        return !scope.has(String(row.ci));
      });
      (args.p_attributions || []).forEach(function (row) {
        const current = state.affiliate_attributions || [];
        const index = current.findIndex(function (stored) {
          return String(stored.cz_id) === String(row.cz_id);
        });
        const stored = Object.assign({}, row, {
          evaluated_at: evaluatedAt,
          prize_eligible: false,
        });
        if (index === -1) current.push(stored);
        else current[index] = stored;
        state.affiliate_attributions = current;
      });
      (args.p_originators || []).forEach(function (row) {
        state.affiliate_originators.push(Object.assign({}, row, {
          prize_eligible: false,
          updated_at: evaluatedAt,
        }));
      });
      return Promise.resolve({
        data: {
          applied_ci: args.p_ci_scope || [],
          skipped_ci: [],
          skipped_cz_id: [],
          idempotent_ci: [],
        },
        error: null,
      });
    },
    from: function (table) {
      if (state.forbidReads) throw new Error('database touched while idle');
      return {
        select: function () {
          return {
            range: function (from, to) {
              calls.push({ op: 'range', table: table });
              const rows = state[table] || [];
              return Promise.resolve({
                data: rows.slice(from, to + 1),
                error: null,
              });
            },
            in: function (column, ids) {
              calls.push({ op: 'select', table: table });
              return Promise.resolve({
                data: rowsFor(table, column, ids),
                error: null,
              });
            },
          };
        },
        upsert: function (rows) {
          calls.push({ op: 'upsert', table: table, rows: rows });
          if (table === 'cz_funnel_solicitudes') {
            throw new Error('funnel rows must not be written');
          }
          if (
            table === 'affiliate_attributions' &&
            state.failAttributionUpsert
          ) {
            state.failAttributionUpsert = false;
            return Promise.resolve({ error: { code: 'XX000' } });
          }
          const key = keyOf(table);
          const current = state[table] || [];
          rows.forEach(function (row) {
            const index = current.findIndex(function (stored) {
              return String(stored[key]) === String(row[key]);
            });
            if (index === -1) current.push(Object.assign({}, row));
            else current[index] = Object.assign({}, row);
          });
          state[table] = current;
          return Promise.resolve({ error: null });
        },
        delete: function () {
          return {
            in: function (column, ids) {
              calls.push({ op: 'delete', table: table });
              const wanted = new Set(ids.map(String));
              state[table] = (state[table] || []).filter(function (row) {
                return !wanted.has(String(row[column]));
              });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

function baseState(funnel) {
  return {
    cz_funnel_solicitudes: funnel,
    affiliate_attributions: [],
    affiliate_originators: [],
    affiliate_clicks: [
      { click_id: CLICK_A, affiliate_id: AFF_A, occurred_at: T0 },
    ],
    affiliates: [{ id: AFF_A, is_test: false, status: 'active' }],
  };
}

function storedOutcomes(state) {
  return (state.affiliate_attributions || [])
    .map(function (row) {
      return { cz_id: row.cz_id, outcome: row.outcome };
    })
    .sort(function (a, b) {
      return a.cz_id - b.cz_id;
    });
}

async function run(state, funnelOrder) {
  if (funnelOrder) state.cz_funnel_solicitudes = funnelOrder;
  return runAffiliateAttribution({
    enabled: true,
    supabase: jobDb(state),
    evaluatedAt: EVALUATED,
  });
}

(async function main() {
  {
    let touched = false;
    const result = await runAffiliateAttribution({
      enabled: false,
      supabase: {
        from: function () {
          touched = true;
          throw new Error('database touched while idle');
        },
        rpc: function () {
          touched = true;
          throw new Error('lock touched while idle');
        },
      },
    });
    assert.strictEqual(touched, false);
    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(result.pending, null);
    const asString = await runAffiliateAttribution({ enabled: 'true' });
    assert.strictEqual(asString.enabled, false);
  }

  {
    const state = baseState([sol(10, 500, CLICK_A, T1)]);
    state.lockBusy = true;
    state.forbidReads = true;
    const result = await runAffiliateAttribution({
      enabled: true,
      supabase: jobDb(state),
    });
    assert.strictEqual(result.reason, 'lock_not_acquired');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.pending, null);
    assert.strictEqual(state.affiliate_attributions.length, 0);
  }

  {
    const rows = [
      sol(11, SECRET_CI, CLICK_A, T1, {
        tracking_data_summary: {
          cz_click: CLICK_A,
          presentation_at: T1,
          nombre: SECRET_NAME,
          email: 'secreto@example.com',
        },
      }),
      sol(10, SECRET_CI, CLICK_A, '2026-10-20T14:21:00.000Z'),
    ];
    const forward = baseState(rows.slice());
    const backward = baseState(rows.slice().reverse());
    const logs = [];
    const original = process.stdout.write;
    process.stdout.write = function (chunk, encoding, callback) {
      logs.push(String(chunk));
      return original.call(process.stdout, chunk, encoding, callback);
    };
    let first;
    let second;
    try {
      first = await run(forward);
      second = await run(backward);
    } finally {
      process.stdout.write = original;
    }
    const text = logs.join('\n');
    assert.ok(text.indexOf(String(SECRET_CI)) === -1);
    assert.ok(text.indexOf(SECRET_NAME) === -1);
    assert.ok(text.indexOf('secreto@example.com') === -1);
    assert.ok(text.indexOf('"processed":2') !== -1);
    assert.ok(text.indexOf('"attributed":2') !== -1);
    assert.ok(text.indexOf('"pending":0') !== -1);
    assert.ok(text.indexOf('"errors":0') !== -1);
    assert.strictEqual(first.processed, 2);
    assert.strictEqual(first.attributed, 2);
    assert.strictEqual(first.pending, 0);
    assert.strictEqual(first.errors, 0);
    assert.deepStrictEqual(storedOutcomes(forward), storedOutcomes(backward));
    assert.deepStrictEqual(storedOutcomes(forward), [
      { cz_id: 10, outcome: 'attributed' },
      { cz_id: 11, outcome: 'attributed' },
    ]);
    assert.strictEqual(forward.affiliate_originators.length, 1);
    assert.strictEqual(forward.affiliate_originators[0].first_cz_id, 10);
    assert.strictEqual(forward.affiliate_originators[0].prize_eligible, false);
    forward.affiliate_attributions.forEach(function (row) {
      assert.strictEqual(row.prize_eligible, false);
    });
    const againDb = jobDb(forward);
    const again = await runAffiliateAttribution({
      enabled: true,
      supabase: againDb,
      evaluatedAt: EVALUATED,
    });
    assert.strictEqual(again.processed, 0);
    assert.strictEqual(again.pending, 0);
    assert.ok(!againDb.calls.some(function (call) {
      return call.op === 'upsert';
    }));
  }

  {
    const state = baseState([
      sol(20, 600, CLICK_A, T1, { synced_at: '2026-10-21T12:00:00.000Z' }),
      {
        cz_id: 5,
        ci: 600,
        synced_at: '2026-10-21T16:00:00.000Z',
        fecha_reg: T_BEFORE,
        tracking_data_summary: { utm_source: 'sms' },
      },
    ]);
    state.affiliate_attributions = [
      {
        cz_id: 20,
        evaluated_at: '2026-10-21T15:00:00.000Z',
        outcome: 'attributed',
      },
    ];
    state.affiliate_originators = [{ ci: 600, first_cz_id: 20 }];
    const result = await run(state);
    assert.strictEqual(result.errors, 0);
    assert.deepStrictEqual(storedOutcomes(state), [
      { cz_id: 5, outcome: 'no_click' },
      { cz_id: 20, outcome: 'excluded_prior_solicitud' },
    ]);
    assert.strictEqual(state.affiliate_originators.length, 0);
  }

  {
    const state = baseState([
      sol(20, 600, CLICK_A, T1, { synced_at: '2026-10-21T12:00:00.000Z' }),
      {
        cz_id: 30,
        ci: 600,
        synced_at: '2026-10-21T16:00:00.000Z',
        fecha_reg: T_AFTER,
        tracking_data_summary: { presentation_at: T_AFTER },
      },
    ]);
    state.affiliate_attributions = [
      {
        cz_id: 20,
        evaluated_at: '2026-10-21T15:00:00.000Z',
        outcome: 'attributed',
      },
    ];
    state.affiliate_originators = [{ ci: 600, first_cz_id: 20 }];
    await run(state);
    assert.deepStrictEqual(storedOutcomes(state), [
      { cz_id: 20, outcome: 'attributed' },
      { cz_id: 30, outcome: 'no_click' },
    ]);
    assert.strictEqual(state.affiliate_originators.length, 1);
    assert.strictEqual(state.affiliate_originators[0].first_cz_id, 20);
  }

  {
    const state = baseState([
      sol(40, 100, CLICK_A, T1),
      sol(41, 200, CLICK_A, T1),
    ]);
    const reversed = baseState(state.cz_funnel_solicitudes.slice().reverse());
    await run(state);
    await run(reversed);
    assert.deepStrictEqual(storedOutcomes(state), [
      { cz_id: 40, outcome: 'click_ci_conflict' },
      { cz_id: 41, outcome: 'click_ci_conflict' },
    ]);
    assert.deepStrictEqual(storedOutcomes(state), storedOutcomes(reversed));
    assert.strictEqual(state.affiliate_originators.length, 0);
  }

  {
    const state = baseState([
      {
        cz_id: 1,
        ci: 700,
        synced_at: '2026-10-21T16:00:00.000Z',
        fecha_reg: '2026-05-06 11:13:02',
        tracking_data_summary: {},
      },
      sol(2, 700, CLICK_A, T1),
    ]);
    const result = await run(state);
    assert.strictEqual(result.excludedByReason.ambiguous_fecha_reg, 1);
    assert.strictEqual(result.excludedByReason.blocked_ambiguous_history, 1);
    assert.strictEqual(result.attributed, 0);
    assert.strictEqual(state.affiliate_originators.length, 0);
  }

  {
    const state = baseState([sol(10, 500, CLICK_A, T1)]);
    state.failAttributionUpsert = true;
    const failed = await run(state);
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.errors, 1);
    assert.strictEqual(failed.processed, 0);
    assert.strictEqual(failed.pending, 1);
    assert.ok(!(state.affiliate_attributions || []).some(function (row) {
      return row.evaluated_at;
    }));
    const retried = await run(state);
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(retried.processed, 1);
    assert.strictEqual(retried.attributed, 1);
    assert.strictEqual(retried.errors, 0);
    assert.strictEqual(state.affiliate_attributions[0].outcome, 'attributed');
    assert.strictEqual(state.affiliate_attributions[0].prize_eligible, false);
  }

  {
    const state = baseState([sol(10, 500, CLICK_A, T1)]);
    state.forceSkip = true;
    const result = await run(state);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.pending, 0);
    assert.strictEqual((state.affiliate_attributions || []).length, 0);
  }

  {
    const root = path.join(__dirname, '..');
    const jobs = fs.readFileSync(path.join(root, 'src', 'routes', 'jobs.js'), 'utf8');
    const syncStart = jobs.indexOf("router.post('/run-cz-data-sync'");
    const attrStart = jobs.indexOf("router.post('/run-affiliate-attribution'");
    assert.ok(syncStart !== -1 && attrStart > syncStart);
    const syncHandler = jobs.slice(syncStart, attrStart);
    assert.ok(syncHandler.indexOf('runAffiliateAttribution') === -1);
    assert.ok(syncHandler.indexOf('affiliate_attributions') === -1);
    assert.ok(jobs.indexOf('env.affiliateAttributionEnabled === true') !== -1);
    const sync = fs.readFileSync(path.join(root, 'src', 'jobs', 'czFunnelSync.js'), 'utf8');
    assert.ok(sync.indexOf('affiliateAttributionRun') === -1);
    assert.ok(sync.indexOf('runAffiliateAttribution') === -1);
    const env = fs.readFileSync(path.join(root, 'src', 'config', 'env.js'), 'utf8');
    assert.ok(
      env.indexOf(
        "optionalTrimmedEnv('AFFILIATE_ATTRIBUTION_ENABLED') === 'true'",
      ) !== -1,
    );
    const sections = fs.readFileSync(
      path.join(root, 'src', 'middleware', 'dashboardSections.js'),
      'utf8',
    );
    assert.ok(sections.indexOf("'/jobs/run-affiliate-attribution'") !== -1);
    const migrations = fs
      .readdirSync(path.join(root, 'migrations'))
      .filter(function (name) {
        return name.indexOf('affiliate') !== -1;
      })
      .sort();
    assert.deepStrictEqual(migrations, [
      '20261020_affiliates_clicks.sql',
      '20261021_affiliate_attributions.sql',
      '20261022_affiliate_persist_plan.sql',
    ]);
    const jobSrc = fs.readFileSync(
      path.join(root, 'src', 'jobs', 'affiliateAttributionRun.js'),
      'utf8',
    );
    assert.ok(jobSrc.indexOf('prize_eligible: true') === -1);
  }

  process.stdout.write('unit-affiliate-attribution-job: ok\n');
})().catch(function (err) {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
