'use strict';

/**
 * Snapshot reuse, concurrency 4, missing_email, and the pre-write encuesta check.
 * Run: node scripts/unit-rejected-survey-invite-due-materialize-pool.js
 *
 * Does not send email and does not call production.
 */

const assert = require('assert');

process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
process.env.RECHAZADOS_SURVEY_INVITE_STEP1_CAMPAIGN_ID = '101';
process.env.RECHAZADOS_SURVEY_INVITE_STEP2_CAMPAIGN_ID = '102';
process.env.RECHAZADOS_SURVEY_INVITE_STEP3_CAMPAIGN_ID = '103';
process.env.RECHAZADOS_SURVEY_INVITE_NORMAL_CUTOFF_AT = '2020-01-01T00:00:00.000Z';

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
    sessionSecret: 'test-session',
    cronSecret: null,
    czTrackingHmacSecret: null,
    emailUnsubscribeHmacSecret: 'test-email-unsubscribe-secret',
    emailPublicBaseUrl: 'https://janus.test',
    rechazadosSurveyInviteCampaignId: null,
    rechazadosSurveyInviteStep1CampaignId: '101',
    rechazadosSurveyInviteStep2CampaignId: '102',
    rechazadosSurveyInviteStep3CampaignId: '103',
    rechazadosSurveyInviteNormalCutoffAt: '2020-01-01T00:00:00.000Z',
  },
};

const {
  MATERIALIZE_CONCURRENCY,
  runRechazadosSurveyInviteDue,
} = require('../src/jobs/rechazadosSurveyInviteDue');
const {
  materializeRejectedSurveyInvite,
} = require('../src/lib/rejectedSurveyInviteMaterialize');
const {
  buildSurveyInviteIdempotencyKey,
} = require('../src/lib/rejectedSurveyInvite');

