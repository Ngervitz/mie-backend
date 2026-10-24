'use strict';

/**
 * Encuesta lookups in rechazados_survey_invite_due stay in ID_CHUNK batches.
 * Run: node scripts/unit-rejected-survey-invite-due-encuesta-chunks.js
 *
 * materializeFn only records. It does not write recipients or send email.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const { ID_CHUNK, runRechazadosSurveyInviteDue } = require('../src/jobs/rechazadosSurveyInviteDue');

const NOW = new Date('2026-10-20T18:00:00.000Z');
const T0 = '2026-10-20T12:00:00.000Z';
const URL_BUDGET = 8000;

function emailOf(ci) {
  return 'ci' + ci + '@example.com';
}

function encodedEncuestaPathLength(cis) {
  const body = (cis || [])
    .map(function (ci) {
      return String(ci);
    })
    .join('%2C');
  const prefix = '/rest/v1/cz_funnel_encuestas?select=ci&ci=in.%28';
  return prefix.length + body.length + '%29'.length;
}

/**
 * Single-query oracle: CIs the old unchunked `.in('ci', all)` would return.
 * @param {Array<{ ci: number }>} encuestaRows
 * @param {number[]} candidateCis
 */
function oracleEncuestaCis(encuestaRows, candidateCis) {
  const allow = new Set(
    (candidateCis || []).map(function (ci) {
      return Number(ci);
    }),
  );
  const out = new Set();
  for (let i = 0; i < (encuestaRows || []).length; i += 1) {
    const ci = Number(encuestaRows[i] && encuestaRows[i].ci);
    if (allow.has(ci)) out.add(ci);
  }
  return out;
}

function buildCohort(count, encuestaCi) {
  const estados = [];
  const solicitudes = [];
  const cis = [];
  for (let n = 0; n < count; n += 1) {
    const ci = 30000001 + n;
    cis.push(ci);
    estados.push({
      cz_historico_id: n + 1,
      cz_solicitud_id: n + 1,
      fechahora_src: T0,
      solicitudes_estados_id: 3,
    });
    solicitudes.push({
      cz_id: n + 1,
      ci: ci,
      email: emailOf(ci),
      lrw_id: 'LRW-' + ci,
      nombre: 'N' + ci,
    });
  }
  const encuestas = [];
  if (encuestaCi != null) {
    encuestas.push({ ci: encuestaCi });
    encuestas.push({ ci: encuestaCi });
  }
  return {
    cis: cis,
    tables: {
      cz_funnel_solicitud_estados: estados,
      cz_funnel_solicitudes: solicitudes,
      cz_funnel_encuestas: encuestas,
      email_suppressions: [],
      email_campaign_recipients: [],
    },
  };
}

