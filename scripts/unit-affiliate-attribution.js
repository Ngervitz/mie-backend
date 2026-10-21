'use strict';

/**
 * node scripts/unit-affiliate-attribution.js
 * Mocks only. Does not connect to Supabase.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ATTRIBUTION_WINDOW_MS,
  OUTCOMES,
  evaluateAffiliateAttributions,
  attributeSolicitudesByCzId,
} = require('../src/lib/affiliateAttribution');

const AFF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AFF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLICK_A = '22222222-2222-4222-8222-222222222222';
const CLICK_B = '33333333-3333-4333-8333-333333333333';
const CLICK_C = '44444444-4444-4444-8444-444444444444';
const T0 = '2026-09-21T14:21:00.000Z';
const T1 = '2026-10-21T14:21:00.000Z';
const T1_OFFSET = '2026-10-21T11:21:00-03:00';
const T_BEFORE = '2026-05-06T14:13:02.000Z';

function click(id, affiliateId, occurred, extra) {
  return Object.assign(
    {
      click_id: id,
      affiliate_id: affiliateId,
      occurred_at: occurred,
      is_test: false,
    },
    extra || {},
  );
}

function sol(czId, ci, clickId, presentation, extra) {
  return Object.assign(
    {
      cz_id: czId,
      ci: ci,
      tracking_data_summary: {
        utm_source: 'referral',
        utm_medium: 'affiliate',
        cz_click: clickId,
        presentation_at: presentation,
      },
    },
    extra || {},
  );
}

function byCz(plan, czId) {
  return plan.attributions.find(function (row) {
    return row.cz_id === czId;
  });
}

function assertNoPrize(plan) {
  plan.attributions.forEach(function (row) {
    assert.strictEqual(row.prize_eligible, false);
    assert.ok(OUTCOMES.indexOf(row.outcome) !== -1);
  });
  plan.originators.forEach(function (row) {
    assert.strictEqual(row.prize_eligible, false);
  });
}

{
  const exactly = Date.parse(T0) + ATTRIBUTION_WINDOW_MS;
  assert.strictEqual(new Date(exactly).toISOString(), T1);
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(10, 500, CLICK_A, T1_OFFSET)],
    [click(CLICK_A, AFF_A, T0)],
  );
  const row = byCz(plan, 10);
  assert.strictEqual(row.outcome, 'attributed');
  assert.strictEqual(row.is_test, false);
  assert.strictEqual(row.prize_eligible, false);
  assert.strictEqual(row.affiliate_id, AFF_A);
  assert.strictEqual(row.click_id, CLICK_A);
  assert.strictEqual(row.presentation_text, T1_OFFSET);
  assert.strictEqual(Date.parse(row.presentation_at), Date.parse(T1_OFFSET));
  assert.strictEqual(row.utm_source, undefined);
  assert.strictEqual(plan.originators.length, 1);
  assert.strictEqual(plan.originators[0].affiliate_id, AFF_A);
  assert.strictEqual(plan.originators[0].first_cz_id, 10);
  assert.strictEqual(plan.originators[0].is_test, false);
  assertNoPrize(plan);
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(11, 501, CLICK_A, T0)],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(plan, 11).outcome, 'attributed');
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(12, 502, CLICK_A, T1)],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(plan, 12).outcome, 'attributed');
}

{
  const late = new Date(Date.parse(T1) + 1).toISOString();
  const plan = evaluateAffiliateAttributions(
    [sol(13, 503, CLICK_A, late)],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(plan, 13).outcome, 'expired');
  assert.strictEqual(plan.originators.length, 0);
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(14, 504, CLICK_A, T0)],
    [click(CLICK_A, AFF_A, T1)],
  );
  assert.strictEqual(byCz(plan, 14).outcome, 'click_after_presentation');
  assert.strictEqual(plan.originators.length, 0);
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(15, 505, CLICK_B, T1)],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(plan, 15).outcome, 'unknown_click');
  assert.strictEqual(byCz(plan, 15).click_id, null);
  assert.strictEqual(plan.originators.length, 0);
}

{
  const plan = evaluateAffiliateAttributions(
    [
      {
        cz_id: 16,
        ci: 506,
        tracking_data_summary: { utm_source: 'sms', jt: 'AAAAAAAAAAAAAAAAAAAAAA' },
      },
    ],
    [],
  );
  assert.strictEqual(byCz(plan, 16).outcome, 'ambiguous_fecha_reg');
  assert.strictEqual(byCz(plan, 16).click_id, null);
  assert.strictEqual(plan.originators.length, 0);
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(17, 507, CLICK_A, '2026-10-21 11:21:00')],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(plan, 17).outcome, 'no_presentation_at');
  assert.strictEqual(plan.originators.length, 0);
}

{
  const prior = {
    cz_id: 1,
    ci: 600,
    fecha_reg: T_BEFORE,
    tracking_data_summary: { utm_source: 'sms' },
  };
  const plan = evaluateAffiliateAttributions(
    [prior, sol(20, 600, CLICK_A, T1)],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(plan, 1).outcome, 'no_click');
  assert.strictEqual(byCz(plan, 20).outcome, 'excluded_prior_solicitud');
  assert.strictEqual(byCz(plan, 20).affiliate_id, AFF_A);
  assert.strictEqual(plan.originators.length, 0);
  assertNoPrize(plan);
}

{
  const plan = evaluateAffiliateAttributions(
    [
      sol(30, 700, CLICK_A, T0),
      sol(31, 700, CLICK_B, T1),
      sol(32, 700, CLICK_C, T1),
    ],
    [
      click(CLICK_A, AFF_A, '2026-09-01T14:21:00.000Z'),
      click(CLICK_B, AFF_A, T0),
      click(CLICK_C, AFF_B, T0),
    ],
  );
  assert.strictEqual(byCz(plan, 30).outcome, 'attributed');
  assert.strictEqual(byCz(plan, 31).outcome, 'attributed');
  assert.strictEqual(byCz(plan, 32).outcome, 'other_affiliate');
  assert.strictEqual(byCz(plan, 32).affiliate_id, AFF_B);
  assert.strictEqual(plan.originators.length, 1);
  assert.strictEqual(plan.originators[0].first_cz_id, 30);
  assert.strictEqual(plan.originators[0].affiliate_id, AFF_A);
}

{
  const first = evaluateAffiliateAttributions(
    [sol(41, 800, CLICK_B, T1)],
    [click(CLICK_B, AFF_B, T0)],
  );
  assert.strictEqual(first.originators[0].affiliate_id, AFF_B);
  const recalc = evaluateAffiliateAttributions(
    [sol(40, 800, CLICK_A, T0), sol(41, 800, CLICK_B, T1)],
    [click(CLICK_A, AFF_A, '2026-09-01T14:21:00.000Z'), click(CLICK_B, AFF_B, T0)],
  );
  assert.strictEqual(byCz(recalc, 40).outcome, 'attributed');
  assert.strictEqual(byCz(recalc, 41).outcome, 'other_affiliate');
  assert.strictEqual(recalc.originators[0].affiliate_id, AFF_A);
  assert.strictEqual(recalc.originators[0].first_cz_id, 40);
}

{
  const cleared = evaluateAffiliateAttributions(
    [
      {
        cz_id: 39,
        ci: 800,
        fecha_reg: '2026-08-01T00:00:00.000Z',
        tracking_data_summary: { utm_source: 'email' },
      },
      sol(40, 800, CLICK_A, T0),
    ],
    [click(CLICK_A, AFF_A, '2026-09-01T14:21:00.000Z')],
  );
  assert.strictEqual(byCz(cleared, 40).outcome, 'excluded_prior_solicitud');
  assert.strictEqual(cleared.originators.length, 0);
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(50, 900, CLICK_A, T0), sol(51, 900, CLICK_A, T1)],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(plan, 50).outcome, 'attributed');
  assert.strictEqual(byCz(plan, 51).outcome, 'attributed');
  assert.strictEqual(byCz(plan, 50).click_id, CLICK_A);
  assert.strictEqual(byCz(plan, 51).click_id, CLICK_A);
  assert.strictEqual(byCz(plan, 50).prize_eligible, false);
  assert.strictEqual(byCz(plan, 51).prize_eligible, false);
  assert.strictEqual(plan.originators.length, 1);
  assert.strictEqual(plan.originators[0].first_cz_id, 50);
  assert.strictEqual(plan.originators[0].prize_eligible, false);
}

{
  const third = '2026-10-01T14:21:00.000Z';
  const forward = [sol(52, 910, CLICK_A, T1), sol(53, 910, CLICK_A, third), sol(54, 910, CLICK_A, T0)];
  const clicks = [click(CLICK_A, AFF_A, T0)];
  const plan = evaluateAffiliateAttributions(forward, clicks);
  assert.strictEqual(byCz(plan, 52).outcome, 'attributed');
  assert.strictEqual(byCz(plan, 53).outcome, 'attributed');
  assert.strictEqual(byCz(plan, 54).outcome, 'attributed');
  assert.strictEqual(plan.originators[0].first_cz_id, 54);
  const reversed = evaluateAffiliateAttributions(forward.slice().reverse(), clicks);
  assert.deepStrictEqual(reversed, plan);
}

{
  const shared = [
    sol(61, 1001, CLICK_A, T1),
    sol(62, 1002, CLICK_A, T0),
  ];
  const clicks = [click(CLICK_A, AFF_A, T0)];
  const plan = evaluateAffiliateAttributions(shared, clicks);
  assert.strictEqual(byCz(plan, 61).outcome, 'click_ci_conflict');
  assert.strictEqual(byCz(plan, 62).outcome, 'click_ci_conflict');
  assert.strictEqual(byCz(plan, 61).prize_eligible, false);
  assert.strictEqual(byCz(plan, 62).prize_eligible, false);
  assert.strictEqual(plan.originators.length, 0);
  const flipped = evaluateAffiliateAttributions(shared.slice().reverse(), clicks);
  assert.deepStrictEqual(flipped, plan);
}

{
  const naive = evaluateAffiliateAttributions(
    [
      {
        cz_id: 2,
        ci: 610,
        fecha_reg: '2026-05-06 11:13:02',
        tracking_data_summary: { utm_source: 'sms' },
      },
      sol(21, 610, CLICK_A, T1),
    ],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(naive, 2).outcome, 'ambiguous_fecha_reg');
  assert.strictEqual(byCz(naive, 21).outcome, 'blocked_ambiguous_history');
  assert.strictEqual(byCz(naive, 21).prize_eligible, false);
  assert.strictEqual(naive.originators.length, 0);
  const missing = evaluateAffiliateAttributions(
    [
      { cz_id: 3, ci: 611, fecha_reg: null, tracking_data_summary: {} },
      sol(22, 611, CLICK_A, T1),
    ],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(missing, 3).outcome, 'ambiguous_fecha_reg');
  assert.strictEqual(byCz(missing, 22).outcome, 'blocked_ambiguous_history');
  const garbage = evaluateAffiliateAttributions(
    [
      { cz_id: 4, ci: 612, fecha_reg: 'ayer', tracking_data_summary: {} },
      sol(23, 612, CLICK_A, T1),
    ],
    [click(CLICK_A, AFF_A, T0)],
  );
  assert.strictEqual(byCz(garbage, 4).outcome, 'ambiguous_fecha_reg');
  assert.strictEqual(byCz(garbage, 23).outcome, 'blocked_ambiguous_history');
  assert.deepStrictEqual(
    evaluateAffiliateAttributions(
      [
        sol(23, 612, CLICK_A, T1),
        { cz_id: 4, ci: 612, fecha_reg: 'ayer', tracking_data_summary: {} },
      ],
      [click(CLICK_A, AFF_A, T0)],
    ),
    garbage,
  );
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(60, 901, CLICK_A, T1)],
    [click(CLICK_A, AFF_A, T0, { is_test: true, status: 'inactive' })],
  );
  assert.strictEqual(byCz(plan, 60).outcome, 'attributed');
  assert.strictEqual(byCz(plan, 60).is_test, true);
  assert.strictEqual(byCz(plan, 60).prize_eligible, false);
  assert.strictEqual(plan.originators[0].is_test, true);
  assert.strictEqual(plan.originators[0].prize_eligible, false);
}

{
  const plan = evaluateAffiliateAttributions(
    [sol(72, 902, CLICK_B, T1), sol(71, 902, CLICK_A, T1)],
    [click(CLICK_A, AFF_A, T0), click(CLICK_B, AFF_B, T0)],
  );
  assert.strictEqual(byCz(plan, 71).outcome, 'attributed');
  assert.strictEqual(byCz(plan, 72).outcome, 'other_affiliate');
  assert.strictEqual(plan.originators[0].first_cz_id, 71);
}

{
  const input = [sol(80, 903, CLICK_A, T1_OFFSET)];
  const snapshot = JSON.stringify(input);
  const once = evaluateAffiliateAttributions(input, [click(CLICK_A, AFF_A, T0)]);
  const twice = evaluateAffiliateAttributions(input, [click(CLICK_A, AFF_A, T0)]);
  assert.deepStrictEqual(once, twice);
  assert.strictEqual(JSON.stringify(input), snapshot);
  assert.strictEqual(input[0].tracking_data_summary.utm_source, 'referral');
}

{
  const middle = evaluateAffiliateAttributions(
    [
      sol(90, 904, CLICK_A, T0),
      {
        cz_id: 91,
        ci: 904,
        fecha_reg: '2026-10-01T00:00:00.000Z',
        tracking_data_summary: { utm_source: 'sms' },
      },
      sol(92, 904, CLICK_B, T1),
    ],
    [
      click(CLICK_A, AFF_A, '2026-09-01T00:00:00.000Z'),
      click(CLICK_B, AFF_A, T0),
    ],
  );
  assert.strictEqual(byCz(middle, 90).outcome, 'attributed');
  assert.strictEqual(byCz(middle, 91).outcome, 'no_click');
  assert.strictEqual(byCz(middle, 92).outcome, 'attributed');
  assert.strictEqual(middle.originators[0].first_cz_id, 90);
}

function memorySupabase(state) {
  const calls = [];
  function rowsFor(table, column, ids) {
    const source = state[table] || [];
    const wanted = new Set(ids.map(String));
    return source.filter(function (row) {
      return wanted.has(String(row[column]));
    });
  }
  return {
    calls: calls,
    from: function (table) {
      return {
        select: function () {
          return {
            in: function (column, ids) {
              calls.push({ op: 'select', table: table, column: column, ids: ids });
              if (table === 'cz_funnel_solicitudes' && state.failFunnel) {
                return Promise.resolve({ data: null, error: { code: 'XX000' } });
              }
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
          return Promise.resolve({ error: null });
        },
        update: function () {
          throw new Error('update must not run');
        },
        delete: function () {
          return {
            in: function () {
              throw new Error('direct deletes must not run');
            },
          };
        },
      };
    },
    rpc: function (name, args) {
      calls.push({ op: 'rpc', name: name, args: args });
      if (name !== 'persist_affiliate_plan') {
        return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
      }
      return Promise.resolve({
        data: {
          applied_ci: args.p_ci_scope,
          skipped_ci: [],
          skipped_cz_id: [],
          idempotent_ci: [],
        },
        error: null,
      });
    },
  };
}

(async function run() {
  {
    const db = memorySupabase({
      cz_funnel_solicitudes: [
        {
          cz_id: 1,
          ci: 600,
          fecha_reg: T_BEFORE,
          tracking_data_summary: { utm_source: 'sms' },
        },
        sol(20, 600, CLICK_A, T1_OFFSET),
      ],
      affiliate_clicks: [
        {
          click_id: CLICK_A,
          affiliate_id: AFF_A,
          occurred_at: T0,
        },
      ],
      affiliates: [{ id: AFF_A, is_test: false, status: 'inactive' }],
    });
    const plan = await attributeSolicitudesByCzId(db, [20], {
      evaluatedAt: '2026-10-21T15:00:00.000Z',
    });
    assert.strictEqual(byCz(plan, 20).outcome, 'excluded_prior_solicitud');
    assert.strictEqual(plan.originators.length, 0);
    const writes = db.calls.filter(function (call) {
      return call.op !== 'select';
    });
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].name, 'persist_affiliate_plan');
    assert.deepStrictEqual(writes[0].args.p_ci_scope, [600]);
    assert.strictEqual(writes[0].args.p_evaluated_at, '2026-10-21T15:00:00.000Z');
    assert.ok(writes[0].args.p_attributions.every(function (row) {
      return row.prize_eligible === false;
    }));
    assert.strictEqual(writes[0].args.p_originators.length, 0);
    const funnelWrites = db.calls.filter(function (call) {
      return call.table === 'cz_funnel_solicitudes' && call.op !== 'select';
    });
    assert.strictEqual(funnelWrites.length, 0);
  }

  {
    const db = memorySupabase({ failFunnel: true, cz_funnel_solicitudes: [] });
    let failed = null;
    try {
      await attributeSolicitudesByCzId(db, [20]);
    } catch (err) {
      failed = err;
    }
    assert.ok(failed);
    assert.ok(!db.calls.some(function (call) {
      return call.op === 'rpc';
    }));
  }

  {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '20261021_affiliate_attributions.sql'),
      'utf8',
    );
    OUTCOMES.forEach(function (outcome) {
      assert.ok(sql.indexOf("'" + outcome + "'") !== -1);
    });
    assert.ok(sql.indexOf('UNIQUE') !== -1);
    assert.ok(sql.indexOf('cz_id') !== -1);
    assert.ok(sql.indexOf('ENABLE ROW LEVEL SECURITY') !== -1);
    assert.ok(sql.indexOf('REVOKE ALL ON TABLE public.affiliate_attributions FROM PUBLIC, anon, authenticated') !== -1);
    assert.ok(sql.indexOf('GRANT SELECT, INSERT, UPDATE ON TABLE public.affiliate_attributions TO service_role') !== -1);
    assert.ok(sql.indexOf('NOT (is_test AND prize_eligible)') !== -1);
    assert.ok(sql.indexOf('CREATE POLICY') === -1);
    assert.ok(sql.indexOf('TO anon') === -1);
    const sync = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'jobs', 'czFunnelSync.js'),
      'utf8',
    );
    assert.ok(sync.indexOf('affiliateAttribution') === -1);
    assert.ok(sync.indexOf('affiliate_attributions') === -1);
    const persistSql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '20261022_affiliate_persist_plan.sql'),
      'utf8',
    );
    assert.ok(persistSql.indexOf('p_ci_scope bigint[]') !== -1);
    assert.ok(persistSql.indexOf('SECURITY INVOKER') !== -1);
    assert.ok(persistSql.indexOf('REVOKE EXECUTE ON FUNCTION public.persist_affiliate_plan(timestamptz, bigint[], jsonb, jsonb)') !== -1);
    assert.ok(persistSql.indexOf('GRANT EXECUTE ON FUNCTION public.persist_affiliate_plan(timestamptz, bigint[], jsonb, jsonb)') !== -1);
    assert.ok(persistSql.indexOf('TO service_role') !== -1);
    assert.ok(persistSql.indexOf('excluded_prior_solicitud') === -1);
    const persistJs = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'affiliateAttribution.js'),
      'utf8',
    );
    assert.ok(persistJs.indexOf("rpc('persist_affiliate_plan'") !== -1);
    assert.ok(persistJs.indexOf(".from('affiliate_originators')") === -1);
    assert.ok(persistJs.indexOf(".from('affiliate_attributions')") === -1);
  }

  process.stdout.write('unit-affiliate-attribution: ok\n');
})().catch(function (err) {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