const NOW = new Date('2026-10-20T18:00:00.000Z');
const T0 = '2026-10-20T12:00:00.000Z';
const TOKEN = 'abcdefghijABCDEFGHIJ12';
const IMPACT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function emailOf(ci) {
  return 'ci' + ci + '@example.com';
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function buildCohort(count, opts) {
  const options = opts || {};
  const estados = [];
  const solicitudes = [];
  const encuestas = [];
  const cis = [];
  for (let n = 0; n < count; n += 1) {
    const ci = 30000001 + n;
    cis.push(ci);
    const badEmail = options.badEmailIndex === n;
    const completed = options.completedAll || (options.completedIndexes || []).indexOf(n) !== -1;
    estados.push({
      cz_historico_id: n + 1,
      cz_solicitud_id: n + 1,
      fechahora_src: T0,
      solicitudes_estados_id: 3,
    });
    solicitudes.push({
      cz_id: n + 1,
      ci: ci,
      email: badEmail ? 'sin-arroba' : emailOf(ci),
      lrw_id: 'LRW-' + ci,
      nombre: 'N' + ci,
    });
    if (completed) encuestas.push({ ci: ci, cz_id: 900000 + n });
  }
  return {
    cis: cis,
    tables: {
      cz_funnel_solicitud_estados: estados,
      cz_funnel_solicitudes: solicitudes,
      cz_funnel_encuestas: encuestas,
      email_suppressions: [],
      email_campaign_recipients: options.recipients || [],
      email_campaigns: [
        {
          id: 101,
          subject: 'Subj {{nombre}}',
          body_html: '<a href="{{survey_url}}">x</a> {{unsubscribe_url}}',
        },
      ],
    },
  };
}

function filterRows(rows, state) {
  let list = rows.slice();
  for (let i = 0; i < state.eqs.length; i += 1) {
    const col = state.eqs[i][0];
    const val = state.eqs[i][1];
    list = list.filter(function (row) {
      return String(row[col]) === String(val);
    });
  }
  for (let i = 0; i < state.ins.length; i += 1) {
    const col = state.ins[i][0];
    const set = new Set(
      (state.ins[i][1] || []).map(function (v) {
        return String(v);
      }),
    );
    list = list.filter(function (row) {
      return set.has(String(row[col]));
    });
  }
  if (state.orderCol) {
    const col = state.orderCol;
    list.sort(function (a, b) {
      return Number(a[col]) - Number(b[col]);
    });
  }
  if (state.range) {
    list = list.slice(state.range[0], state.range[1] + 1);
  }
  return list;
}

/**
 * @param {object} tables
 * @param {{ headCount?: function(number): number, rpc?: Function }} [opts]
 */
function clientFor(tables, opts) {
  const options = opts || {};
  const fromCounts = {};
  const store = new Map();
  return {
    fromCounts: fromCounts,
    store: store,
    from: function (table) {
      fromCounts[table] = (fromCounts[table] || 0) + 1;
      const rows = tables[table] || [];
      const state = {
        eqs: [],
        ins: [],
        orderCol: null,
        range: null,
        head: false,
      };
      function resultPromise() {
        if (table === 'cz_funnel_encuestas' && state.head) {
          const ciEq = state.eqs.filter(function (pair) {
            return pair[0] === 'ci';
          })[0];
          const ci = ciEq ? Number(ciEq[1]) : null;
          const count =
            options.headCount != null ? options.headCount(ci) : 0;
          return Promise.resolve({ data: null, error: null, count: count });
        }
        return Promise.resolve({
          data: filterRows(rows, state),
          error: null,
          count: null,
        });
      }
      const chain = {
        select: function (_cols, selectOpts) {
          state.head = Boolean(selectOpts && selectOpts.head);
          return chain;
        },
        eq: function (col, val) {
          state.eqs.push([col, val]);
          return chain;
        },
        in: function (col, vals) {
          state.ins.push([col, vals]);
          return chain;
        },
        is: function () {
          return chain;
        },
        order: function (col) {
          state.orderCol = col;
          return chain;
        },
        range: function (from, to) {
          state.range = [from, to];
          return chain;
        },
        limit: function () {
          return chain;
        },
        maybeSingle: function () {
          if (table === 'email_campaign_recipients') {
            const idEq = state.eqs.filter(function (pair) {
              return pair[0] === 'id';
            })[0];
            const keyEq = state.eqs.filter(function (pair) {
              return pair[0] === 'idempotency_key';
            })[0];
            const row = idEq ? store.get(String(idEq[1])) : null;
            if (!row || (keyEq && row.idempotency_key !== keyEq[1])) {
              return Promise.resolve({ data: null, error: null });
            }
            return Promise.resolve({ data: Object.assign({}, row), error: null });
          }
          return resultPromise().then(function (res) {
            const row = res.data && res.data[0] ? res.data[0] : null;
            return { data: row, error: null };
          });
        },
        then: function (resolve, reject) {
          return resultPromise().then(resolve, reject);
        },
        update: function (patch) {
          const upd = {
            eqs: [],
            isNull: [],
          };
          const updChain = {
            eq: function (col, val) {
              upd.eqs.push([col, val]);
              return updChain;
            },
            is: function (col, val) {
              upd.isNull.push([col, val]);
              return updChain;
            },
            select: function () {
              return updChain;
            },
            maybeSingle: function () {
              const idEq = upd.eqs.filter(function (pair) {
                return pair[0] === 'id';
              })[0];
              const row = idEq ? store.get(String(idEq[1])) : null;
              if (!row) return Promise.resolve({ data: null, error: null });
              Object.assign(row, patch, { status: 'queued' });
              return Promise.resolve({
                data: {
                  id: row.id,
                  status: row.status,
                  email: row.email,
                  marketing_impact_id: row.marketing_impact_id,
                },
                error: null,
              });
            },
          };
          return updChain;
        },
      };
      return chain;
    },
    rpc: async function (name, params) {
      if (options.rpc) return options.rpc(name, params);
      assert.strictEqual(name, 'upsert_email_survey_invite_recipient_impact');
      const key = params.p_idempotency_key;
      const existing = store.get(key);
      if (existing) {
        return {
          data: {
            created: false,
            recipient_id: existing.id,
            impact_id: IMPACT_ID,
            tracking_token: TOKEN,
            destination_url: params.p_destination_url,
            campaign_id: existing.campaign_id,
            idempotency_key: key,
            status: existing.status,
            provider_send_started_at: existing.provider_send_started_at,
            cz_solicitud_id: existing.cz_solicitud_id,
          },
          error: null,
        };
      }
      const row = {
        id: store.size + 1,
        campaign_id: Number(params.p_campaign_id),
        idempotency_key: key,
        ci: params.p_ci,
        email: params.p_email,
        status: 'queued',
        purpose: params.p_purpose,
        marketing_impact_id: IMPACT_ID,
        provider_send_started_at: null,
        template_vars: {},
        payload_html: null,
        payload_to: null,
        payload_from: null,
        payload_subject: null,
        template_subject_snapshot: null,
        template_body_html_snapshot: null,
        error_reason: null,
        cz_solicitud_id: params.p_cz_solicitud_id,
      };
      store.set(key, row);
      store.set(String(row.id), row);
      return {
        data: {
          created: true,
          recipient_id: row.id,
          impact_id: IMPACT_ID,
          tracking_token: TOKEN,
          destination_url: params.p_destination_url,
          campaign_id: row.campaign_id,
          idempotency_key: key,
          status: 'queued',
          provider_send_started_at: null,
          cz_solicitud_id: row.cz_solicitud_id,
        },
        error: null,
      };
    },
  };
}

async function runWithStub(count, stubOpts, cohortOpts) {
  const cohort = buildCohort(count, cohortOpts);
  const sb = clientFor(cohort.tables);
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const out = await runRechazadosSurveyInviteDue({
    skipLock: true,
    now: NOW,
    supabase: sb,
    loadElmBlocks: async function () {
      return new Map();
    },
    materializeFn: async function (_client, ci, campaignId, materializeOpts) {
      active += 1;
      if (active > maxActive) maxActive = active;
      try {
        if (stubOpts && stubOpts.delayMs) await delay(stubOpts.delayMs);
        if (stubOpts && stubOpts.failCi != null && Number(ci) === stubOpts.failCi) {
          throw new Error('ci failed');
        }
        calls.push({
          ci: Number(ci),
          campaignId: String(campaignId),
          opts: materializeOpts,
        });
        return { ok: true, result: 'queued' };
      } finally {
        active -= 1;
      }
    },
  });
  return {
    cohort: cohort,
    sb: sb,
    calls: calls,
    maxActive: maxActive,
    out: out,
  };
}

(async function main() {
  assert.strictEqual(MATERIALIZE_CONCURRENCY, 4);

  const none = await runWithStub(2, null, { completedAll: true });
  assert.strictEqual(none.out.eligible, 0);
  assert.strictEqual(none.out.materialized_step1, 0);
  assert.strictEqual(none.out.survey_completed, 2);
  assert.strictEqual(none.calls.length, 0);
  assert.strictEqual(none.out.errors, 0);
  assert.strictEqual(none.sb.fromCounts.cz_funnel_solicitudes, 1);

  const one = await runWithStub(1);
  assert.strictEqual(one.out.eligible, 1);
  assert.strictEqual(one.out.materialized_step1, 1);
  assert.strictEqual(one.calls.length, 1);
  assert.strictEqual(one.calls[0].opts.czSolicitudId, 1);
  assert.strictEqual(one.calls[0].opts.eligibilitySnapshot.eligible, true);
  assert.strictEqual(one.calls[0].opts.eligibilitySnapshot.ci, one.cohort.cis[0]);
  assert.strictEqual(one.calls[0].opts.eligibilitySnapshot.lrw_id, 'LRW-' + one.cohort.cis[0]);
  assert.strictEqual(one.calls[0].campaignId, '101');
  assert.strictEqual(one.sb.fromCounts.cz_funnel_solicitudes, 1);
  assert.strictEqual(one.sb.fromCounts.cz_funnel_solicitud_estados, 1);

  const hundred = await runWithStub(100, { delayMs: 20 });
  assert.strictEqual(hundred.out.candidates, 100);
  assert.strictEqual(hundred.out.eligible, 100);
  assert.strictEqual(hundred.out.materialized_step1, 100);
  assert.strictEqual(hundred.out.errors, 0);
  assert.strictEqual(hundred.calls.length, 100);
  assert.strictEqual(hundred.maxActive, 4);
  const seenCi = new Set();
  const seenCz = new Set();
  for (let i = 0; i < hundred.calls.length; i += 1) {
    const call = hundred.calls[i];
    assert.ok(!seenCi.has(call.ci), 'duplicate CI ' + call.ci);
    seenCi.add(call.ci);
    const cz = call.opts.eligibilitySnapshot.cz_solicitud_id;
    assert.ok(!seenCz.has(cz), 'duplicate episode ' + cz);
    seenCz.add(cz);
    assert.strictEqual(
      call.opts.eligibilitySnapshot.email,
      emailOf(call.ci),
    );
  }
  assert.strictEqual(hundred.sb.fromCounts.cz_funnel_solicitudes, 1);
  assert.strictEqual(hundred.sb.fromCounts.cz_funnel_solicitud_estados, 1);

  const failCi = 30000003;
  const failed = await runWithStub(8, { delayMs: 15, failCi: failCi });
  assert.strictEqual(failed.out.eligible, 8);
  assert.strictEqual(failed.out.errors, 1);
  assert.strictEqual(failed.out.materialized_step1, 7);
  assert.strictEqual(failed.calls.length, 7);
  assert.ok(failed.maxActive <= 4);
  assert.ok(failed.maxActive >= 2);
  for (let i = 0; i < failed.calls.length; i += 1) {
    assert.notStrictEqual(failed.calls[i].ci, failCi);
  }

  const gap = await runWithStub(3, null, { badEmailIndex: 1, completedIndexes: [2] });
  assert.strictEqual(gap.out.missing_email, 1);
  assert.strictEqual(gap.out.survey_completed, 1);
  assert.strictEqual(gap.out.eligible, 1);
  assert.strictEqual(gap.calls.length, 1);
  assert.notStrictEqual(gap.calls[0].ci, gap.cohort.cis[1]);

  const seeded = buildCohort(1);
  seeded.tables.email_campaign_recipients.push({
    id: 50,
    campaign_id: 101,
    ci: seeded.cis[0],
    email: emailOf(seeded.cis[0]),
    status: 'queued',
    error_reason: null,
    purpose: 'rechazados_survey_invite',
    created_at: '2026-10-20T13:00:00.000Z',
    last_attempt_at: null,
    next_attempt_at: null,
    cz_solicitud_id: 1,
  });
  const seededSb = clientFor(seeded.tables);
  const seededCalls = [];
  const seededOut = await runRechazadosSurveyInviteDue({
    skipLock: true,
    now: NOW,
    supabase: seededSb,
    loadElmBlocks: async function () {
      return new Map();
    },
    materializeFn: async function () {
      seededCalls.push(1);
      return { ok: true, result: 'queued' };
    },
  });
  assert.strictEqual(seededCalls.length, 0);
  assert.strictEqual(seededOut.already_attempted, 1);
  assert.strictEqual(seededOut.materialized_step1, 0);
  assert.strictEqual(seededOut.eligible, 0);

  const raceCohort = buildCohort(1);
  let rpcCalls = 0;
  const raceSb = clientFor(raceCohort.tables, {
    headCount: function () {
      return 1;
    },
    rpc: function () {
      rpcCalls += 1;
      throw new Error('rpc must not run after a late encuesta');
    },
  });
  const raceOut = await runRechazadosSurveyInviteDue({
    skipLock: true,
    now: NOW,
    supabase: raceSb,
    loadElmBlocks: async function () {
      return new Map();
    },
  });
  assert.strictEqual(rpcCalls, 0);
  assert.strictEqual(raceOut.eligible, 1);
  assert.strictEqual(raceOut.materialized_step1, 0);
  assert.strictEqual(raceOut.survey_completed, 1);
  assert.strictEqual(raceOut.errors, 0);
  assert.strictEqual(raceSb.fromCounts.cz_funnel_solicitudes, 1);
  assert.strictEqual(raceSb.fromCounts.cz_funnel_solicitud_estados, 1);
  assert.strictEqual(raceSb.store.size, 0);

  const writeCohort = buildCohort(1);
  const writeSb = clientFor(writeCohort.tables, {
    headCount: function () {
      return 0;
    },
  });
  const writeOut = await runRechazadosSurveyInviteDue({
    skipLock: true,
    now: NOW,
    supabase: writeSb,
    loadElmBlocks: async function () {
      return new Map();
    },
  });
  assert.strictEqual(writeOut.materialized_step1, 1);
  assert.strictEqual(writeOut.errors, 0);
  assert.strictEqual(writeSb.fromCounts.cz_funnel_solicitudes, 1);
  const expectedKey = buildSurveyInviteIdempotencyKey(101, 1);
  assert.ok(writeSb.store.has(expectedKey));
  assert.strictEqual(writeSb.store.size, 2);

  const snap = {
    eligible: true,
    reason: 'eligible',
    ci: 30000001,
    cz_solicitud_id: 1,
    email: emailOf(30000001),
    email_masked: 'c***@example.com',
    lrw_id: 'LRW-30000001',
    nombre: 'N',
  };
  const dupSb = clientFor(buildCohort(1).tables, {
    headCount: function () {
      return 0;
    },
  });
  const pair = await Promise.all([
    materializeRejectedSurveyInvite(dupSb, snap.ci, '101', {
      czSolicitudId: 1,
      eligibilitySnapshot: snap,
    }),
    materializeRejectedSurveyInvite(dupSb, snap.ci, '101', {
      czSolicitudId: 1,
      eligibilitySnapshot: snap,
    }),
  ]);
  assert.strictEqual(pair[0].ok, true);
  assert.strictEqual(pair[1].ok, true);
  assert.strictEqual(pair[0].result, 'queued');
  assert.strictEqual(pair[1].result, 'queued');
  const recipientRows = [];
  dupSb.store.forEach(function (row, key) {
    if (key === expectedKey) recipientRows.push(row);
  });
  assert.strictEqual(recipientRows.length, 1);
  assert.strictEqual(dupSb.fromCounts.cz_funnel_solicitudes || 0, 0);
  assert.strictEqual(dupSb.fromCounts.cz_funnel_solicitud_estados || 0, 0);

  console.log('unit-rejected-survey-invite-due-materialize-pool: ok');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
