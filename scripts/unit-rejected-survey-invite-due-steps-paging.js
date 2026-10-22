'use strict';

/**
 * S1/S2/S3 past the PostgREST 1000-row cap.
 * Catch-up materializes only the step that is due now.
 * Already-sent and completed-survey CIs are not selected.
 * The episode passed to materialize is the one eligibility validates.
 *
 * Run: node scripts/unit-rejected-survey-invite-due-steps-paging.js
 * materializeFn records only. It does not write.
 */

const assert = require('assert');

process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
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

const { PAGE_SIZE } = require('../src/lib/rejectedSurveyInviteListContext');
const { PURPOSE, REASONS } = require('../src/lib/rejectedSurveyInvite');
const {
  getRejectedSurveyInviteEligibility,
} = require('../src/lib/rejectedSurveyInviteEligibility');
const {
  runRechazadosSurveyInviteDue,
} = require('../src/jobs/rechazadosSurveyInviteDue');

const NOW = new Date('2026-10-20T18:00:00.000Z');
const BEFORE_CUTOFF_T0 = '2019-06-01T00:00:00.000Z';
const S1_T0 = '2026-10-20T12:00:00.000Z';
const S2_T0 = '2026-10-19T12:00:00.000Z';
const S3_T0 = '2026-10-17T00:00:00.000Z';

const CASES = {
  s1: { ci: 810001, cz: 1101, hist: 1101, t0: S1_T0, step: 1, campaign: '101' },
  s2: { ci: 810002, cz: 1102, hist: 1102, t0: S2_T0, step: 2, campaign: '102' },
  s3: { ci: 810003, cz: 1103, hist: 1103, t0: S3_T0, step: 3, campaign: '103' },
  sent: { ci: 810004, cz: 1104, hist: 1104, t0: S1_T0, step: 1, campaign: '101' },
  encuesta: { ci: 810005, cz: 1105, hist: 1105, t0: S1_T0, step: 1, campaign: '101' },
};

function emailOf(ci) {
  return 'ci' + ci + '@example.com';
}

