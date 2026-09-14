'use strict';

/**
 * Email delivery atomicity — provider key, started_at, TTL, F6, suppression.
 *
 * node scripts/unit-email-delivery-atomicity.js
 */

const assert = require('assert');

process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
process.env.EMAIL_PROVIDER_MODE = 'log';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';

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
  },
};

const supabasePath = require.resolve('../src/clients/supabase');
const providerPath = require.resolve('../src/services/email-provider');
const processorPath = require.resolve(
  '../src/services/email-campaigns/processor',
);

/** @type {any} */
let state;
/** @type {any} */
let providerHook;

/**
 * Idempotency-aware test mock (NOT LogEmailProvider).
 * Map keyed by idempotencyKey → { fingerprint, providerMessageId }.
 * Tracks technicalCalls vs logicalDeliveries separately.
 */
function createKeyedIdempotentMock() {
  /** @type {Map<string, { fingerprint: string, providerMessageId: string, payload: object }>} */
  const store = new Map();
  let technicalCalls = 0;
  let logicalDeliveries = 0;
  /** @type {object[]} */
  const payloads = [];

  return {
    store,
    payloads,
    failFirstN: 0,
    failFirstError: null,
    failOnceWith: null,
    failWith: null,
    get technicalCalls() {
      return technicalCalls;
    },
    get logicalDeliveries() {
      return logicalDeliveries;
    },
    get callCount() {
      return technicalCalls;
    },
    resetCountersOnly: function () {
      // keep store across processQueue reruns (F6)
      technicalCalls = 0;
      // do NOT reset logicalDeliveries or store
    },
    fullReset: function () {
      store.clear();
      technicalCalls = 0;
      logicalDeliveries = 0;
      payloads.length = 0;
      this.failFirstN = 0;
      this.failFirstError = null;
      this.failOnceWith = null;
      this.failWith = null;
    },
    send: async function (args) {
      technicalCalls += 1;
      const recorded = {
        to: args.to,
        from: args.from,
        subject: args.subject,
        html: args.html,
        idempotencyKey: args.idempotencyKey,
      };
      payloads.push(recorded);

      if (this.failFirstN > 0 && technicalCalls <= this.failFirstN) {
        throw (
          this.failFirstError || new Error('network timeout / no response')
        );
      }
      if (this.failOnceWith) {
        const err = this.failOnceWith;
        this.failOnceWith = null;
        throw err;
      }
      if (this.failWith) {
        throw this.failWith;
      }

      const key =
        args.idempotencyKey != null ? String(args.idempotencyKey) : '';
      if (!key) {
        throw new Error('test mock requires idempotencyKey');
      }

      const fingerprint = JSON.stringify({
        to: args.to,
        from: args.from,
        subject: args.subject,
        html: args.html,
      });

      if (store.has(key)) {
        const prev = store.get(key);
        if (prev.fingerprint !== fingerprint) {
          const err = new Error(
            'This idempotency key has been used with a different payload',
          );
          err.name = 'invalid_idempotent_request';
          err.statusCode = 409;
          throw err;
        }
        // Same key + same payload → replay; no new logical delivery
        return {
          providerId: 'mock',
          providerMessageId: prev.providerMessageId,
        };
      }

      logicalDeliveries += 1;
      const providerMessageId =
        'msg-logical-' + logicalDeliveries + '-' + key.replace(/[^a-z0-9]/gi, '');
      store.set(key, {
        fingerprint,
        providerMessageId,
        payload: {
          to: args.to,
          from: args.from,
          subject: args.subject,
          html: args.html,
        },
      });
      return {
        providerId: 'mock',
        providerMessageId,
      };
    },
  };
}

function resetState(over) {
  state = Object.assign(
    {
      lockAcquired: true,
      suppressions: new Set(),
      campaigns: {},
      recipients: {},
      failSentUpdateOnce: false,
      sentUpdateFailures: 0,
      claimInitCount: 0,
    },
    over || {},
  );
  providerHook = createKeyedIdempotentMock();
}

function recipientRow(over) {
  return Object.assign(
    {
      id: 101,
      campaign_id: 7,
      email: 'user@example.com',
      status: 'queued',
      attempt_count: 0,
      next_attempt_at: null,
      provider_send_started_at: null,
      provider_message_id: null,
      purpose: null,
      template_vars: {},
      idempotency_key: 'biz-key-1',
      created_at: '2026-09-01T00:00:00.000Z',
      error_reason: null,
    },
    over || {},
  );
}

