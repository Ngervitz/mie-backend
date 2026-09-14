'use strict';

/**
 * Template catalog + recipient payload snapshot.
 * node scripts/unit-email-template-snapshot.js
 */

const assert = require('assert');

process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <from-a@credizona.com.uy>';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PROVIDER_MODE = 'log';

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

const {
  buildRecipientPayloadSnapshot,
  classifyRecipientPayload,
  isSnapshotPayloadComplete,
  requireCampaignsFrom,
  ERROR_PAYLOAD_SNAPSHOT_INCOMPLETE,
} = require('../src/services/email-campaigns/payloadSnapshot');
const {
  loadActiveTemplateForCampaign,
  campaignOwnedCopyFromTemplate,
} = require('../src/services/email-campaigns/templates');

const supabasePath = require.resolve('../src/clients/supabase');
const providerPath = require.resolve('../src/services/email-provider');
const processorPath = require.resolve('../src/services/email-campaigns/processor');

let state;
let providerHook;
let insertCount;

function installProcessorMocks() {
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: {
      from: function (table) {
        return createQuery(table);
      },
      rpc: async function (name) {
        if (name === 'acquire_job_lock') return { data: true, error: null };
        if (name === 'release_job_lock') return { data: true, error: null };
        return { data: null, error: { message: 'unknown' } };
      },
    },
  };
  require.cache[providerPath] = {
    id: providerPath,
    filename: providerPath,
    loaded: true,
    exports: {
      getEmailProvider: function () {
        return { send: function (args) { return providerHook.send(args); } };
      },
    },
  };
  delete require.cache[processorPath];
}

function createQuery(table) {
  const ctx = { table: table, action: 'select', filters: [], patch: null };
  const api = {
    select: function () { return api; },
    update: function (patch) { ctx.action = 'update'; ctx.patch = patch; return api; },
    insert: function () { insertCount += 1; ctx.action = 'insert'; return api; },
    eq: function (col, val) { ctx.filters.push({ col: col, val: val }); return api; },
    is: function (col, val) { ctx.filters.push({ op: 'is', col: col, val: val }); return api; },
    in: function (col, val) { ctx.filters.push({ op: 'in', col: col, val: val }); return api; },
    or: function () { return api; },
    order: function () { return api; },
    limit: function () { return api; },
    maybeSingle: async function () { return exec(true); },
    single: async function () { return exec(true); },
    then: function (resolve, reject) { return exec(false).then(resolve, reject); },
  };
  async function exec(single) {
    if (table === 'email_suppressions') return { data: [], error: null };
    if (table === 'email_campaigns') {
      if (ctx.action === 'update' && ctx.patch) {
        Object.assign(state.campaign, ctx.patch);
        return { data: null, error: null };
      }
      return { data: single ? state.campaign : [state.campaign], error: null };
    }
    if (table === 'email_campaign_recipients') {
      const row = state.recipient;
      if (ctx.action === 'update' && ctx.patch && ctx.patch.provider_send_started_at && row.provider_send_started_at == null) {
        row.provider_send_started_at = ctx.patch.provider_send_started_at;
        return { data: single ? { provider_send_started_at: row.provider_send_started_at } : [{ provider_send_started_at: row.provider_send_started_at }], error: null };
      }
      if (ctx.action === 'update' && ctx.patch && ctx.patch.provider_send_started_at && row.provider_send_started_at != null) {
        return { data: single ? null : [], error: null };
      }
      if (ctx.action === 'update' && ctx.patch) {
        Object.assign(row, ctx.patch);
        return { data: single ? row : [row], error: null };
      }
      if (ctx.filters.some(function (f) { return f.col === 'status'; })) {
        return { data: row.status === 'queued' ? [row] : [], error: null };
      }
      return { data: single ? row : [row], error: null };
    }
    return { data: single ? null : [], error: null };
  }
  return api;
}

function seed(over) {
  state = {
    campaign: Object.assign({
      id: 7,
      status: 'sending',
      subject: 'LIVE SUBJECT',
      body_html: '<p>LIVE</p>',
    }, over && over.campaign),
    recipient: Object.assign({
      id: 101,
      campaign_id: 7,
      email: 'user@example.com',
      status: 'queued',
      attempt_count: 0,
      next_attempt_at: null,
      purpose: null,
      template_vars: {},
      provider_send_started_at: null,
      template_subject_snapshot: null,
      template_body_html_snapshot: null,
      payload_to: null,
      payload_from: null,
      payload_subject: null,
      payload_html: null,
    }, over && over.recipient),
  };
  providerHook = {
    calls: [],
    send: async function (args) {
      providerHook.calls.push(args);
      return { providerId: 'mock', providerMessageId: 'm1' };
    },
  };
  insertCount = 0;
}

async function runQueue() {
  installProcessorMocks();
  const { processQueue } = require('../src/services/email-campaigns/processor');
  return processQueue();
}

