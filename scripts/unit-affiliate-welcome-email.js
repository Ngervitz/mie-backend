'use strict';

/**
 * node scripts/unit-affiliate-welcome-email.js
 * Does not call Resend or any live provider.
 */

const assert = require('assert');
const {
  welcomeEmailDashboardLabel,
  isValidAffiliateEmail,
  renderWelcome,
  sendAffiliateWelcomeEmail,
  AFFILIATE_WELCOME_SUBJECT,
} = require('../src/lib/affiliateWelcomeEmail');
assert.strictEqual(isValidAffiliateEmail('Ana@Credizona.net'), true);
assert.strictEqual(isValidAffiliateEmail(''), false);
assert.strictEqual(isValidAffiliateEmail('no-arroba'), false);
assert.strictEqual(welcomeEmailDashboardLabel(null, false), 'Sin email');
assert.strictEqual(welcomeEmailDashboardLabel(null, true), 'Pendiente');
assert.strictEqual(
  welcomeEmailDashboardLabel({ status: 'queued', provider_message_id: null }, true),
  'Pendiente',
);
assert.strictEqual(
  welcomeEmailDashboardLabel({ status: 'sent', provider_message_id: 're_1' }, true),
  'OK',
);
assert.strictEqual(
  welcomeEmailDashboardLabel({ status: 'sent', provider_message_id: '' }, true),
  'Pendiente',
);
assert.strictEqual(
  welcomeEmailDashboardLabel({ status: 'failed', provider_message_id: null }, true),
  'Error',
);

const html = renderWelcome('Ana', 'https://s.credizona.net/a/abc');
assert.ok(html.indexOf('¡Hola, Ana!') !== -1);
const htmlSinNombre = renderWelcome('', 'https://s.credizona.net/a/abc');
assert.ok(htmlSinNombre.indexOf('¡Hola!') !== -1);
assert.ok(htmlSinNombre.indexOf('¡Hola,') === -1);
assert.ok(html.indexOf('https://s.credizona.net/a/abc') !== -1);
assert.ok(html.indexOf('$500 por cada préstamo efectivamente otorgado') !== -1);
assert.ok(html.indexOf('Equipo Credizona') !== -1);
assert.strictEqual(AFFILIATE_WELCOME_SUBJECT.indexOf('Bienvenido a Credizona'), 1);

function memoryDb(seed) {
  const state = {
    campaigns: [],
    recipients: [],
    funnel: seed.funnel || [],
    sends: [],
  };
  function api(table) {
    const ctx = { filters: [], insertRow: null };
    const query = {
      select: function () {
        return query;
      },
      eq: function (field, value) {
        ctx.filters.push([field, value]);
        return query;
      },
      limit: function () {
        return query;
      },
      insert: function (row) {
        ctx.insertRow = row;
        return query;
      },
      update: function (patch) {
        ctx.patch = patch;
        return query;
      },
      single: async function () {
        return run(true);
      },
      then: function (resolve, reject) {
        run(false).then(resolve, reject);
      },
    };
    function match(row) {
      return ctx.filters.every(function (pair) {
        return String(row[pair[0]]) === String(pair[1]);
      });
    }
    async function run(one) {
      const tableRows =
        table === 'email_campaigns'
          ? state.campaigns
          : table === 'email_campaign_recipients'
            ? state.recipients
            : state.funnel;
      if (ctx.patch) {
        tableRows.forEach(function (row) {
          if (match(row)) Object.assign(row, ctx.patch);
        });
        return { data: null, error: null };
      }
      if (ctx.insertRow) {
        if (table === 'email_campaign_recipients') {
          const dup = state.recipients.some(function (row) {
            return row.idempotency_key === ctx.insertRow.idempotency_key;
          });
          if (dup) return { data: null, error: { code: '23505', message: 'duplicate' } };
        }
        const rec = Object.assign({ id: table + '-' + (tableRows.length + 1) }, ctx.insertRow);
        tableRows.push(rec);
        return { data: one ? rec : [rec], error: null };
      }
      const found = tableRows.filter(match);
      return { data: one ? found[0] || null : found, error: null };
    }
    return query;
  }
  return {
    state: state,
    from: api,
  };
}

(async function main() {
  const db = memoryDb({
    funnel: [
      { ci: 17298826, cz_id: 1, nombre: 'Ana', apellido: 'López', email: 'no' },
      { ci: 17298826, cz_id: 2, nombre: 'Ana', apellido: 'López', email: 'ana@example.com' },
    ],
  });
  const sends = [];
  const affiliate = { id: 'af-1', code: 'AbC123', ci: 17298826 };
  const first = await sendAffiliateWelcomeEmail(db, affiliate, {
    from: 'Credizona <hola@credizona.net>',
    send: async function (args) {
      sends.push(args);
      return { providerMessageId: 're_123' };
    },
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.status, 'ok');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'ana@example.com');
  assert.strictEqual(sends[0].subject, AFFILIATE_WELCOME_SUBJECT);
  assert.ok(sends[0].html.indexOf('¡Hola, Ana!') !== -1);
  assert.ok(sends[0].html.indexOf('https://s.credizona.net/a/AbC123') !== -1);
  assert.strictEqual(sends[0].idempotencyKey, 'janus-affiliate-welcome:af-1');
  assert.strictEqual(db.state.recipients[0].status, 'sent');
  assert.strictEqual(db.state.recipients[0].provider_message_id, 're_123');

  const second = await sendAffiliateWelcomeEmail(db, affiliate, {
    from: 'Credizona <hola@credizona.net>',
    send: async function () {
      sends.push('again');
      return { providerMessageId: 're_999' };
    },
  });
  assert.strictEqual(second.already_sent, true);
  assert.strictEqual(sends.length, 1);

  const noEmail = memoryDb({
    funnel: [{ ci: 20, cz_id: 1, nombre: 'Luis', email: '' }],
  });
  let called = 0;
  const skipped = await sendAffiliateWelcomeEmail(
    noEmail,
    { id: 'af-2', code: 'Zz9', ci: 20 },
    {
      from: 'Credizona <hola@credizona.net>',
      send: async function () {
        called += 1;
        return { providerMessageId: 'x' };
      },
    },
  );
  assert.strictEqual(skipped.status, 'sin_email');
  assert.strictEqual(called, 0);
  assert.strictEqual(noEmail.state.recipients.length, 0);

  const sinNombre = memoryDb({
    funnel: [{ ci: 21, cz_id: 3, nombre: '   ', email: 'sin-nombre@example.com' }],
  });
  const namelessSends = [];
  const nameless = await sendAffiliateWelcomeEmail(
    sinNombre,
    { id: 'af-3', code: 'Nm1', ci: 21 },
    {
      from: 'Credizona <hola@credizona.net>',
      send: async function (args) {
        namelessSends.push(args);
        return { providerMessageId: 're_noname' };
      },
    },
  );
  assert.strictEqual(nameless.ok, true);
  assert.strictEqual(namelessSends.length, 1);
  assert.ok(namelessSends[0].html.indexOf('¡Hola!') !== -1);
  assert.ok(namelessSends[0].html.indexOf('¡Hola,') === -1);

  console.log('OK unit-affiliate-welcome-email');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
