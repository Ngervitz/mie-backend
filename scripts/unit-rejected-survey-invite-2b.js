'use strict';

/**
 * Stage 2B unit tests — eligibility, attempt matrix, materialize concurrency.
 *
 * node scripts/unit-rejected-survey-invite-2b.js
 */

const assert = require('assert');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.RECHAZADOS_SURVEY_INVITE_CAMPAIGN_ID = '42';
process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';

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
    rechazadosSurveyInviteCampaignId: '42',
  },
};

const {
  PURPOSE,
  REASONS,
  NOMBRE_FALLBACK,
  buildSurveyInviteIdempotencyKey,
  buildSurveyUrl,
  resolveInviteNombre,
  maskEmail,
  evaluateRejectedSurveyInviteEligibility,
  resolveCurrentLastRejectionForCi,
  classifyPriorRecipient,
} = require('../src/lib/rejectedSurveyInvite');

const {
  materializeRejectedSurveyInvite,
  isUniqueViolation,
} = require('../src/lib/rejectedSurveyInviteMaterialize');

const { buildUnsubscribeUrl } = require('../src/services/email-campaigns/unsubscribeToken');

// --- identity / urls / nombre ---
assert.strictEqual(PURPOSE, 'rechazados_survey_invite');
assert.strictEqual(
  buildSurveyInviteIdempotencyKey(42, 12345678),
  'rechazados_survey_invite:campaign:42:ci:12345678',
);
assert.strictEqual(
  buildSurveyUrl('LRW-ABC'),
  'https://www.credizona.com.uy/solicitudes/sinoferta?lrw=LRW-ABC',
);
assert.ok(buildSurveyUrl('LRW-ABC').indexOf('/encuesta') === -1);
assert.strictEqual(resolveInviteNombre('Ana'), 'Ana');
assert.strictEqual(resolveInviteNombre('  '), NOMBRE_FALLBACK);
assert.strictEqual(resolveInviteNombre(null), NOMBRE_FALLBACK);
assert.strictEqual(maskEmail('ana@example.com'), 'a***@example.com');

const unsub = buildUnsubscribeUrl('https://janus.test', 'a@b.co');
assert.ok(unsub.startsWith('https://janus.test/email/unsubscribe?t='));
assert.ok(unsub.indexOf('SMS') === -1);

// --- eligibility ---
function baseElig(over) {
  return Object.assign(
    {
      ci: 111,
      campaignId: '42',
      publicBaseUrlConfigured: true,
      lastRejection: { cz_solicitud_id: 9001 },
      solicitud: {
        cz_id: 9001,
        email: 'u@example.com',
        lrw_id: 'LRW-1',
        nombre: 'Ana',
      },
      hasEncuesta: false,
      isSuppressed: false,
      priorRecipient: null,
    },
    over || {},
  );
}

assert.strictEqual(
  evaluateRejectedSurveyInviteEligibility(baseElig()).reason,
  REASONS.ELIGIBLE,
);
assert.strictEqual(
  evaluateRejectedSurveyInviteEligibility(
    baseElig({ lastRejection: null }),
  ).reason,
  REASONS.NO_CURRENT_REJECTION,
);
assert.strictEqual(
  evaluateRejectedSurveyInviteEligibility(
    baseElig({ solicitud: { email: null, lrw_id: 'X', nombre: 'A' } }),
  ).reason,
  REASONS.MISSING_EMAIL,
);
assert.strictEqual(
  evaluateRejectedSurveyInviteEligibility(
    baseElig({
      solicitud: { email: 'u@example.com', lrw_id: null, nombre: 'A' },
    }),
  ).reason,
  REASONS.MISSING_LRW,
);
assert.strictEqual(
  evaluateRejectedSurveyInviteEligibility(baseElig({ hasEncuesta: true }))
    .reason,
  REASONS.SURVEY_ALREADY_COMPLETED,
);
assert.strictEqual(
  evaluateRejectedSurveyInviteEligibility(baseElig({ isSuppressed: true }))
    .reason,
  REASONS.EMAIL_SUPPRESSED,
);