function campaignRow(over) {
  return Object.assign(
    {
      id: 7,
      status: 'draft',
      subject: 'Hola {{nombre}}',
      body_html: '<p>Survey {{survey_url}}</p>',
      segment_id: 1,
    },
    over || {},
  );
}

function matchesFilters(row, filters) {
  for (const f of filters) {
    if (f.op === 'eq' && String(row[f.col]) !== String(f.val)) return false;
    if (f.op === 'is' && f.val === null && row[f.col] != null) return false;
    if (f.op === 'in' && !f.val.map(String).includes(String(row[f.col]))) {
      return false;
    }
  }
  return true;
}

function applyPatch(row, patch) {
  Object.keys(patch).forEach(function (k) {
    row[k] = patch[k];
  });
}

function createQuery(table) {
  const ctx = {
    table,
    action: 'select',
    columns: '*',
    filters: [],
    patch: null,
    limitN: null,
    orExpr: null,
  };

  const api = {
    select: function (columns) {
      ctx.action = ctx.action === 'update' ? 'update' : 'select';
      ctx.columns = columns || '*';
      return api;
    },
    update: function (patch) {
      ctx.action = 'update';
      ctx.patch = patch;
      return api;
    },
    eq: function (col, val) {
      ctx.filters.push({ op: 'eq', col, val });
      return api;
    },
    is: function (col, val) {
      ctx.filters.push({ op: 'is', col, val });
      return api;
    },
    in: function (col, val) {
      ctx.filters.push({ op: 'in', col, val });
      return api;
    },
    or: function (expr) {
      ctx.orExpr = expr;
      return api;
    },
    order: function () {
      return api;
    },
    limit: function (n) {
      ctx.limitN = n;
      return api;
    },
    maybeSingle: async function () {
      const res = await api._exec();
      if (res.error) return res;
      const rows = res.data || [];
      return { data: rows[0] || null, error: null };
    },
    single: async function () {
      return api.maybeSingle();
    },
    then: function (resolve, reject) {
      return api._exec().then(resolve, reject);
    },
    _exec: async function () {
      if (table === 'email_suppressions') {
        const emailFilter = ctx.filters.find(function (f) {
          return f.op === 'eq' && f.col === 'email';
        });
        const out = [];
        if (emailFilter && state.suppressions.has(String(emailFilter.val))) {
          out.push({ email: emailFilter.val });
        }
        return { data: out, error: null };
      }

      if (table === 'email_campaigns') {
        if (ctx.action === 'select') {
          const inFilter = ctx.filters.find(function (f) {
            return f.op === 'in' && f.col === 'id';
          });
          let rows = Object.values(state.campaigns);
          if (inFilter) {
            const ids = new Set(inFilter.val.map(String));
            rows = rows.filter(function (r) {
              return ids.has(String(r.id));
            });
          }
          return { data: rows, error: null };
        }
        if (ctx.action === 'update') {
          const eqFilter = ctx.filters.find(function (f) {
            return f.op === 'eq' && f.col === 'id';
          });
          const c = state.campaigns[String(eqFilter.val)];
          if (c) applyPatch(c, ctx.patch);
          return { data: null, error: null };
        }
      }

      if (table === 'email_campaign_recipients') {
        if (ctx.action === 'select') {
          let rows = Object.values(state.recipients).map(function (r) {
            return Object.assign({}, r);
          });
          rows = rows.filter(function (r) {
            return matchesFilters(r, ctx.filters);
          });
          if (ctx.orExpr && ctx.orExpr.indexOf('next_attempt_at') !== -1) {
            rows = rows.filter(function (r) {
              return r.status === 'queued';
            });
          }
          if (ctx.limitN != null) rows = rows.slice(0, ctx.limitN);
          if (ctx.columns === 'status') {
            rows = rows.map(function (r) {
              return { status: r.status };
            });
          }
          if (ctx.columns === 'provider_send_started_at') {
            rows = rows.map(function (r) {
              return {
                provider_send_started_at: r.provider_send_started_at,
              };
            });
          }
          return { data: rows, error: null };
        }

        if (ctx.action === 'update') {
          const eqId = ctx.filters.find(function (f) {
            return f.op === 'eq' && f.col === 'id';
          });
          const row = state.recipients[String(eqId.val)];
          if (!row) return { data: [], error: null };

          const isNullClaim = ctx.filters.some(function (f) {
            return (
              f.op === 'is' &&
              f.col === 'provider_send_started_at' &&
              f.val === null
            );
          });
          if (isNullClaim) {
            state.claimInitCount += 1;
            if (row.provider_send_started_at != null) {
              return { data: [], error: null };
            }
            applyPatch(row, ctx.patch);
            return {
              data: [
                {
                  provider_send_started_at: row.provider_send_started_at,
                },
              ],
              error: null,
            };
          }

          if (
            state.failSentUpdateOnce &&
            ctx.patch &&
            ctx.patch.status === 'sent'
          ) {
            state.failSentUpdateOnce = false;
            state.sentUpdateFailures += 1;
            return {
              data: null,
              error: { message: 'simulated sent update failure' },
            };
          }

          applyPatch(row, ctx.patch);
          return { data: [Object.assign({}, row)], error: null };
        }
      }

      return { data: [], error: null };
    },
  };

  return api;
}