function clientFor(tables, opts) {
  const options = opts || {};
  const encuestaInCalls = [];
  let encuestaQueries = 0;
  let elmCalls = 0;
  return {
    encuestaInCalls: encuestaInCalls,
    elmCalls: function () {
      return elmCalls;
    },
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
          if (table === 'cz_funnel_encuestas' && col === 'ci') {
            encuestaInCalls.push(vals.slice());
          }
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
          if (table === 'cz_funnel_encuestas') {
            encuestaQueries += 1;
            if (options.failOnEncuestaQuery === encuestaQueries) {
              return Promise.resolve({
                data: null,
                error: {
                  message: 'TypeError: fetch failed',
                  hint: 'HTTP headers exceeded server limits (typically 16KB)',
                },
              }).then(resolve, reject);
            }
          }
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
          if (table === 'cz_funnel_encuestas' && options.repeatEncuestaOnEveryBatch) {
            for (let i = 0; i < rows.length; i += 1) {
              list.push(rows[i]);
            }
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
          return Promise.resolve({ data: list, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
    loadElm: async function () {
      elmCalls += 1;
      return new Map();
    },
  };
}

async function runCohort(count, encuestaCi, opts) {
  const cohort = buildCohort(count, encuestaCi);
  const sb = clientFor(cohort.tables, opts);
  const materialized = [];
  const out = await runRechazadosSurveyInviteDue({
    skipLock: true,
    now: NOW,
    supabase: sb,
    loadElmBlocks: sb.loadElm,
    materializeFn: async function (_client, ci, campaignId) {
      materialized.push({ ci: Number(ci), campaignId: String(campaignId) });
      return { ok: true, result: 'queued' };
    },
  });
  return { cohort: cohort, sb: sb, materialized: materialized, out: out };
}

function assertSameAsSingleQuery(result, encuestaCi) {
  const oracle = oracleEncuestaCis(result.cohort.tables.cz_funnel_encuestas, result.cohort.cis);
  assert.strictEqual(oracle.size, encuestaCi == null ? 0 : 1);
  if (encuestaCi != null) assert.ok(oracle.has(encuestaCi));
  assert.strictEqual(result.out.survey_completed, oracle.size);
  assert.strictEqual(result.out.materialized_step1, result.cohort.cis.length - oracle.size);
  assert.strictEqual(result.out.errors, 0);
  const seen = new Set();
  for (let i = 0; i < result.materialized.length; i += 1) {
    const ci = result.materialized[i].ci;
    assert.ok(!oracle.has(ci), 'completed survey must not materialize');
    assert.ok(!seen.has(ci), 'materialize duplicate ' + ci);
    seen.add(ci);
    assert.strictEqual(result.materialized[i].campaignId, '101');
  }
  assert.strictEqual(seen.size, result.cohort.cis.length - oracle.size);
}

(async function main() {
  assert.strictEqual(ID_CHUNK, 200);

  const small = await runCohort(3, 30000001, null);
  assert.strictEqual(small.sb.encuestaInCalls.length, 1);
  assert.deepStrictEqual(small.sb.encuestaInCalls[0], small.cohort.cis);
  assertSameAsSingleQuery(small, 30000001);
  assert.ok(encodedEncuestaPathLength(small.sb.encuestaInCalls[0]) < URL_BUDGET);

  const large = await runCohort(1401, 30000001, {
    repeatEncuestaOnEveryBatch: true,
  });
  assert.ok(large.cohort.cis.length > 1400);
  assert.strictEqual(large.sb.encuestaInCalls.length, 8);
  const requested = new Set();
  for (let i = 0; i < large.sb.encuestaInCalls.length; i += 1) {
    const batch = large.sb.encuestaInCalls[i];
    assert.ok(batch.length > 0 && batch.length <= ID_CHUNK);
    assert.ok(encodedEncuestaPathLength(batch) < URL_BUDGET);
    for (let c = 0; c < batch.length; c += 1) {
      assert.ok(!requested.has(batch[c]), 'CI repeated across batches');
      requested.add(batch[c]);
    }
  }
  assert.strictEqual(requested.size, 1401);
  assertSameAsSingleQuery(large, 30000001);
  assert.strictEqual(large.out.candidates, 1401);

  const failingCohort = buildCohort(401, 30000001);
  const failingSb = clientFor(failingCohort.tables, { failOnEncuestaQuery: 2 });
  const failingMaterialized = [];
  const stderr = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function (chunk) {
    stderr.push(String(chunk));
    return true;
  };
  let thrown = null;
  try {
    await runRechazadosSurveyInviteDue({
      skipLock: true,
      now: NOW,
      supabase: failingSb,
      loadElmBlocks: failingSb.loadElm,
      materializeFn: async function (_client, ci) {
        failingMaterialized.push(Number(ci));
        return { ok: true, result: 'queued' };
      },
    });
  } catch (err) {
    thrown = err;
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(thrown, 'a failed batch must throw');
  assert.strictEqual(thrown.message, 'job encuestas: TypeError: fetch failed');
  assert.strictEqual(
    thrown.hint,
    'HTTP headers exceeded server limits (typically 16KB)',
  );
  assert.strictEqual(failingMaterialized.length, 0);
  assert.strictEqual(failingSb.elmCalls(), 0);
  assert.strictEqual(failingSb.encuestaInCalls.length, 2);
  const logged = stderr.join('');
  assert.ok(logged.includes('"error":"TypeError: fetch failed"'));
  assert.ok(
    logged.includes(
      '"hint":"HTTP headers exceeded server limits (typically 16KB)"',
    ),
  );

  const routeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'jobs.js'),
    'utf8',
  );
  const marker = routeSrc.indexOf("logger.error('rechazados_survey_invite_due failed'");
  assert.ok(marker !== -1);
  const routeLog = routeSrc.slice(marker, marker + 280);
  assert.ok(routeLog.includes('error:'));
  assert.ok(routeLog.includes('hint:'));

  console.log('unit-rejected-survey-invite-due-encuesta-chunks: ok');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