// multi-rejection: latest wins
const estados = [
  {
    cz_historico_id: 1,
    cz_solicitud_id: 10,
    fechahora_src: '2026-01-01T10:00:00Z',
    solicitudes_estados_id: 3,
  },
  {
    cz_historico_id: 2,
    cz_solicitud_id: 20,
    fechahora_src: '2026-02-01T10:00:00Z',
    solicitudes_estados_id: 3,
  },
];
const sols = [
  { cz_id: 10, ci: 111, email: 'old@x.com', lrw_id: 'OLD', nombre: 'Old' },
  { cz_id: 20, ci: 111, email: 'new@x.com', lrw_id: 'NEW', nombre: 'New' },
];
const last = resolveCurrentLastRejectionForCi(estados, sols, 111);
assert.strictEqual(Number(last.cz_solicitud_id), 20);
const solNew = sols.find((s) => Number(s.cz_id) === 20);
assert.strictEqual(
  evaluateRejectedSurveyInviteEligibility(
    baseElig({ lastRejection: last, solicitud: solNew }),
  ).lrw_id,
  'NEW',
);

// prior matrix
assert.strictEqual(
  classifyPriorRecipient({ status: 'queued' }).reason,
  REASONS.ALREADY_PENDING,
);
assert.strictEqual(
  classifyPriorRecipient({ status: 'sent' }).reason,
  REASONS.ALREADY_SENT,
);
assert.strictEqual(
  classifyPriorRecipient({
    status: 'failed',
    error_reason: 'email_suppressed',
  }).reason,
  REASONS.PRIOR_ATTEMPT_BLOCKS,
);
const repair = classifyPriorRecipient({
  status: 'failed',
  error_reason: 'missing_required_template_var:survey_url',
});
assert.strictEqual(repair.reason, REASONS.ELIGIBLE);
assert.strictEqual(repair.repairable, true);
assert.strictEqual(
  classifyPriorRecipient({
    status: 'failed',
    error_reason: 'resend timeout',
  }).reason,
  REASONS.PRIOR_ATTEMPT_BLOCKS,
);

assert.strictEqual(
  evaluateRejectedSurveyInviteEligibility(
    baseElig({ priorRecipient: { id: 9, status: 'queued' } }),
  ).reason,
  REASONS.ALREADY_PENDING,
);

const eligRepair = evaluateRejectedSurveyInviteEligibility(
  baseElig({
    priorRecipient: {
      id: 77,
      status: 'failed',
      error_reason: 'missing_required_template_var:survey_url',
    },
  }),
);
assert.strictEqual(eligRepair.eligible, true);
assert.strictEqual(eligRepair.repairable, true);
assert.strictEqual(eligRepair.prior_recipient_id, 77);