function pagingClient(tables) {
  return {
    from: function (table) {
      const rows = tables[table] || [];
      const state = { eqs: [], ins: [], orderCol: null, range: null, head: false };
      const chain = {
        select: function (_cols, opts) {
          state.head = Boolean(opts && opts.head);
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
        limit: function () {
          return chain;
        },
        range: function (from, to) {
          state.range = [from, to];
          return chain;
        },
        maybeSingle: async function () {
          const list = filterRows(rows, state);
          return { data: list[0] || null, error: null };
        },
        then: function (resolve, reject) {
          let list = filterRows(rows, state);
          if (state.orderCol) {
            const col = state.orderCol;
            list.sort(function (a, b) {
              return Number(a[col]) - Number(b[col]);
            });
          }
          if (state.head) {
            return Promise.resolve({ data: null, error: null, count: list.length }).then(
              resolve,
              reject,
            );
          }
          if (state.range) {
            list = list.slice(state.range[0], state.range[1] + 1);
          }
          return Promise.resolve({ data: list, error: null }).then(resolve, reject);
        },
      };
      return chain;
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
  return list;
}

function buildTables() {
  const estados = [];
  const solicitudes = [];
  for (let n = 1; n <= 1000; n += 1) {
    estados.push({
      cz_historico_id: n,
      cz_solicitud_id: n,
      fechahora_src: BEFORE_CUTOFF_T0,
      solicitudes_estados_id: 3,
    });
    solicitudes.push({
      cz_id: n,
      ci: 700000 + n,
      email: emailOf(700000 + n),
      lrw_id: 'LRW-' + n,
      nombre: 'Filler',
    });
  }
  Object.keys(CASES).forEach(function (key) {
    const row = CASES[key];
    estados.push({
      cz_historico_id: row.hist,
      cz_solicitud_id: row.cz,
      fechahora_src: row.t0,
      solicitudes_estados_id: 3,
    });
    solicitudes.push({
      cz_id: row.cz,
      ci: row.ci,
      email: emailOf(row.ci),
      lrw_id: 'LRW-' + row.cz,
      nombre: key,
    });
  });
  const recipients = [];
  for (let id = 1; id <= 1000; id += 1) {
    recipients.push({
      id: id,
      campaign_id: '101',
      ci: 1,
      email: emailOf(1),
      status: 'sent',
      error_reason: null,
      purpose: PURPOSE,
      created_at: '2026-10-01T00:00:00.000Z',
      cz_solicitud_id: 1,
    });
  }
  recipients.push({
    id: 1500,
    campaign_id: '101',
    ci: CASES.sent.ci,
    email: emailOf(CASES.sent.ci),
    status: 'sent',
    error_reason: null,
    purpose: PURPOSE,
    created_at: '2026-10-20T16:00:00.000Z',
    cz_solicitud_id: CASES.sent.cz,
  });
  return {
    cz_funnel_solicitud_estados: estados,
    cz_funnel_solicitudes: solicitudes,
    cz_funnel_encuestas: [{ ci: CASES.encuesta.ci, cz_id: 1 }],
    email_suppressions: [],
    email_campaign_recipients: recipients,
  };
}

(async function main() {
  const tables = buildTables();
  assert.ok(tables.cz_funnel_solicitud_estados.length > PAGE_SIZE);
  assert.ok(tables.cz_funnel_solicitudes.length > PAGE_SIZE);
  assert.ok(tables.email_campaign_recipients.length > PAGE_SIZE);

  const sb = pagingClient(tables);
  const materialized = [];
  const out = await runRechazadosSurveyInviteDue({
    skipLock: true,
    now: NOW,
    supabase: sb,
    loadElmBlocks: async function () {
      return new Map();
    },
    materializeFn: async function (_client, ci, campaignId, opts) {
      materialized.push({
        ci: Number(ci),
        campaignId: String(campaignId),
        cz: opts && opts.czSolicitudId != null ? Number(opts.czSolicitudId) : null,
      });
      return { ok: true, result: 'queued' };
    },
  });

  assert.strictEqual(materialized.length, 3, 'only the three due steps');
  function callFor(ci) {
    return materialized.filter(function (row) {
      return row.ci === ci;
    });
  }
  ['s1', 's2', 's3'].forEach(function (key) {
    const row = CASES[key];
    const calls = callFor(row.ci);
    assert.strictEqual(calls.length, 1, key + ' materializes once');
    assert.strictEqual(calls[0].campaignId, row.campaign, key + ' campaign');
    assert.strictEqual(calls[0].cz, row.cz, key + ' episode');
  });
  assert.strictEqual(callFor(CASES.sent.ci).length, 0, 'sent STEP is not materialized again');
  assert.strictEqual(callFor(CASES.encuesta.ci).length, 0, 'completed survey is not materialized');
  assert.strictEqual(out.materialized_step1, 1);
  assert.strictEqual(out.materialized_step2, 1);
  assert.strictEqual(out.materialized_step3, 1);

  async function elig(row, explicit) {
    const opts = {
      campaignId: row.campaign,
      loadElmBlocks: async function () {
        return new Map();
      },
    };
    if (explicit) opts.czSolicitudId = row.cz;
    return getRejectedSurveyInviteEligibility(pagingClient(tables), row.ci, opts);
  }

  for (let i = 0; i < 3; i += 1) {
    const key = ['s1', 's2', 's3'][i];
    const row = CASES[key];
    const recomputed = await elig(row, false);
    const pinned = await elig(row, true);
    assert.strictEqual(recomputed.eligible, true, key + ' recomputed eligible');
    assert.strictEqual(Number(recomputed.cz_solicitud_id), row.cz, key + ' recomputed episode');
    assert.strictEqual(pinned.eligible, true, key + ' pinned eligible');
    assert.strictEqual(Number(pinned.cz_solicitud_id), row.cz, key + ' pinned episode');
    assert.strictEqual(
      Number(recomputed.cz_solicitud_id),
      Number(pinned.cz_solicitud_id),
      key + ' decision episode matches materialize episode',
    );
  }

  const sent = await elig(CASES.sent, true);
  assert.strictEqual(sent.eligible, false);
  assert.strictEqual(sent.reason, REASONS.ALREADY_SENT);

  const done = await elig(CASES.encuesta, true);
  assert.strictEqual(done.eligible, false);
  assert.strictEqual(done.reason, REASONS.SURVEY_ALREADY_COMPLETED);

  console.log('unit-rejected-survey-invite-due-steps-paging: ok');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
