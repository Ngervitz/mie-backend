'use strict';

/**
 * Stage 2A unit tests — purpose, render, unsubscribe token, suppression helpers.
 *
 * node scripts/unit-email-stage2a.js
 */

const assert = require('assert');
const path = require('path');

const TEST_SECRET = 'test-email-unsubscribe-secret';

// Inject secret BEFORE loading modules that read env / unsubscribeToken.
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = TEST_SECRET;

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
    sessionSecret: 'test-session-MUST-NOT-BE-USED-FOR-UNSUB',
    cronSecret: null,
    czTrackingHmacSecret: null,
    emailUnsubscribeHmacSecret: TEST_SECRET,
  },
};

const {
  EMAIL_PURPOSES,
  assertValidEmailPurpose,
  isValidEmailPurpose,
} = require('../src/services/email-campaigns/purposes');

const {
  NOMBRE_FALLBACK,
  normalizeTemplateVars,
  renderOutboundEmail,
} = require('../src/services/email-campaigns/renderTemplate');

const {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  getUnsubscribeSecret,
} = require('../src/services/email-campaigns/unsubscribeToken');

const {
  buildTerminalFailPatch,
  ERROR_SUPPRESSED,
  normalizeEmail,
} = require('../src/services/email-campaigns/processor');

// --- purpose ---
assert.strictEqual(
  EMAIL_PURPOSES.RECHAZADOS_SURVEY_INVITE,
  'rechazados_survey_invite',
);
assert.strictEqual(isValidEmailPurpose('rechazados_survey_invite'), true);
assert.strictEqual(isValidEmailPurpose('nope'), false);
assert.strictEqual(isValidEmailPurpose(null), false);
assert.doesNotThrow(function () {
  assertValidEmailPurpose('rechazados_survey_invite');
});
assert.throws(function () {
  assertValidEmailPurpose('other');
}, /invalid email purpose/);

// --- render: legacy (null purpose) identity-ish ---
const legacy = renderOutboundEmail({
  purpose: null,
  subject: 'Hola',
  bodyHtml: '<p>x</p>',
  templateVars: {},
});
assert.strictEqual(legacy.ok, true);
assert.strictEqual(legacy.subject, 'Hola');
assert.strictEqual(legacy.html, '<p>x</p>');

// --- render: survey invite requires urls ---
const missingSurvey = renderOutboundEmail({
  purpose: 'rechazados_survey_invite',
  subject: 'Hi {{nombre}}',
  bodyHtml: '<a href="{{survey_url}}">s</a> {{unsubscribe_url}}',
  templateVars: { unsubscribe_url: 'https://x/u' },
});
assert.strictEqual(missingSurvey.ok, false);
assert.strictEqual(
  missingSurvey.errorReason,
  'missing_required_template_var:survey_url',
);

const missingUnsub = renderOutboundEmail({
  purpose: 'rechazados_survey_invite',
  subject: 'Hi',
  bodyHtml: 'x',
  templateVars: { survey_url: 'https://x/s' },
});
assert.strictEqual(missingUnsub.ok, false);
assert.strictEqual(
  missingUnsub.errorReason,
  'missing_required_template_var:unsubscribe_url',
);

const okRender = renderOutboundEmail({
  purpose: 'rechazados_survey_invite',
  subject: 'Hola {{nombre}}',
  bodyHtml:
    '<p><a href="{{survey_url}}">Encuesta</a></p><p><a href="{{unsubscribe_url}}">Baja</a></p>',
  templateVars: {
    survey_url: 'https://www.credizona.com.uy/solicitudes/sinoferta?lrw=ABC',
    unsubscribe_url: 'https://s.credizona.net/email/unsubscribe?t=tok',
  },
});
assert.strictEqual(okRender.ok, true);
assert.strictEqual(okRender.subject, 'Hola ' + NOMBRE_FALLBACK);
assert.ok(okRender.html.indexOf('lrw=ABC') !== -1);
assert.ok(okRender.html.indexOf('unsubscribe?t=tok') !== -1);

const named = renderOutboundEmail({
  purpose: 'rechazados_survey_invite',
  subject: 'Hola {{nombre}}',
  bodyHtml: '{{survey_url}} {{unsubscribe_url}}',
  templateVars: {
    nombre: '  Ana  ',
    survey_url: 'https://s.example/survey',
    unsubscribe_url: 'https://s.example/unsub',
  },
});
assert.strictEqual(named.ok, true);
assert.strictEqual(named.subject, 'Hola Ana');

assert.deepStrictEqual(normalizeTemplateVars({ nombre: '  ', foo: 1 }), {
  foo: '1',
});

// --- unsubscribe token ---
assert.strictEqual(getUnsubscribeSecret(), TEST_SECRET);
const token = signUnsubscribeToken('User@Example.com');
const verified = verifyUnsubscribeToken(token);
assert.strictEqual(verified.ok, true);
assert.strictEqual(verified.email, 'user@example.com');

const bad = verifyUnsubscribeToken(token.slice(0, -2) + 'xx');
assert.strictEqual(bad.ok, false);

const url = buildUnsubscribeUrl('https://s.credizona.net/', 'a@b.co');
assert.ok(url.startsWith('https://s.credizona.net/email/unsubscribe?t='));
assert.ok(url.indexOf('@') === -1);

// --- secret missing: no SESSION_SECRET fallback ---
const unsubModulePath = require.resolve(
  '../src/services/email-campaigns/unsubscribeToken',
);
delete require.cache[unsubModulePath];
delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
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
    sessionSecret: 'test-session-MUST-NOT-BE-USED-FOR-UNSUB',
    cronSecret: null,
    czTrackingHmacSecret: null,
    emailUnsubscribeHmacSecret: null,
  },
};

const unsubNoSecret = require('../src/services/email-campaigns/unsubscribeToken');
assert.strictEqual(unsubNoSecret.getUnsubscribeSecret(), null);
assert.throws(function () {
  unsubNoSecret.signUnsubscribeToken('a@b.co');
}, /EMAIL_UNSUBSCRIBE_HMAC_SECRET is not configured/);
const verifyMissing = unsubNoSecret.verifyUnsubscribeToken(token);
assert.strictEqual(verifyMissing.ok, false);
assert.strictEqual(verifyMissing.reason, 'secret_missing');

// Restore secret module for any later requires
delete require.cache[unsubModulePath];
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = TEST_SECRET;
require.cache[envPath].exports.emailUnsubscribeHmacSecret = TEST_SECRET;

// --- terminal fail patch / normalize ---
const term = buildTerminalFailPatch('2026-09-13T12:00:00.000Z', ERROR_SUPPRESSED);
assert.strictEqual(term.status, 'failed');
assert.strictEqual(term.error_reason, 'email_suppressed');
assert.strictEqual(term.next_attempt_at, null);
assert.strictEqual(normalizeEmail('  A@B.Co '), 'a@b.co');

console.log('unit-email-stage2a: OK');
console.log(
  JSON.stringify({
    purpose: true,
    render: true,
    unsubscribe_token: true,
    secret_missing_no_session_fallback: true,
    terminal_suppression_patch: true,
    note: '2A partial — attempt idempotency TBD_FOR_STAGE_2B',
  }),
);
