'use strict';

/**
 * Hotfix A+B: bundle reuse + no 1000-row cap on survey-invite list context.
 * Run: node scripts/unit-rejected-survey-invite-list-bundle.js
 */

const assert = require('assert');

process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.RECHAZADOS_SURVEY_INVITE_STEP1_CAMPAIGN_ID = '101';
process.env.RECHAZADOS_SURVEY_INVITE_STEP2_CAMPAIGN_ID = '102';
process.env.RECHAZADOS_SURVEY_INVITE_STEP3_CAMPAIGN_ID = '103';
process.env.RECHAZADOS_SURVEY_INVITE_NORMAL_CUTOFF_AT =
  '2020-01-01T00:00:00.000Z';

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
    emailPublicBaseUrl: 'https://janus.test',
    rechazadosSurveyInviteCampaignId: null,
    rechazadosSurveyInviteStep1CampaignId: '101',
    rechazadosSurveyInviteStep2CampaignId: '102',
    rechazadosSurveyInviteStep3CampaignId: '103',
    rechazadosSurveyInviteNormalCutoffAt: '2020-01-01T00:00:00.000Z',
  },
};

const { REASONS } = require('../src/lib/rejectedSurveyInvite');
const {
  attachSurveyInviteToListRows,
} = require('../src/lib/rejectedSurveyInviteEligibility');
const {
  PAGE_SIZE,
  fetchSurveyInviteListContextFromSupabase,
  assertSurveyInviteBundleContext,
} = require('../src/lib/rejectedSurveyInviteListContext');
const { resolveCurrentLastRejectionForCi } = require('../src/lib/rejectedSurveyInvite');

const T0 = '2026-10-19T14:48:24+00:00';
const NOW = new Date('2026-10-19T20:00:00.000Z');

function makeSolicitud(czId, ci) {
  return {
    cz_id: czId,
    ci: ci,
    email: 'user' + ci + '@example.com',
    lrw_id: 'LRW-' + czId,
    nombre: 'Test',
  };
}

function makeEstado(czId, t0) {
  return {
    cz_historico_id: czId,
    cz_solicitud_id: czId,
    fechahora_src: t0 || T0,
    solicitudes_estados_id: 3,
  };
}

function listRow(ci, czId) {
  return {
    ci: ci,
    cz_solicitud_id: czId,
    rejected_at: T0,
  };
}

function stubSupabaseForAttach(extraTables) {
  const fromCalls = [];
  return {
    fromCalls: fromCalls,
    from: function (table) {
      fromCalls.push(table);
      if (extraTables && extraTables[table]) {
        return extraTables[table]();
      }
      const chain = {
        select: function () {
          return chain;
        },
        eq: function () {
          return chain;
        },
        in: function () {
          return chain;
        },
        order: function () {
          return chain;
        },
        limit: function () {
          return chain;
        },
        maybeSingle: async function () {
          return { data: null, error: null };
        },
        then: function (resolve, reject) {
          let data = [];
          if (table === 'cz_funnel_encuestas') data = [];
          if (table === 'email_campaign_recipients') data = [];
          return Promise.resolve({ data: data, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

(async function main() {
  // --- >1000 solicitudes: truncated table vs bundle ---
  const highCi = 46068622;
  const highCz = 2165;
  const fillerCount = PAGE_SIZE + 50;
  const truncatedSolicitudes = [];
  for (let i = 0; i < PAGE_SIZE; i += 1) {
    truncatedSolicitudes.push(makeSolicitud(1000 + i, 30000000 + i));
  }
  assert.strictEqual(
    truncatedSolicitudes.some(function (s) {
      return Number(s.cz_id) === highCz;
    }),
    false,
    'fixture: high cz not in first 1000 solicitudes',
  );

  const bundleSolicitudes = truncatedSolicitudes.concat([
    makeSolicitud(highCz, highCi),
  ]);
  const bundleEstados = [makeEstado(highCz, T0)];

  assert.strictEqual(
    resolveCurrentLastRejectionForCi(bundleEstados, truncatedSolicitudes, highCi),
    null,
    'without episode solicitud, last rejection is null',
  );
  assert.ok(
    resolveCurrentLastRejectionForCi(bundleEstados, bundleSolicitudes, highCi),
    'bundle includes high cz solicitud',
  );

  const sbNoTableScan = stubSupabaseForAttach();
  const rowsBundled = await attachSurveyInviteToListRows(
    sbNoTableScan,
    [listRow(highCi, highCz)],
    {
      now: NOW,
      estadoRows: bundleEstados,
      solicitudRows: bundleSolicitudes,
      loadElmBlocks: async function () {
        return new Map();
      },
      sleep: async function () {},
      suppressionRetryAttempts: 1,
    },
  );
  assert.strictEqual(rowsBundled.length, 1);
  assert.notStrictEqual(
    rowsBundled[0].survey_invite.reason,
    REASONS.NO_CURRENT_REJECTION,
    'bundle path must resolve last rejection (not no_current_rejection)',
  );
  assert.ok(
    !sbNoTableScan.fromCalls.includes('cz_funnel_solicitudes'),
    'must not re-fetch solicitudes when bundle passed',
  );
  assert.ok(
    !sbNoTableScan.fromCalls.includes('cz_funnel_solicitud_estados'),
    'must not re-fetch estados when bundle passed',
  );

  // --- Paginated fallback uses .range past 1000 ---
  const allSolicitudes = [];
  for (let i = 0; i < fillerCount; i += 1) {
    allSolicitudes.push(makeSolicitud(i + 1, 40000000 + i));
  }
  allSolicitudes.push(makeSolicitud(highCz, highCi));
  const allEstados = [makeEstado(highCz, T0)];
  let rangeCalls = 0;
  const sbPaged = {
    from: function (table) {
      return {
        select: function () {
          return this;
        },
        eq: function () {
          return this;
        },
        order: function () {
          return this;
        },
        range: async function (from, to) {
          rangeCalls += 1;
          const size = to - from + 1;
          if (table === 'cz_funnel_solicitudes') {
            const slice = allSolicitudes.slice(from, from + size);
            return { data: slice, error: null };
          }
          if (table === 'cz_funnel_solicitud_estados') {
            return { data: allEstados, error: null };
          }
          return { data: [], error: null };
        },
      };
    },
  };
  const loaded = await fetchSurveyInviteListContextFromSupabase(sbPaged);
  assert.ok(
    loaded.solicitudRows.some(function (s) {
      return Number(s.cz_id) === highCz;
    }),
    'paginated fetch must return solicitud beyond row 1000',
  );
  assert.ok(rangeCalls >= 2, 'paginated solicitudes fetch uses multiple range calls');

  assert.throws(function () {
    assertSurveyInviteBundleContext({
      estadoRows: [],
      solicitudRows: [{ cz_id: 1, ci: 2, nombre: 'x' }],
    });
  }, /email/);

  console.log('unit-rejected-survey-invite-list-bundle: OK');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
