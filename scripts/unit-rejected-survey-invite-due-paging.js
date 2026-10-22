'use strict';

/**
 * Job rechazados_survey_invite_due must read past the PostgREST 1000-row cap.
 * Run: node scripts/unit-rejected-survey-invite-due-paging.js
 *
 * The materializeFn only records. It does not write recipients.
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
const { PURPOSE } = require('../src/lib/rejectedSurveyInvite');
const {
  runRechazadosSurveyInviteDue,
} = require('../src/jobs/rechazadosSurveyInviteDue');

const NOW = new Date('2026-10-20T18:00:00.000Z');
const STEP1_T0 = '2026-10-20T12:00:00.000Z';
const BEFORE_CUTOFF_T0 = '2019-06-01T00:00:00.000Z';

const SIX = [
  { ci: 42282298, cz: 2354, t0: '2026-10-20T13:05:42+00:00' },
  { ci: 53640938, cz: 2353, t0: '2026-10-20T13:05:01+00:00' },
  { ci: 50143880, cz: 2350, t0: '2026-10-20T12:57:36+00:00' },
  { ci: 46181036, cz: 2345, t0: '2026-10-20T12:50:33+00:00' },
  { ci: 31499012, cz: 2342, t0: '2026-10-20T12:41:30+00:00' },
  { ci: 39988637, cz: 2339, t0: '2026-10-20T12:29:38+00:00' },
];

function emailOf(ci) {
  return 'ci' + ci + '@example.com';
}

function pagingClient(tables) {
  const calls = [];
  return {
    calls: calls,
    from: function (table) {
      const rows = tables[table] || [];
      const state = { eqs: [], ins: [], orderCol: null, range: null };
      const chain = {
        select: function () {
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
        then: function (resolve, reject) {
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
          calls.push({
            table: table,
            order: state.orderCol,
            range: state.range ? state.range.slice() : null,
            matched: list.length,
          });
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

function buildTables() {
  const estados = [];
  const solicitudes = [];
  for (let n = 1; n <= 1000; n += 1) {
    const due = n <= 4;
    estados.push({
      cz_historico_id: n,
      cz_solicitud_id: n,
      fechahora_src: due ? STEP1_T0 : BEFORE_CUTOFF_T0,
      solicitudes_estados_id: 3,
    });
    solicitudes.push({
      cz_id: n,
      ci: n,
      email: emailOf(n),
      lrw_id: 'LRW-' + n,
      nombre: 'N' + n,
    });
  }
  // Same historico twice: the job must keep one row.
  estados.push(Object.assign({}, estados[0]));

  for (let i = 0; i < SIX.length; i += 1) {
    const row = SIX[i];
    estados.push({
      cz_historico_id: 3000 + i,
      cz_solicitud_id: row.cz,
      fechahora_src: row.t0,
      solicitudes_estados_id: 3,
    });
    solicitudes.push({
      cz_id: row.cz,
      ci: row.ci,
      email: emailOf(row.ci),
      lrw_id: 'LRW-' + row.cz,
      nombre: 'Six',
    });
  }

  const recipients = [];
  for (let id = 1; id <= 1000; id += 1) {
    const cz = ((id - 1) % 196) + 5;
    recipients.push({
      id: id,
      campaign_id: '101',
      ci: cz,
      email: emailOf(cz),
      status: 'sent',
      error_reason: null,
      purpose: PURPOSE,
      created_at: '2026-10-01T00:00:00.000Z',
      last_attempt_at: null,
      next_attempt_at: null,
      cz_solicitud_id: cz,
    });
  }
  // Past the first 1000 recipient ids: CI 2 already has STEP1.
  recipients.push({
    id: 1001,
    campaign_id: '101',
    ci: 2,
    email: emailOf(2),
    status: 'sent',
    error_reason: null,
    purpose: PURPOSE,
    created_at: '2026-10-20T15:00:00.000Z',
    last_attempt_at: null,
    next_attempt_at: null,
    cz_solicitud_id: 2,
  });

  return {
    cz_funnel_solicitud_estados: estados,
    cz_funnel_solicitudes: solicitudes,
    cz_funnel_encuestas: [{ ci: 3, cz_id: 3 }],
    email_suppressions: [{ email: emailOf(4) }],
    email_campaign_recipients: recipients,
  };
}

function rangesFor(calls, table) {
  return calls
    .filter(function (c) {
      return c.table === table && c.range;
    })
    .map(function (c) {
      return c.range.join('-') + (c.order ? ':' + c.order : '');
    });
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

  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(rangesFor(sb.calls, 'cz_funnel_solicitud_estados'), [
    '0-999:cz_historico_id',
    '1000-1999:cz_historico_id',
  ]);
  assert.deepStrictEqual(rangesFor(sb.calls, 'cz_funnel_solicitudes'), [
    '0-999:cz_id',
    '1000-1999:cz_id',
  ]);
  const recipientRanges = rangesFor(sb.calls, 'email_campaign_recipients');
  assert.ok(
    recipientRanges.indexOf('0-999:id') !== -1 &&
      recipientRanges.indexOf('1000-1999:id') !== -1,
    'recipient read must open a second page: ' + recipientRanges.join(','),
  );

  const byCi = new Map();
  const czByCi = new Map();
  for (let i = 0; i < materialized.length; i += 1) {
    const row = materialized[i];
    assert.ok(!byCi.has(row.ci), 'duplicate materialize for ' + row.ci);
    byCi.set(row.ci, row.campaignId);
    czByCi.set(row.ci, row.cz);
  }
  assert.strictEqual(czByCi.get(1), 1, 'page-1 CI materializes its own episode');
  for (let i = 0; i < SIX.length; i += 1) {
    assert.strictEqual(
      czByCi.get(SIX[i].ci),
      SIX[i].cz,
      'CI ' + SIX[i].ci + ' materializes the decided episode',
    );
  }

  assert.strictEqual(byCi.get(1), '101', 'page-1 eligible stays STEP1');
  assert.ok(!byCi.has(2), 'STEP already sent past row 1000 must not be selected');
  assert.ok(!byCi.has(3), 'completed survey must not be selected');
  assert.ok(!byCi.has(4), 'suppressed email must not be selected');
  for (let i = 5; i <= 1000; i += 1) {
    assert.ok(!byCi.has(i), 'pre-cutoff CI ' + i + ' must stay out');
  }
  for (let i = 0; i < SIX.length; i += 1) {
    assert.strictEqual(
      byCi.get(SIX[i].ci),
      '101',
      'CI ' + SIX[i].ci + ' must be eligible for STEP1',
    );
  }
  assert.strictEqual(byCi.size, 1 + SIX.length);
  assert.strictEqual(out.eligible, 1 + SIX.length);
  assert.strictEqual(out.materialized_step1, 1 + SIX.length);

  const held = [];
  const sbHeld = pagingClient(tables);
  const heldOut = await runRechazadosSurveyInviteDue({
    skipLock: true,
    now: NOW,
    supabase: sbHeld,
    loadElmBlocks: async function () {
      return new Map([[SIX[0].ci, { state: 'in_evaluation', source: 'elm_process' }]]);
    },
    materializeFn: async function (_client, ci, campaignId) {
      held.push({ ci: Number(ci), campaignId: String(campaignId) });
      return { ok: true, result: 'queued' };
    },
  });
  const heldCis = held.map(function (row) {
    return row.ci;
  });
  assert.ok(heldCis.indexOf(SIX[0].ci) === -1, 'ELM hold still blocks that CI');
  assert.ok(heldCis.indexOf(1) !== -1, 'unrelated page-1 CI stays eligible');
  for (let i = 1; i < SIX.length; i += 1) {
    assert.ok(heldCis.indexOf(SIX[i].ci) !== -1);
  }
  assert.strictEqual(heldOut.elm_in_progress >= 1, true);

  console.log('unit-rejected-survey-invite-due-paging: ok');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
