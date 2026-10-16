'use strict';

/**
 * Incident fix: chunked email_suppressions reads + transient retry + dashboard fail-soft.
 * Run: node scripts/unit-email-suppressions-chunk-retry.js
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
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
  EMAIL_IN_CHUNK,
  SUPPRESSIONS_UNAVAILABLE,
  isTransientSuppressionError,
  isNonTransientSuppressionError,
  loadEmailSuppressionsByEmails,
  unavailableSurveyInvite,
} = require('../src/lib/emailSuppressionsRead');
const { REASONS } = require('../src/lib/rejectedSurveyInvite');
const {
  attachSurveyInviteToListRows,
} = require('../src/lib/rejectedSurveyInviteEligibility');
const {
  runRechazadosSurveyInviteDue,
} = require('../src/jobs/rechazadosSurveyInviteDue');
const H = require('../public/rechazados-helpers');

assert.strictEqual(EMAIL_IN_CHUNK, 100);
assert.strictEqual(REASONS.SUPPRESSIONS_UNAVAILABLE, SUPPRESSIONS_UNAVAILABLE);
assert.strictEqual(unavailableSurveyInvite().eligible, false);
assert.strictEqual(unavailableSurveyInvite().available, false);

assert.strictEqual(
  isTransientSuppressionError({ message: 'TypeError: fetch failed' }),
  true,
);
assert.strictEqual(
  isTransientSuppressionError(
    Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }),
  ),
  true,
);
assert.strictEqual(
  isTransientSuppressionError({
    message: 'DNS resolution error | usezztlmwfgjcidcrrde.supabase.co | Cloudflare Error 1001',
  }),
  true,
);
assert.strictEqual(
  isTransientSuppressionError({ code: 'PGRST116', message: 'JSON object requested' }),
  false,
);
assert.strictEqual(
  isNonTransientSuppressionError({
    code: '42501',
    message: 'permission denied for table email_suppressions',
  }),
  true,
);
assert.strictEqual(
  isTransientSuppressionError({
    code: '42501',
    message: 'permission denied for table email_suppressions',
  }),
  false,
);

function fetchFailed() {
  return { message: 'TypeError: fetch failed' };
}

function makeInClient(handler) {
  const calls = [];
  return {
    calls: calls,
    from: function (table) {
      assert.strictEqual(table, 'email_suppressions');
      return {
        select: function () {
          return {
            in: async function (col, vals) {
              calls.push({ col: col, vals: vals.slice() });
              return handler(calls.length, vals);
            },
          };
        },
      };
    },
  };
}

(async function main() {
  const sleepNoop = async function () {
    return undefined;
  };

  // --- Multiple chunks ---
  {
    const emails = [];
    for (let i = 0; i < 250; i += 1) emails.push('u' + i + '@example.com');
    const sb = makeInClient(async function (_n, vals) {
      return { data: [{ email: vals[0] }], error: null };
    });
    const out = await loadEmailSuppressionsByEmails(sb, emails, {
      chunkSize: 100,
      retryAttempts: 1,
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(sb.calls.length, 3);
    assert.strictEqual(sb.calls[0].vals.length, 100);
    assert.strictEqual(sb.calls[1].vals.length, 100);
    assert.strictEqual(sb.calls[2].vals.length, 50);
    assert.strictEqual(out.emails.size, 3);
    assert.ok(out.emails.has('u0@example.com'));
    assert.ok(out.emails.has('u100@example.com'));
    assert.ok(out.emails.has('u200@example.com'));
  }

  // --- Transient recovered (one chunk, first fetch failed) ---
  {
    const sb = makeInClient(async function (n) {
      if (n === 1) return { data: null, error: fetchFailed() };
      return { data: [{ email: 'held@example.com' }], error: null };
    });
    const out = await loadEmailSuppressionsByEmails(sb, ['held@example.com'], {
      retryAttempts: 3,
      retryDelayMs: 1,
      sleep: sleepNoop,
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(sb.calls.length, 2);
    assert.ok(out.emails.has('held@example.com'));
  }

  // --- SQL/auth is not retried ---
  {
    const sb = makeInClient(async function () {
      return {
        data: null,
        error: { code: '42501', message: 'permission denied' },
      };
    });
    const out = await loadEmailSuppressionsByEmails(sb, ['a@example.com'], {
      retryAttempts: 3,
      retryDelayMs: 1,
      sleep: sleepNoop,
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(sb.calls.length, 1);
    assert.strictEqual(out.emails.size, 0);
  }

  const T0 = '2026-01-01T00:00:00.000Z';
  const NOW = new Date('2026-01-02T12:00:00.000Z');

  function listRow(ci, czId, email) {
    return {
      ci: ci,
      cz_solicitud_id: czId,
      nombre: 'Ana',
      apellido: 'Perez',
      rejected_at: T0,
    };
  }

  function listSb(opts) {
    const o = opts || {};
    const inCalls = [];
    return {
      inCalls: inCalls,
      from: function (table) {
        if (table === 'email_suppressions') {
          return {
            select: function () {
              return {
                in: async function (_col, vals) {
                  inCalls.push(vals.slice());
                  if (typeof o.suppressions === 'function') {
                    return o.suppressions(inCalls.length, vals);
                  }
                  return {
                    data: o.suppressedEmails || [],
                    error: o.suppressionError || null,
                  };
                },
              };
            },
          };
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
          is: function () {
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
            if (table === 'cz_funnel_solicitudes') {
              data = o.solicitudes || [];
            } else if (table === 'cz_funnel_solicitud_estados') {
              data = o.estados || [];
            } else if (table === 'cz_funnel_encuestas') {
              data = o.encuestas || [];
            }
            return Promise.resolve({ data: data, error: null }).then(
              resolve,
              reject,
            );
          },
        };
        return chain;
      },
    };
  }

  const oneSol = {
    solicitudes: [
      {
        cz_id: 10,
        ci: 111,
        email: 'lead@example.com',
        lrw_id: 'LRW1',
        nombre: 'Ana',
      },
    ],
    estados: [
      {
        cz_historico_id: 1,
        cz_solicitud_id: 10,
        fechahora_src: T0,
        solicitudes_estados_id: 3,
      },
    ],
  };

  // --- Exclusions respected on list path ---
  {
    const sb = listSb(
      Object.assign({}, oneSol, {
        suppressedEmails: [{ email: 'lead@example.com' }],
      }),
    );
    const rows = await attachSurveyInviteToListRows(
      sb,
      [listRow(111, 10, 'lead@example.com')],
      { now: NOW, sleep: sleepNoop, suppressionRetryAttempts: 1 },
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].survey_invite.available, true);
    assert.strictEqual(rows[0].survey_invite.eligible, false);
    assert.strictEqual(rows[0].survey_invite.reason, REASONS.EMAIL_SUPPRESSED);
    const cell = H.surveyInviteCell(rows[0].survey_invite);
    assert.notStrictEqual(cell.action, 'survey-invite');
    assert.notStrictEqual(cell.enabled, true);
  }

  // --- Dashboard definitive fail: list stays up, eligibility unknown, no send CTA ---
  {
    const sb = listSb(
      Object.assign({}, oneSol, {
        suppressionError: fetchFailed(),
      }),
    );
    const rows = await attachSurveyInviteToListRows(
      sb,
      [listRow(111, 10, 'lead@example.com')],
      {
        now: NOW,
        sleep: sleepNoop,
        suppressionRetryAttempts: 1,
      },
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ci, 111);
    assert.strictEqual(rows[0].survey_invite.available, false);
    assert.strictEqual(rows[0].survey_invite.eligible, false);
    assert.strictEqual(
      rows[0].survey_invite.reason,
      REASONS.SUPPRESSIONS_UNAVAILABLE,
    );
    const cell = H.surveyInviteCell(rows[0].survey_invite);
    assert.strictEqual(cell.kind, 'text');
    assert.strictEqual(cell.label, 'N/D');
    assert.ok(!cell.action);
    assert.ok(cell.enabled !== true);
    const spoofed = H.surveyInviteCell({
      available: false,
      eligible: true,
      reason: REASONS.ELIGIBLE,
    });
    assert.ok(!spoofed.action);
    assert.notStrictEqual(spoofed.enabled, true);
  }

  // --- Dashboard unknown must not look like "no exclusions" ---
  {
    const sb = listSb(
      Object.assign({}, oneSol, {
        suppressionError: fetchFailed(),
      }),
    );
    const rows = await attachSurveyInviteToListRows(
      sb,
      [listRow(111, 10, 'lead@example.com')],
      { now: NOW, suppressionRetryAttempts: 1, sleep: sleepNoop },
    );
    assert.notStrictEqual(rows[0].survey_invite.reason, REASONS.ELIGIBLE);
    assert.strictEqual(rows[0].survey_invite.eligible, false);
  }

  function jobSb(opts) {
    const o = opts || {};
    const inCalls = [];
    return {
      inCalls: inCalls,
      from: function (table) {
        if (table === 'email_suppressions') {
          return {
            select: function () {
              return {
                in: async function (_col, vals) {
                  inCalls.push(vals.slice());
                  if (typeof o.suppressions === 'function') {
                    return o.suppressions(inCalls.length, vals);
                  }
                  return {
                    data: o.suppressedEmails || [],
                    error: o.suppressionError || null,
                  };
                },
              };
            },
          };
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
          is: function () {
            return chain;
          },
          then: function (resolve, reject) {
            let data = [];
            if (table === 'cz_funnel_solicitud_estados') {
              data = o.estados || oneSol.estados;
            } else if (table === 'cz_funnel_solicitudes') {
              data = o.solicitudes || oneSol.solicitudes;
            }
            return Promise.resolve({ data: data, error: null }).then(
              resolve,
              reject,
            );
          },
        };
        return chain;
      },
    };
  }

  const nowDue = new Date('2026-01-02T00:00:00.000Z');

  // --- Cron: exclusions respected, no materialize of suppressed ---
  {
    const materializeCalls = [];
    const sb = jobSb({
      suppressedEmails: [{ email: 'lead@example.com' }],
    });
    const out = await runRechazadosSurveyInviteDue({
      skipLock: true,
      now: nowDue,
      supabase: sb,
      sleep: sleepNoop,
      suppressionRetryAttempts: 1,
      materializeFn: async function () {
        materializeCalls.push(1);
        return { ok: true, result: 'queued' };
      },
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(materializeCalls.length, 0);
    assert.ok(out.suppressed >= 1);
  }

  // --- Cron: transient recovered then materialize ---
  {
    const materializeCalls = [];
    const sb = jobSb({
      suppressions: async function (n) {
        if (n === 1) return { data: null, error: fetchFailed() };
        return { data: [], error: null };
      },
    });
    const out = await runRechazadosSurveyInviteDue({
      skipLock: true,
      now: nowDue,
      supabase: sb,
      sleep: sleepNoop,
      suppressionRetryAttempts: 3,
      suppressionRetryDelayMs: 1,
      materializeFn: async function (_sb, ci, campaignId) {
        materializeCalls.push({ ci: ci, campaignId: campaignId });
        return { ok: true, result: 'queued' };
      },
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(sb.inCalls.length, 2);
    assert.strictEqual(materializeCalls.length, 1);
    assert.strictEqual(Number(materializeCalls[0].ci), 111);
  }

  // --- Cron: definitive fail, no materialize ---
  {
    const materializeCalls = [];
    const sb = jobSb({ suppressionError: fetchFailed() });
    let threw = null;
    try {
      await runRechazadosSurveyInviteDue({
        skipLock: true,
        now: nowDue,
        supabase: sb,
        sleep: sleepNoop,
        suppressionRetryAttempts: 1,
        materializeFn: async function () {
          materializeCalls.push(1);
          return { ok: true, result: 'queued' };
        },
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw);
    assert.ok(/job suppressions: TypeError: fetch failed/.test(threw.message));
    assert.strictEqual(materializeCalls.length, 0);
  }

  // --- GET /rechazados: suppressions fail does not 500 the list ---
  {
    const supabasePath = require.resolve('../src/clients/supabase');
    const orchestratorPath = require.resolve(
      '../src/services/elm/orchestrator',
    );
    require.cache[orchestratorPath] = {
      id: orchestratorPath,
      filename: orchestratorPath,
      loaded: true,
      exports: {
        createElmOrchestrator: function () {
          return {
            getSendReadiness: function () {
              return { ready: false, reasons: ['test'] };
            },
          };
        },
      },
    };

    function emptyChain() {
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
        or: function () {
          return chain;
        },
        is: function () {
          return chain;
        },
        not: function () {
          return chain;
        },
        order: function () {
          return chain;
        },
        limit: function () {
          return chain;
        },
        range: function () {
          return chain;
        },
        maybeSingle: async function () {
          return { data: null, error: null, count: 0 };
        },
        then: function (resolve, reject) {
          return Promise.resolve({ data: [], error: null, count: 0 }).then(
            resolve,
            reject,
          );
        },
      };
      return chain;
    }

    const client = {
      from: function (table) {
        if (table === 'cz_funnel_solicitud_estados') {
          const chain = emptyChain();
          chain.then = function (resolve, reject) {
            return Promise.resolve({
              data: [
                {
                  cz_historico_id: 1,
                  cz_solicitud_id: 10,
                  solicitudes_estados_id: 3,
                  estado: 'Rechazado',
                  fechahora_src: T0,
                },
              ],
              error: null,
            }).then(resolve, reject);
          };
          return chain;
        }
        if (table === 'cz_funnel_solicitudes') {
          const chain = emptyChain();
          chain.then = function (resolve, reject) {
            return Promise.resolve({
              data: [
                {
                  cz_id: 10,
                  ci: 111,
                  nombre: 'Ana',
                  apellido: 'Perez',
                  email: 'lead@example.com',
                  lrw_id: 'LRW1',
                  fecha_reg: T0,
                  solicitudes_estados_id: 3,
                },
              ],
              error: null,
            }).then(resolve, reject);
          };
          return chain;
        }
        if (table === 'email_suppressions') {
          return {
            select: function () {
              return {
                in: async function () {
                  return { data: null, error: fetchFailed() };
                },
              };
            },
          };
        }
        return emptyChain();
      },
    };

    require.cache[supabasePath] = {
      id: supabasePath,
      filename: supabasePath,
      loaded: true,
      exports: client,
    };
    const routePath = require.resolve('../src/routes/rechazados');
    delete require.cache[routePath];
    const router = require('../src/routes/rechazados');

    const app = express();
    app.use('/rechazados', router);
    const server = http.createServer(app);
    const base = await new Promise(function (resolve) {
      server.listen(0, '127.0.0.1', function () {
        resolve('http://127.0.0.1:' + server.address().port);
      });
    });
    try {
      const res = await fetch(base + '/rechazados');
      const json = await res.json();
      assert.strictEqual(res.status, 200, JSON.stringify(json));
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.data.survey_invite_available, false);
      assert.ok(Array.isArray(json.data.rows));
      assert.ok(json.data.rows.length >= 1);
      const invite = json.data.rows[0].survey_invite;
      assert.strictEqual(invite.available, false);
      assert.strictEqual(invite.eligible, false);
      assert.strictEqual(invite.reason, REASONS.SUPPRESSIONS_UNAVAILABLE);
      const cell = H.surveyInviteCell(invite);
      assert.ok(!cell.action);
    } finally {
      await new Promise(function (resolve) {
        server.close(resolve);
      });
    }
  }

  console.log('unit-email-suppressions-chunk-retry: OK');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
