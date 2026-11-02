'use strict';

/**
 * ELM callback-invite V1 unit tests. No production I/O. No real sends.
 * node scripts/unit-elm-callback-invite.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
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
    sessionSecret: 'unit-test-session-secret-0123456789',
    cronSecret: 'unit-test-cron-secret-0123456789',
    emailUnsubscribeHmacSecret: 'test-email-unsubscribe-secret',
    emailPublicBaseUrl: 'https://janus.test',
  },
};

const {
  EMAIL_PURPOSES,
  isValidEmailPurpose,
} = require('../src/services/email-campaigns/purposes');
const { renderOutboundEmail } = require('../src/services/email-campaigns/renderTemplate');
const {
  PURPOSE,
  EVENT_NAME,
  AUTHORIZED_CASES,
  EXCLUDED_CASES,
  TEMPLATE_SUBJECT,
  TEMPLATE_BODY_HTML,
  authorizedCzIds,
  isAuthorizedPair,
  isExcludedPair,
  applyPreparedEmailCorrection,
  isValidEmail,
  buildCallbackConfirmUrl,
  callbackEventExternalId,
  applyCallbackFields,
} = require('../src/lib/elmCallbackInvite');
const { confirmElmCallback, lookupCallbackImpact } = require('../src/lib/elmCallbackConfirm');
const { materializeElmCallbackInviteCampaign } = require('../src/lib/elmCallbackInviteMaterialize');
const { filterOpportunities } = require('../src/services/elmOps/opportunityClassify');
const { createElmOpsService, openProcessView } = require('../src/services/elmOps/service');
const ElmOpsUi = require('../public/elm-ops.js');

const TOKEN = 'abcdefghijABCDEFGHIJ12';
const IMPACT_ID = '11111111-1111-4111-8111-111111111111';
const supabasePath = require.resolve('../src/clients/supabase');

function pass(name) {
  console.log('ok - ' + name);
}

(function allowlist() {
  assert.strictEqual(PURPOSE, 'elm_callback_invite');
  assert.strictEqual(EMAIL_PURPOSES.ELM_CALLBACK_INVITE, PURPOSE);
  assert.strictEqual(isValidEmailPurpose(PURPOSE), true);
  assert.strictEqual(AUTHORIZED_CASES.length, 7);
  assert.deepStrictEqual(authorizedCzIds().sort(), [1168, 1199, 1262, 1362, 1912, 2692, 2716]);
  assert.ok(isAuthorizedPair('18165244', 1912));
  assert.ok(!isAuthorizedPair('64198417', 1375));
  assert.ok(isExcludedPair('64198417', 1375));
  assert.ok(!authorizedCzIds().includes(1375));
  const pairs = AUTHORIZED_CASES.map(function (c) {
    return c.ci + ':' + c.cz_solicitud_id;
  });
  assert.strictEqual(new Set(pairs).size, 7);
  pass('allowlist is exactly the 7 authorized pairs');
})();

(function emailCorrection() {
  const raw = 'cliente.typo@gmail.cm';
  assert.strictEqual(isValidEmail(raw), true, 'typo domain still matches the shape check');
  const hit = applyPreparedEmailCorrection('49698187', 2716, raw);
  assert.strictEqual(hit.corrected, true);
  assert.strictEqual(hit.email, 'cliente.typo@gmail.com');
  assert.strictEqual(hit.source, 'cz_funnel_solicitudes.email');
  const other = applyPreparedEmailCorrection('47690694', 1362, 'x@gmail.cm');
  assert.strictEqual(other.corrected, false);
  assert.strictEqual(other.email, 'x@gmail.cm');
  pass('gmail.cm correction is scoped and preserves local-part');
})();

(function urlsAndRender() {
  const url = buildCallbackConfirmUrl(TOKEN, 'https://janus.test');
  assert.strictEqual(url, 'https://janus.test/email/callback/' + TOKEN);
  assert.ok(url.indexOf('/email/c/') === -1);
  assert.strictEqual(callbackEventExternalId(IMPACT_ID), 'callback_confirmed:' + IMPACT_ID);

  const missing = renderOutboundEmail({
    purpose: PURPOSE,
    subject: TEMPLATE_SUBJECT,
    bodyHtml: TEMPLATE_BODY_HTML,
    templateVars: { unsubscribe_url: 'https://janus.test/email/unsubscribe?t=x' },
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.errorReason, 'missing_required_template_var:callback_url');

  const ok = renderOutboundEmail({
    purpose: PURPOSE,
    subject: TEMPLATE_SUBJECT,
    bodyHtml: TEMPLATE_BODY_HTML,
    templateVars: {
      nombre: 'Ana',
      callback_url: url,
      unsubscribe_url: 'https://janus.test/email/unsubscribe?t=tok',
    },
  });
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.html.indexOf(url) !== -1);
  assert.ok(ok.html.indexOf('/email/c/') === -1);
  assert.ok(ok.html.indexOf('unsubscribe?t=tok') !== -1);
  assert.ok(ok.html.indexOf('QUIERO QUE ME LLAMEN') !== -1);
  assert.ok(ok.subject.indexOf('retomar') !== -1);
  pass('render requires callback_url and does not use /email/c/');
})();

(function overlayAndFilter() {
  const row = applyCallbackFields(
    { cz_solicitud_id: 1912, ci: '18165244', situation: 'followup', lane: 'followup' },
    { phone: '099111222', confirmed_at: '2026-11-02T12:00:00Z' },
  );
  assert.strictEqual(row.callback_requested, true);
  assert.strictEqual(row.callback_phone, '099111222');
  const html = ElmOpsUi.callbackBadgeHtml(row);
  assert.ok(html.indexOf('Pidió llamada') !== -1);
  assert.ok(html.indexOf('099111222') !== -1);
  assert.ok(ElmOpsUi.processRowHtml(row, function (x) { return x || '—'; }, false).indexOf('Pidió llamada') !== -1);

  const items = [
    { cz_solicitud_id: 1, situation: 'followup', lane: 'followup', callback_requested: true, ci: '18165244' },
    { cz_solicitud_id: 2, situation: 'in_evaluation', lane: 'attention', callback_requested: false, ci: '111' },
  ];
  const onlyCb = filterOpportunities(items, { callback_requested: '1' });
  assert.strictEqual(onlyCb.length, 1);
  assert.strictEqual(onlyCb[0].cz_solicitud_id, 1);
  assert.strictEqual(
    ElmOpsUi.opportunityMatches(items[0], '', '', '', 'attention', false),
    true,
    'callback C1 cases stay visible even when the default lane is attention',
  );
  assert.strictEqual(ElmOpsUi.opportunityMatches(items[1], '', '', '', 'attention', false), true);
  assert.strictEqual(ElmOpsUi.opportunityMatches(items[1], '', '', '', 'attention', true), false);
  pass('Operación ELM overlay + Pidió llamada filter');
})();

function chain(result) {
  const api = {
    select: function () { return api; },
    eq: function () { return api; },
    in: function () { return api; },
    not: function () { return api; },
    update: function () { return api; },
    insert: function (row) {
      if (typeof result.insert === 'function') return result.insert(row);
      return Promise.resolve({ data: row, error: null });
    },
    maybeSingle: function () {
      return Promise.resolve(result.maybeSingle || { data: null, error: null });
    },
    then: function (resolve, reject) {
      return Promise.resolve(result.list || { data: [], error: null }).then(resolve, reject);
    },
  };
  return api;
}

(function confirmIdempotent() {
  const events = [];
  const mock = {
    from: function (table) {
      if (table === 'marketing_impacts') {
        return chain({
          maybeSingle: {
            data: { id: IMPACT_ID, tracking_token: TOKEN, channel: 'email' },
            error: null,
          },
        });
      }
      if (table === 'email_campaign_recipients') {
        return chain({
          maybeSingle: {
            data: {
              id: 9,
              purpose: PURPOSE,
              cz_solicitud_id: 1912,
              ci: '18165244',
              marketing_impact_id: IMPACT_ID,
              email: 'a@b.com',
            },
            error: null,
          },
        });
      }
      if (table === 'marketing_impact_events') {
        return {
          select: function () {
            return {
              eq: function () {
                return {
                  eq: function () {
                    return {
                      maybeSingle: function () {
                        const found = events[0] || null;
                        return Promise.resolve({ data: found, error: null });
                      },
                    };
                  },
                };
              },
            };
          },
          insert: function (row) {
            if (events.length) {
              return Promise.resolve({
                data: null,
                error: { code: '23505', message: 'duplicate' },
              });
            }
            events.push(row);
            return Promise.resolve({ data: row, error: null });
          },
        };
      }
      throw new Error('unexpected table ' + table);
    },
  };

  return confirmElmCallback(mock, TOKEN).then(function (first) {
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.created, true);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_name, EVENT_NAME);
    assert.strictEqual(events[0].external_event_id, 'callback_confirmed:' + IMPACT_ID);
    return confirmElmCallback(mock, TOKEN);
  }).then(function (second) {
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.already, true);
    assert.strictEqual(events.length, 1);
    pass('POST confirms once and is idempotent');
  });
})().then(function () {
  return lookupCallbackImpact(
    {
      from: function () {
        return chain({ maybeSingle: { data: null, error: null } });
      },
    },
    'not-a-valid-token!!',
  ).then(function (bad) {
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'invalid_token');
    pass('invalid token does not lookup');
  });
}).then(function () {
  const inserts = [];
  const mock = {
    from: function (table) {
      if (table === 'marketing_impacts') {
        return chain({
          maybeSingle: {
            data: { id: IMPACT_ID, tracking_token: TOKEN, channel: 'email' },
            error: null,
          },
        });
      }
      if (table === 'email_campaign_recipients') {
        return chain({
          maybeSingle: {
            data: {
              id: 9,
              purpose: PURPOSE,
              cz_solicitud_id: 1912,
              ci: '18165244',
              marketing_impact_id: IMPACT_ID,
            },
            error: null,
          },
        });
      }
      if (table === 'marketing_impact_events') {
        return {
          select: function () {
            return {
              eq: function () {
                return {
                  eq: function () {
                    return {
                      maybeSingle: function () {
                        return Promise.resolve({ data: null, error: null });
                      },
                    };
                  },
                };
              },
            };
          },
          insert: function (row) {
            inserts.push(row);
            return Promise.resolve({ data: row, error: null });
          },
        };
      }
      throw new Error('unexpected table ' + table);
    },
  };
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: mock,
  };
  const cbPath = require.resolve('../src/routes/email-callback');
  delete require.cache[cbPath];
  const router = require('../src/routes/email-callback');

  function call(method, token) {
    return new Promise(function (resolve) {
      const layer = router.stack.find(function (l) {
        return (
          l.route &&
          l.route.path === '/email/callback/:token' &&
          l.route.methods[method.toLowerCase()]
        );
      });
      const req = { method: method, params: { token: token }, url: '/email/callback/' + token };
      const res = {
        statusCode: 200,
        body: '',
        status: function (c) { this.statusCode = c; return this; },
        set: function () { return this; },
        send: function (b) { this.body = b; resolve(this); return this; },
      };
      layer.route.stack[0].handle(req, res, function (err) {
        resolve({ statusCode: 500, error: err });
      });
    });
  }

  return call('GET', TOKEN).then(function (getRes) {
    assert.strictEqual(getRes.statusCode, 200);
    assert.ok(String(getRes.body).indexOf('Confirmá') !== -1);
    assert.strictEqual(inserts.length, 0, 'GET must not write callback_confirmed');
    return call('POST', TOKEN);
  }).then(function (postRes) {
    assert.strictEqual(postRes.statusCode, 200);
    assert.ok(String(postRes.body).indexOf('Pedido registrado') !== -1);
    assert.strictEqual(inserts.length, 1);
    return call('GET', 'nope');
  }).then(function (bad) {
    assert.ok(bad.statusCode === 400 || bad.statusCode === 404);
    assert.strictEqual(inserts.length, 1);
    pass('GET does not register; POST does; invalid token rejected');
  });
}).then(async function () {
  const solicitudes = AUTHORIZED_CASES.map(function (c) {
    return {
      cz_id: c.cz_solicitud_id,
      ci: Number(c.ci),
      nombre: 'Nombre' + c.ci,
      email:
        c.ci === '49698187'
          ? 'user49698187@gmail.cm'
          : 'user' + c.ci + '@credizona.test',
      celular: '099' + c.ci.slice(-6),
    };
  });
  solicitudes.push({
    cz_id: 1375,
    ci: 64198417,
    nombre: 'Excluded',
    email: 'ex@x.com',
    celular: '099000000',
  });

  const recipients = [];
  let rpcCalls = 0;
  const suppressed = new Set();
  const campaign = {
    id: 77,
    name: 'ELM callback V1',
    status: 'draft',
    audience_mode: 'DIRECTED',
    segment_id: null,
    subject: TEMPLATE_SUBJECT,
    body_html: TEMPLATE_BODY_HTML,
  };

  const mock = {
    rpc: async function (name, params) {
      assert.strictEqual(name, 'upsert_email_survey_invite_recipient_impact');
      assert.strictEqual(params.p_purpose, PURPOSE);
      assert.ok(authorizedCzIds().includes(Number(params.p_cz_solicitud_id)));
      assert.ok(String(params.p_destination_url).indexOf('/email/callback') !== -1);
      assert.ok(String(params.p_destination_url).indexOf('/email/c/') === -1);
      rpcCalls += 1;
      const rec = {
        id: 1000 + rpcCalls,
        campaign_id: 77,
        idempotency_key: params.p_idempotency_key,
        ci: params.p_ci,
        email: params.p_email,
        status: 'queued',
        purpose: params.p_purpose,
        marketing_impact_id: IMPACT_ID.slice(0, -2) + String(rpcCalls).padStart(2, '0'),
        provider_send_started_at: null,
        template_vars: {},
        cz_solicitud_id: params.p_cz_solicitud_id,
      };
      recipients.push(rec);
      return {
        data: {
          created: true,
          recipient_id: rec.id,
          impact_id: rec.marketing_impact_id,
          tracking_token: TOKEN,
          destination_url: params.p_destination_url,
          campaign_id: 77,
          idempotency_key: rec.idempotency_key,
          status: 'queued',
          provider_send_started_at: null,
          cz_solicitud_id: rec.cz_solicitud_id,
        },
        error: null,
      };
    },
    from: function (table) {
      const api = {
        _filters: {},
        select: function () { return api; },
        eq: function (col, val) { api._filters[col] = val; return api; },
        in: function (col, val) { api._filters[col] = val; return api; },
        not: function () { return api; },
        update: function (patch) {
          api._patch = patch;
          return {
            eq: function (col, val) {
              api._filters[col] = val;
              return {
                eq: function (col2, val2) {
                  api._filters[col2] = val2;
                  return {
                    is: function () {
                      return {
                        select: function () {
                          return {
                            maybeSingle: async function () {
                              const rec = recipients.find(function (r) {
                                return (
                                  r.id === api._filters.id &&
                                  r.idempotency_key === api._filters.idempotency_key
                                );
                              });
                              if (!rec) return { data: null, error: null };
                              Object.assign(rec, api._patch);
                              return { data: rec, error: null };
                            },
                          };
                        },
                      };
                    },
                  };
                },
                then: function (resolve) {
                  return resolve({ error: null });
                },
              };
            },
          };
        },
        maybeSingle: async function () {
          if (table === 'email_campaigns') {
            return { data: campaign, error: null };
          }
          if (table === 'email_campaign_recipients') {
            const rec = recipients.find(function (r) {
              return r.id === api._filters.id;
            });
            return { data: rec || null, error: null };
          }
          return { data: null, error: null };
        },
        then: function (resolve) {
          if (table === 'email_campaign_recipients' && api._filters.campaign_id) {
            return resolve({ data: recipients.slice(), error: null });
          }
          if (table === 'cz_funnel_solicitudes') {
            return resolve({ data: solicitudes, error: null });
          }
          if (table === 'email_suppressions') {
            const wanted = api._filters.email || [];
            const rows = (Array.isArray(wanted) ? wanted : [wanted])
              .filter(function (e) { return suppressed.has(e); })
              .map(function (e) { return { email: e }; });
            return resolve({ data: rows, error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return api;
    },
  };

  const out = await materializeElmCallbackInviteCampaign(mock, 77);
  assert.strictEqual(out.authorized_count, 7);
  assert.strictEqual(out.recipients.length, 7);
  assert.strictEqual(rpcCalls, 7);
  const czs = out.recipients.map(function (r) { return r.cz_solicitud_id; }).sort();
  assert.deepStrictEqual(czs, [1168, 1199, 1262, 1362, 1912, 2692, 2716]);
  assert.ok(out.recipients.every(function (r) { return r.ok; }));
  const corrected = out.recipients.find(function (r) { return r.ci === '49698187'; });
  assert.strictEqual(corrected.email_corrected, true);
  assert.ok(String(corrected.callback_url).indexOf('/email/callback/') !== -1);
  assert.ok(out.skipped.every(function (s) { return s.cz_solicitud_id !== 1375; }));
  pass('materialize queues exactly the 7 authorized solicitudes');

  suppressed.add('user47690694@credizona.test');
  recipients.length = 0;
  rpcCalls = 0;
  const out2 = await materializeElmCallbackInviteCampaign(mock, 77);
  assert.strictEqual(out2.recipients.length, 6);
  assert.ok(out2.skipped.some(function (s) {
    return s.ci === '47690694' && s.result === 'email_suppressed';
  }));
  pass('suppressions still block a recipient');
}).then(async function () {
  const T0 = Date.parse('2026-10-08T12:00:00Z');
  const callbacks = new Map();
  callbacks.set(1912, { ci: '18165244', phone: '099191200', confirmed_at: '2026-11-02T12:00:00Z' });
  const service = createElmOpsService({
    repository: {
      async listOpenProcesses() {
        return [{
          id: '11111111-1111-4111-8111-111111111111',
          cz_solicitud_id: 1912,
          ci: 18165244,
          trigger_origin: 'cz_automatic',
          commercial_origin: null,
          created_at: '2026-10-05T12:00:00Z',
          updated_at: '2026-10-06T12:00:00Z',
          s1_status: 'eligible',
          s1_started_at: '2026-10-05T12:00:00Z',
          s1_lease_expires_at: null,
          s2_status: 'referred',
          s2_started_at: '2026-10-05T12:00:01Z',
          s2_lease_expires_at: null,
          referred_at: '2026-10-05T12:00:00Z',
          provider_status: 'Latente',
          provider_status_at: '2026-10-06T12:00:00Z',
          disbursed_at: null,
          last_postback_event_id: null,
          last_postback_at: null,
          ops_resolved_at: null,
          ops_resolution_code: null,
        }];
      },
      async getPostbackEventsByIds() { return new Map(); },
      async listBlockedByRelated() { return new Map(); },
      async listElmCallbackConfirmed() { return callbacks; },
      async listC1ActiveReferrals() {
        return [{
          cz_solicitud_id: 1912,
          ci: 18165244,
          projected_estado: 13,
          fallback_outcome: 'referred',
          provider_status: 'Latente',
          referred_at: '2026-10-05T12:00:00Z',
          started_at: '2026-10-05T12:00:00Z',
          age_hours: 10,
          granted_elm: false,
          stale: false,
        }];
      },
    },
    now: function () { return T0; },
    logger: { info: function () {}, warn: function () {}, error: function () {} },
    c1StaleHours: 48,
  });
  const processes = await service.listOpenProcesses(50);
  assert.strictEqual(processes.length, 1);
  assert.strictEqual(processes[0].callback_requested, true);
  assert.strictEqual(processes[0].callback_phone, '099191200');
  assert.strictEqual(processes[0].elm.s2_status, 'referred');
  assert.strictEqual(processes[0].elm.ops_resolution_code, null);
  const only = await service.listOpenProcesses(50, { callbackRequested: true });
  assert.strictEqual(only.length, 1);
  const c1 = await service.listC1ActiveReferrals(10);
  assert.strictEqual(c1[0].callback_requested, true);
  assert.strictEqual(c1[0].callback_phone, '099191200');
  pass('C1 18165244 shows Pidió llamada without changing ELM state');
}).then(function () {
  const view = openProcessView({
    id: 'x',
    cz_solicitud_id: 500,
    ci: '1',
    s1_status: 'eligible',
    s2_status: 'referred',
    created_at: '2026-10-05T12:00:00Z',
    updated_at: 'v',
  }, { nowMs: Date.parse('2026-10-08T12:00:00Z') });
  assert.ok(!Object.prototype.hasOwnProperty.call(view, 'ops_resolution_code') || view.elm.ops_resolution_code == null);
  pass('openProcessView still does not resolve processes');
}).then(function () {
  console.log('unit-elm-callback-invite: PASS');
}).catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