async function main() {
  const built = buildRecipientPayloadSnapshot({
    to: '  User@Example.com ',
    from: 'Janus <from-a@credizona.com.uy>',
    subject: 'Hola {{nombre}}',
    bodyHtml: '<p>Hola</p>',
    templateVars: { nombre: 'Ana' },
    purpose: null,
  });
  assert.strictEqual(built.payload_to, 'user@example.com');
  assert.strictEqual(built.payload_subject, 'Hola Ana');
  assert.strictEqual(built.template_subject_snapshot, 'Hola {{nombre}}');
  assert.strictEqual(classifyRecipientPayload(built), 'snapshot');
  assert.strictEqual(classifyRecipientPayload({ provider_send_started_at: '2026-01-01T00:00:00.000Z' }), 'legacy');
  assert.strictEqual(isSnapshotPayloadComplete(built), true);

  const copied = campaignOwnedCopyFromTemplate({
    id: 9,
    subject: '  Asunto  ',
    body_html: '<p>x</p>',
    active: true,
  });
  assert.strictEqual(copied.subject, 'Asunto');
  assert.strictEqual(copied.template_id, 9);

  let inactiveThrew = false;
  try {
    await loadActiveTemplateForCampaign({
      from: function () {
        return {
          select: function () { return this; },
          eq: function () { return this; },
          maybeSingle: async function () {
            return { data: { id: 3, active: false, subject: 's', body_html: '<p>h</p>' }, error: null };
          },
        };
      },
    }, 3);
  } catch (err) {
    inactiveThrew = /inactive/.test(err.message);
  }
  assert.strictEqual(inactiveThrew, true);

  const frozen = {
    payload_to: 'user@example.com',
    payload_from: 'Janus <from-a@credizona.com.uy>',
    payload_subject: 'FROZEN SUBJECT',
    payload_html: '<p>FROZEN</p>',
    template_subject_snapshot: 'Fuente',
    template_body_html_snapshot: '<p>Fuente</p>',
  };

  seed({ recipient: frozen });
  state.campaign.subject = 'EDITED CAMPAIGN';
  state.campaign.body_html = '<p>EDITED</p>';
  process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <from-b@credizona.com.uy>';
  await runQueue();
  assert.strictEqual(providerHook.calls.length, 1);
  assert.strictEqual(providerHook.calls[0].to, 'user@example.com');
  assert.strictEqual(providerHook.calls[0].from, 'Janus <from-a@credizona.com.uy>');
  assert.strictEqual(providerHook.calls[0].subject, 'FROZEN SUBJECT');
  assert.strictEqual(providerHook.calls[0].html, '<p>FROZEN</p>');
  assert.strictEqual(providerHook.calls[0].idempotencyKey, 'janus-email-recipient:101');
  state.recipient.status = 'queued';
  state.recipient.next_attempt_at = null;
  state.campaign.status = 'sending';
  await runQueue();
  assert.strictEqual(providerHook.calls.length, 2);
  assert.strictEqual(providerHook.calls[1].idempotencyKey, providerHook.calls[0].idempotencyKey);
  assert.strictEqual(providerHook.calls[1].html, '<p>FROZEN</p>');
  assert.strictEqual(providerHook.calls[1].from, 'Janus <from-a@credizona.com.uy>');

  seed({});
  process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <legacy@credizona.com.uy>';
  state.campaign.subject = 'Legacy subject';
  state.campaign.body_html = '<p>legacy</p>';
  await runQueue();
  assert.strictEqual(providerHook.calls[0].subject, 'Legacy subject');
  assert.strictEqual(providerHook.calls[0].from, 'Janus <legacy@credizona.com.uy>');
  assert.notStrictEqual(state.recipient.error_reason, ERROR_PAYLOAD_SNAPSHOT_INCOMPLETE);

  seed({
    recipient: { provider_send_started_at: '2026-09-13T12:00:00.000Z' },
  });
  process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <legacy@credizona.com.uy>';
  state.campaign.subject = 'Still legacy';
  state.campaign.body_html = '<p>still</p>';
  await runQueue();
  assert.strictEqual(providerHook.calls.length, 1);
  assert.strictEqual(providerHook.calls[0].subject, 'Still legacy');
  assert.notStrictEqual(state.recipient.error_reason, ERROR_PAYLOAD_SNAPSHOT_INCOMPLETE);

  seed({
    recipient: {
      template_subject_snapshot: 'Fuente',
      payload_to: 'user@example.com',
      payload_from: null,
      payload_subject: null,
      payload_html: null,
      provider_send_started_at: '2026-09-13T12:00:00.000Z',
    },
  });
  await runQueue();
  assert.strictEqual(providerHook.calls.length, 0);
  assert.strictEqual(state.recipient.status, 'failed');
  assert.strictEqual(state.recipient.error_reason, ERROR_PAYLOAD_SNAPSHOT_INCOMPLETE);

  process.env.EMAIL_CAMPAIGNS_FROM = '';
  let fromThrew = false;
  try { requireCampaignsFrom(); } catch (err) { fromThrew = true; }
  assert.strictEqual(fromThrew, true);

  insertCount = 0;
  installProcessorMocks();
  process.env.EMAIL_CAMPAIGNS_FROM = '';
  state = {
    campaign: { id: 7, status: 'draft', subject: 'S', body_html: '<p>b</p>' },
    recipient: { id: 1, status: 'queued' },
  };
  const { materializeCampaign } = require('../src/services/email-campaigns/processor');
  let matThrew = false;
  try {
    await materializeCampaign(7);
  } catch (err) {
    matThrew = /EMAIL_CAMPAIGNS_FROM/.test(err.message);
  }
  assert.strictEqual(matThrew, true);
  assert.strictEqual(insertCount, 0);

  process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <from-a@credizona.com.uy>';
  console.log('unit-email-template-snapshot: OK');
}

main().catch(function (err) {
  console.error('unit-email-template-snapshot FAILED');
  console.error(err);
  process.exit(1);
});