function installMocks() {
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: {
      from: function (table) {
        return createQuery(table);
      },
      rpc: async function (name) {
        if (name === 'acquire_job_lock') {
          return { data: state.lockAcquired, error: null };
        }
        if (name === 'release_job_lock') {
          return { data: true, error: null };
        }
        return { data: null, error: { message: 'unknown rpc' } };
      },
    },
  };

  require.cache[providerPath] = {
    id: providerPath,
    filename: providerPath,
    loaded: true,
    exports: {
      getEmailProvider: function () {
        return {
          send: function (args) {
            return providerHook.send(args);
          },
        };
      },
      LogEmailProvider: require('../src/services/email-provider/log')
        .LogEmailProvider,
    },
  };

  delete require.cache[processorPath];
}

function loadProcessor() {
  installMocks();
  return require('../src/services/email-campaigns/processor');
}

async function runProcessQueueOnce() {
  const { processQueue } = loadProcessor();
  return processQueue();
}

async function main() {
  // --- pure helpers ---
  {
    const {
      buildProviderIdempotencyKey,
      classifyProviderSendError,
      isProviderIdempotencyTtlExpired,
      ERROR_PROVIDER_INVALID_IDEMPOTENT,
      ERROR_PROVIDER_TTL_EXPIRED,
      PROVIDER_IDEMPOTENCY_TTL_MS,
    } = loadProcessor();

    assert.strictEqual(
      buildProviderIdempotencyKey(42),
      'janus-email-recipient:42',
    );
    assert.strictEqual(
      buildProviderIdempotencyKey('101'),
      'janus-email-recipient:101',
    );

    const invalid = new Error('payload changed');
    invalid.name = 'invalid_idempotent_request';
    assert.deepStrictEqual(classifyProviderSendError(invalid), {
      kind: 'terminal',
      errorReason: ERROR_PROVIDER_INVALID_IDEMPOTENT,
    });

    const concurrent = new Error('in progress');
    concurrent.name = 'concurrent_idempotent_requests';
    assert.deepStrictEqual(classifyProviderSendError(concurrent), {
      kind: 'retryable',
      errorReason: 'concurrent_idempotent_requests',
    });

    assert.strictEqual(
      classifyProviderSendError(new Error('network timeout / no response'))
        .kind,
      'retryable',
    );

    const started = '2026-09-13T00:00:00.000Z';
    assert.strictEqual(
      isProviderIdempotencyTtlExpired(
        started,
        new Date(
          Date.parse(started) + PROVIDER_IDEMPOTENCY_TTL_MS - 1,
        ).toISOString(),
      ),
      false,
    );
    assert.strictEqual(
      isProviderIdempotencyTtlExpired(
        started,
        new Date(
          Date.parse(started) + PROVIDER_IDEMPOTENCY_TTL_MS,
        ).toISOString(),
      ),
      true,
    );
    // invalid timestamp → UNKNOWN / expired
    assert.strictEqual(
      isProviderIdempotencyTtlExpired('not-a-date', new Date().toISOString()),
      true,
    );
    assert.strictEqual(
      ERROR_PROVIDER_TTL_EXPIRED,
      'provider_delivery_unknown_after_idempotency_ttl',
    );
  }

  // --- LogEmailProvider regression: simple log, NO dedupe store ---
  {
    delete require.cache[require.resolve('../src/services/email-provider/log')];
    delete require.cache[require.resolve('../src/services/email-provider/index')];
    const logMod = require('../src/services/email-provider/log');
    assert.strictEqual(
      logMod.clearLogEmailProviderIdempotencyStore,
      undefined,
    );
    const { LogEmailProvider } = logMod;
    const log = new LogEmailProvider();
    const origLog = console.log;
    const lines = [];
    console.log = function () {
      lines.push(Array.prototype.slice.call(arguments));
    };
    try {
      const a = await log.send({
        to: 'a@b.co',
        from: 'f@x.co',
        subject: 's',
        html: '<p>1</p>',
        idempotencyKey: 'janus-email-recipient:9',
      });
      assert.strictEqual(a.providerId, 'log');
      assert.ok(a.providerMessageId);
      // Different payload with same key must NOT throw (Log is not Resend)
      const c = await log.send({
        to: 'a@b.co',
        from: 'f@x.co',
        subject: 's',
        html: '<p>MUTATED</p>',
        idempotencyKey: 'janus-email-recipient:9',
      });
      assert.strictEqual(c.providerId, 'log');
      assert.ok(c.providerMessageId);
      // Legacy caller without idempotencyKey still works
      const d = await log.send({
        to: 'a@b.co',
        from: 'f@x.co',
        subject: 's',
        html: '<p>1</p>',
      });
      assert.strictEqual(d.providerId, 'log');
      assert.ok(
        lines.some(function (args) {
          return String(args[0]).indexOf('[LogEmailProvider]') === 0;
        }),
      );
    } finally {
      console.log = origLog;
    }
  }

  // --- Atomic started_at ---
  {
    resetState();
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow();
    const { ensureProviderSendStartedAt } = loadProcessor();
    const t1 = '2026-09-13T12:00:00.000Z';
    const t2 = '2026-09-13T12:00:05.000Z';
    const a = await ensureProviderSendStartedAt(101, t1);
    const b = await ensureProviderSendStartedAt(101, t2);
    assert.strictEqual(a.initialized, true);
    assert.strictEqual(b.initialized, false);
    assert.strictEqual(a.provider_send_started_at, t1);
    assert.strictEqual(b.provider_send_started_at, t1);
  }

  // --- Fresh suppression ---
  {
    resetState();
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow();
    state.suppressions.add('user@example.com');
    const summary = await runProcessQueueOnce();
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(providerHook.technicalCalls, 0);
    assert.strictEqual(providerHook.logicalDeliveries, 0);
    assert.strictEqual(state.recipients['101'].provider_send_started_at, null);
    assert.strictEqual(state.recipients['101'].error_reason, 'email_suppressed');
  }

  // --- Happy path ---
  {
    resetState();
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow();
    const summary = await runProcessQueueOnce();
    assert.strictEqual(summary.sent, 1);
    assert.strictEqual(providerHook.technicalCalls, 1);
    assert.strictEqual(providerHook.logicalDeliveries, 1);
    assert.strictEqual(
      providerHook.payloads[0].idempotencyKey,
      'janus-email-recipient:101',
    );
    assert.strictEqual(state.recipients['101'].status, 'sent');
    assert.ok(state.recipients['101'].provider_message_id);
    assert.ok(state.recipients['101'].provider_send_started_at);
  }

  // --- No response then same-key retry ---
  {
    resetState();
    providerHook.failFirstN = 1;
    providerHook.failFirstError = new Error('network timeout / no response');
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow({ attempt_count: 0 });
    const s1 = await runProcessQueueOnce();
    assert.strictEqual(s1.deferred, 1);
    assert.strictEqual(providerHook.logicalDeliveries, 0);
    const startedAt = state.recipients['101'].provider_send_started_at;
    assert.ok(startedAt);
    state.recipients['101'].next_attempt_at = null;
    state.recipients['101'].attempt_count = 1;
    const s2 = await runProcessQueueOnce();
    assert.strictEqual(s2.sent, 1);
    assert.strictEqual(providerHook.technicalCalls, 2);
    assert.strictEqual(providerHook.logicalDeliveries, 1);
    assert.strictEqual(
      providerHook.payloads[0].idempotencyKey,
      providerHook.payloads[1].idempotencyKey,
    );
    assert.strictEqual(
      providerHook.payloads[0].html,
      providerHook.payloads[1].html,
    );
    assert.strictEqual(
      state.recipients['101'].provider_send_started_at,
      startedAt,
    );
  }

  // --- CRÍTICO F6: ACK → DB fail → rerun → 2 technical / 1 logical ---
  {
    resetState();
    state.failSentUpdateOnce = true;
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>body-f6</p>',
    });
    state.recipients['101'] = recipientRow();

    const s1 = await runProcessQueueOnce();
    assert.strictEqual(s1.skipped, 1);
    assert.strictEqual(state.sentUpdateFailures, 1);
    assert.strictEqual(state.recipients['101'].status, 'queued');
    assert.strictEqual(providerHook.technicalCalls, 1);
    assert.strictEqual(providerHook.logicalDeliveries, 1);
    const key1 = providerHook.payloads[0].idempotencyKey;
    const msg1 = state.recipients['101'].provider_message_id;
    // sent update failed — message id not persisted yet
    assert.strictEqual(msg1, null);
    const firstMessageId = providerHook.store.get(key1).providerMessageId;
    const startedAt = state.recipients['101'].provider_send_started_at;
    assert.ok(startedAt);
    assert.strictEqual(key1, 'janus-email-recipient:101');

    const s2 = await runProcessQueueOnce();
    assert.strictEqual(s2.sent, 1);
    assert.strictEqual(providerHook.technicalCalls, 2);
    assert.strictEqual(providerHook.logicalDeliveries, 1);
    assert.strictEqual(providerHook.payloads[1].idempotencyKey, key1);
    assert.strictEqual(providerHook.payloads[1].to, providerHook.payloads[0].to);
    assert.strictEqual(
      providerHook.payloads[1].from,
      providerHook.payloads[0].from,
    );
    assert.strictEqual(
      providerHook.payloads[1].subject,
      providerHook.payloads[0].subject,
    );
    assert.strictEqual(
      providerHook.payloads[1].html,
      providerHook.payloads[0].html,
    );
    assert.strictEqual(
      state.recipients['101'].provider_message_id,
      firstMessageId,
    );
    assert.strictEqual(state.recipients['101'].status, 'sent');
    assert.strictEqual(
      state.recipients['101'].provider_send_started_at,
      startedAt,
    );
    assert.strictEqual(providerHook.store.size, 1);
  }

  // --- Concurrent workers: same started_at + same key ---
  {
    resetState();
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow();
    const { ensureProviderSendStartedAt, buildProviderIdempotencyKey } =
      loadProcessor();
    const [w1, w2] = await Promise.all([
      ensureProviderSendStartedAt(101, '2026-09-13T15:00:00.000Z'),
      ensureProviderSendStartedAt(101, '2026-09-13T15:00:01.000Z'),
    ]);
    assert.strictEqual(
      w1.provider_send_started_at,
      w2.provider_send_started_at,
    );
    assert.strictEqual(
      buildProviderIdempotencyKey(101),
      'janus-email-recipient:101',
    );
    const summary = await runProcessQueueOnce();
    assert.strictEqual(summary.sent, 1);
    assert.strictEqual(providerHook.logicalDeliveries, 1);
  }

  // --- invalid_idempotent_request terminal ---
  {
    resetState();
    const err = new Error('payload mismatch');
    err.name = 'invalid_idempotent_request';
    providerHook.failWith = err;
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow();
    const summary = await runProcessQueueOnce();
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(state.recipients['101'].status, 'failed');
    assert.strictEqual(
      state.recipients['101'].error_reason,
      'provider_invalid_idempotent_request',
    );
    assert.strictEqual(providerHook.logicalDeliveries, 0);
  }

  // --- same key + different payload via store → invalid → terminal ---
  {
    resetState();
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>original</p>',
    });
    state.recipients['101'] = recipientRow();
    // Seed store as if first send already happened with different html
    providerHook.store.set('janus-email-recipient:101', {
      fingerprint: JSON.stringify({
        to: 'user@example.com',
        from: process.env.EMAIL_CAMPAIGNS_FROM,
        subject: 'Hi',
        html: '<p>OTHER</p>',
      }),
      providerMessageId: 'msg-seeded',
      payload: {},
    });
    // Mark started so we go to provider
    state.recipients['101'].provider_send_started_at = new Date().toISOString();
    const summary = await runProcessQueueOnce();
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(
      state.recipients['101'].error_reason,
      'provider_invalid_idempotent_request',
    );
    assert.strictEqual(providerHook.technicalCalls, 1);
    assert.strictEqual(providerHook.logicalDeliveries, 0);
    assert.strictEqual(providerHook.store.size, 1);
    assert.strictEqual(
      providerHook.store.get('janus-email-recipient:101').providerMessageId,
      'msg-seeded',
    );
  }

  // --- concurrent_idempotent_requests → defer, same key ---
  {
    resetState();
    const err = new Error('in progress');
    err.name = 'concurrent_idempotent_requests';
    providerHook.failOnceWith = err;
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow();
    const s1 = await runProcessQueueOnce();
    assert.strictEqual(s1.deferred, 1);
    const key = providerHook.payloads[0].idempotencyKey;
    state.recipients['101'].next_attempt_at = null;
    state.recipients['101'].attempt_count = 1;
    const s2 = await runProcessQueueOnce();
    assert.strictEqual(s2.sent, 1);
    assert.strictEqual(providerHook.payloads[1].idempotencyKey, key);
    assert.strictEqual(providerHook.logicalDeliveries, 1);
  }

  // --- TTL expired ---
  {
    resetState();
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow({
      provider_send_started_at: '2026-09-01T00:00:00.000Z',
    });
    const summary = await runProcessQueueOnce();
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(providerHook.technicalCalls, 0);
    assert.strictEqual(
      state.recipients['101'].error_reason,
      'provider_delivery_unknown_after_idempotency_ttl',
    );
  }

  // --- INVALID timestamp → same UNKNOWN reason, no provider ---
  {
    resetState();
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow({
      provider_send_started_at: 'not-a-valid-timestamp',
    });
    const summary = await runProcessQueueOnce();
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(providerHook.technicalCalls, 0);
    assert.strictEqual(providerHook.logicalDeliveries, 0);
    assert.strictEqual(state.recipients['101'].status, 'failed');
    assert.strictEqual(
      state.recipients['101'].error_reason,
      'provider_delivery_unknown_after_idempotency_ttl',
    );
    assert.strictEqual(
      state.recipients['101'].provider_send_started_at,
      'not-a-valid-timestamp',
    );
  }

  // --- TTL within 24h allows retry ---
  {
    resetState();
    const started = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    state.campaigns['7'] = campaignRow({
      subject: 'Hi',
      body_html: '<p>x</p>',
    });
    state.recipients['101'] = recipientRow({
      provider_send_started_at: started,
      attempt_count: 1,
    });
    const summary = await runProcessQueueOnce();
    assert.strictEqual(summary.sent, 1);
    assert.strictEqual(providerHook.technicalCalls, 1);
    assert.strictEqual(providerHook.logicalDeliveries, 1);
    assert.strictEqual(
      state.recipients['101'].provider_send_started_at,
      started,
    );
  }

  // --- Resend adapter passes second-arg idempotencyKey ---
  {
    const resendModPath = require.resolve('resend');
    let capturedOptions = null;
    require.cache[resendModPath] = {
      id: resendModPath,
      filename: resendModPath,
      loaded: true,
      exports: {
        Resend: function () {
          return {
            emails: {
              send: async function (_payload, options) {
                capturedOptions = options || null;
                return { data: { id: 're_mock_1' }, error: null };
              },
            },
          };
        },
      },
    };
    delete require.cache[
      require.resolve('../src/services/email-provider/resend')
    ];
    process.env.RESEND_API_KEY = 're_test_key';
    const {
      ResendEmailProvider,
    } = require('../src/services/email-provider/resend');
    const rp = new ResendEmailProvider();
    const out = await rp.send({
      to: 'a@b.co',
      from: 'Janus <f@c.co>',
      subject: 's',
      html: '<p>h</p>',
      idempotencyKey: 'janus-email-recipient:77',
    });
    assert.strictEqual(out.providerMessageId, 're_mock_1');
    assert.deepStrictEqual(capturedOptions, {
      idempotencyKey: 'janus-email-recipient:77',
    });
    delete require.cache[resendModPath];
    delete require.cache[
      require.resolve('../src/services/email-provider/resend')
    ];
    delete process.env.RESEND_API_KEY;
  }

  // index.js must not export dead clear helper
  {
    const idx = require('../src/services/email-provider/index');
    assert.strictEqual(idx.clearLogEmailProviderIdempotencyStore, undefined);
  }

  console.log('unit-email-delivery-atomicity: OK');
}

main().catch(function (err) {
  console.error('unit-email-delivery-atomicity FAILED');
  console.error(err);
  process.exit(1);
});