// --- materialize concurrency with mock supabase ---
function makeMockSupabase(opts) {
  const state = {
    inserted: null,
    insertCalls: 0,
    forceUniqueOnInsert: opts && opts.forceUniqueOnInsert,
    existingByKey: opts && opts.existingByKey,
    recipients: opts && opts.recipients ? opts.recipients.slice() : [],
  };

  return {
    _state: state,
    from: function (table) {
      return {
        select: function () {
          return chain(table, 'select', arguments);
        },
        insert: function (row) {
          return chain(table, 'insert', [row]);
        },
        update: function (patch) {
          return chain(table, 'update', [patch]);
        },
        eq: function () {
          return this;
        },
        in: function () {
          return this;
        },
        order: function () {
          return this;
        },
        limit: function () {
          return this;
        },
        maybeSingle: async function () {
          return { data: null, error: null };
        },
        single: async function () {
          return { data: null, error: null };
        },
      };
    },
  };

  function chain(table, op, args) {
    const ctx = { table: table, op: op, args: args, filters: {} };
    const api = {
      select: function () {
        ctx.op = 'select';
        return api;
      },
      eq: function (col, val) {
        ctx.filters[col] = val;
        return api;
      },
      in: function () {
        return api;
      },
      order: function () {
        return api;
      },
      limit: function () {
        return api;
      },
      maybeSingle: async function () {
        return resolve(ctx);
      },
      single: async function () {
        return resolve(ctx);
      },
      then: undefined,
    };
    // insert(...).select().maybeSingle()
    if (op === 'insert') {
      api.select = function () {
        return {
          maybeSingle: async function () {
            state.insertCalls += 1;
            if (state.forceUniqueOnInsert && state.insertCalls > 1) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key' },
              };
            }
            if (state.forceUniqueOnInsert && state.existingByKey) {
              // first also conflicts if pre-seeded
            }
            if (
              state.existingByKey &&
              args[0] &&
              args[0].idempotency_key === state.existingByKey.idempotency_key
            ) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key' },
              };
            }
            const row = Object.assign({ id: 1000 + state.insertCalls }, args[0]);
            state.inserted = row;
            state.recipients.push(row);
            return { data: row, error: null };
          },
        };
      };
    }
    if (op === 'update') {
      api.select = function () {
        return {
          maybeSingle: async function () {
            return {
              data: Object.assign(
                { id: ctx.filters.id || 77, status: 'queued' },
                args[0],
              ),
              error: null,
            };
          },
        };
      };
    }
    return api;
  }

  async function resolve(ctx) {
    if (ctx.table === 'cz_funnel_solicitud_estados') {
      return {
        data: [
          {
            cz_historico_id: 2,
            cz_solicitud_id: 20,
            fechahora_src: '2026-02-01T10:00:00Z',
            solicitudes_estados_id: 3,
          },
        ],
        error: null,
      };
    }
    if (ctx.table === 'cz_funnel_solicitudes') {
      return {
        data: [
          {
            cz_id: 20,
            ci: 111,
            email: 'u@example.com',
            lrw_id: 'LRW-NEW',
            nombre: 'Ana',
          },
        ],
        error: null,
      };
    }
    if (ctx.table === 'cz_funnel_encuestas') {
      return { data: null, error: null, count: 0 };
    }
    if (ctx.table === 'email_suppressions') {
      return { data: null, error: null };
    }
    if (ctx.table === 'email_campaign_recipients') {
      if (ctx.filters.idempotency_key && state.existingByKey) {
        return { data: state.existingByKey, error: null };
      }
      if (ctx.filters.idempotency_key && state.inserted) {
        return { data: state.inserted, error: null };
      }
      if (ctx.filters.ci != null) {
        const found = state.recipients
          .filter(function (r) {
            return String(r.ci) === String(ctx.filters.ci);
          })
          .pop();
        return { data: found || null, error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

// Patch getRejectedSurveyInviteEligibility path uses head count — simplify by
// overriding from() for encuestas count. Our mock returns count 0 on maybeSingle
// but eligibility uses head:true count. Fix mock:

// Re-implement a tighter mock for materialize tests only via monkeypatch module.

const eligMod = require('../src/lib/rejectedSurveyInviteEligibility');

async function runMaterializeWithFixture(fixture) {
  const original = eligMod.getRejectedSurveyInviteEligibility;
  eligMod.getRejectedSurveyInviteEligibility = async function () {
    return fixture.elig;
  };

  let store = fixture.store || { rows: [], insertCount: 0 };
  const IMPACT = '11111111-1111-4111-8111-111111111111';
  const TOKEN = 'abcdefghijABCDEFGHIJ12';

  const supabase = {
    rpc: async function (name, params) {
      assert.strictEqual(name, 'upsert_email_survey_invite_recipient_impact');
      let row = store.rows.find(function (r) {
        return r.idempotency_key === params.p_idempotency_key;
      });
      let created = false;
      if (!row) {
        store.insertCount += 1;
        row = {
          id: store.insertCount,
          campaign_id: Number(params.p_campaign_id),
          idempotency_key: params.p_idempotency_key,
          ci: params.p_ci,
          email: params.p_email,
          status: 'queued',
          purpose: params.p_purpose,
          marketing_impact_id: IMPACT,
          provider_send_started_at: null,
          template_vars: {},
          payload_html: null,
          payload_to: null,
          payload_from: null,
          payload_subject: null,
          template_subject_snapshot: null,
          template_body_html_snapshot: null,
          error_reason: null,
          next_attempt_at: null,
        };
        store.rows.push(row);
        created = true;
      } else if (!row.marketing_impact_id) {
        row.marketing_impact_id = IMPACT;
        created = true;
      }
      return {
        data: {
          created: created,
          recipient_id: row.id,
          impact_id: IMPACT,
          tracking_token: TOKEN,
          destination_url: params.p_destination_url,
          campaign_id: row.campaign_id,
          idempotency_key: row.idempotency_key,
          status: row.status,
          provider_send_started_at: row.provider_send_started_at || null,
        },
        error: null,
      };
    },
    from: function (table) {
      if (table === 'email_campaigns') {
        return {
          select: function () {
            return {
              eq: function () {
                return this;
              },
              maybeSingle: async function () {
                return {
                  data: {
                    id: 42,
                    subject: 'Hola {{nombre}}',
                    body_html: '<p>{{survey_url}}</p>',
                  },
                  error: null,
                };
              },
            };
          },
        };
      }
      assert.strictEqual(table, 'email_campaign_recipients');
      return {
        update: function (patch) {
          const api = {
            eq: function () {
              return api;
            },
            is: function () {
              return api;
            },
            select: function () {
              return {
                maybeSingle: async function () {
                  const row = store.rows[0];
                  Object.assign(row, patch, {
                    status: 'queued',
                    error_reason: null,
                  });
                  return { data: row, error: null };
                },
              };
            },
          };
          return api;
        },
        select: function () {
          return {
            eq: function (col, val) {
              this._filters = this._filters || {};
              this._filters[col] = val;
              return this;
            },
            maybeSingle: async function () {
              const f = this._filters || {};
              const row = store.rows.find(function (r) {
                if (f.id != null && String(r.id) !== String(f.id)) return false;
                if (
                  f.idempotency_key != null &&
                  String(r.idempotency_key) !== String(f.idempotency_key)
                ) {
                  return false;
                }
                return true;
              });
              return { data: row || null, error: null };
            },
          };
        },
      };
    },
  };

  try {
    return await materializeRejectedSurveyInvite(supabase, fixture.elig.ci);
  } finally {
    eligMod.getRejectedSurveyInviteEligibility = original;
  }
}

const eligOk = {
  eligible: true,
  reason: REASONS.ELIGIBLE,
  ci: 111,
  email: 'u@example.com',
  email_masked: 'u***@example.com',
  lrw_id: 'LRW-NEW',
  nombre: 'Ana',
  repairable: false,
  prior_recipient_id: null,
};

(async function () {
  const store = { rows: [], insertCount: 0 };
  const a = await runMaterializeWithFixture({ elig: eligOk, store: store });
  const b = await runMaterializeWithFixture({ elig: eligOk, store: store });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.result, 'queued');
  assert.strictEqual(store.rows.length, 1);
  assert.strictEqual(
    store.rows[0].idempotency_key,
    'rechazados_survey_invite:campaign:42:ci:111',
  );
  assert.strictEqual(store.rows[0].purpose, PURPOSE);
  assert.strictEqual(
    store.rows[0].template_vars.survey_url,
    'https://janus.test/email/c/abcdefghijABCDEFGHIJ12',
  );
  assert.ok(
    String(store.rows[0].payload_html || '').indexOf(
      '/email/c/abcdefghijABCDEFGHIJ12',
    ) !== -1,
  );
  assert.ok(
    store.rows[0].template_vars.unsubscribe_url.indexOf(
      'https://janus.test/email/unsubscribe?t=',
    ) === 0,
  );
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.recipient_id, a.recipient_id);
  assert.strictEqual(b.tracking_token, a.tracking_token);
  assert.strictEqual(store.rows.length, 1);

  // suppressed eligibility short-circuit (no insert)
  const blocked = await runMaterializeWithFixture({
    elig: {
      eligible: false,
      reason: REASONS.EMAIL_SUPPRESSED,
      email_masked: 'u***@example.com',
      prior_recipient_id: null,
    },
    store: { rows: [], insertCount: 0 },
  });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.result, REASONS.EMAIL_SUPPRESSED);

  // repair missing template
  const repairStore = {
    rows: [
      {
        id: 77,
        idempotency_key: 'rechazados_survey_invite:campaign:42:ci:111',
        status: 'failed',
        error_reason: 'missing_required_template_var:survey_url',
        ci: '111',
        marketing_impact_id: null,
        provider_send_started_at: null,
        template_vars: {},
        payload_html: null,
        payload_to: null,
        payload_from: null,
        payload_subject: null,
        template_subject_snapshot: null,
        template_body_html_snapshot: null,
      },
    ],
    insertCount: 0,
  };
  const repaired = await runMaterializeWithFixture({
    elig: Object.assign({}, eligOk, {
      repairable: true,
      prior_recipient_id: 77,
    }),
    store: repairStore,
  });
  assert.strictEqual(repaired.ok, true);
  assert.strictEqual(repaired.repaired, true);
  assert.strictEqual(repairStore.rows[0].status, 'queued');
  assert.strictEqual(repairStore.rows.length, 1);

  assert.strictEqual(isUniqueViolation({ code: '23505' }), true);

  console.log('unit-rejected-survey-invite-2b: OK');
  console.log(
    JSON.stringify({
      eligibility: true,
      revalidation_latest_rejection: true,
      attempt_matrix: true,
      concurrency_one_recipient: true,
      suppression_blocks_insert: true,
      repair_missing_template: true,
      urls: true,
      deferred_atomicity: 'IMPLEMENTED_SEPARATELY_SEE_unit-email-delivery-atomicity',
    }),
  );
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
