'use strict';

/**
 * node scripts/unit-affiliate-join-pages.js
 * Public /affiliates/join + /affiliates/terms and join gate.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { hashOtp } = require('../src/lib/affiliateOtp');
const {
  startLocalAffiliateJoinServer,
} = require('./affiliate-join-local-server');

const OTP_SECRET = 'unit-affiliate-otp-hmac-secret-xxxxx';
const TERMS_INC = path.join(
  __dirname,
  '..',
  'public',
  'affiliates',
  'affiliate-terms-v1.inc.html',
);

async function getText(origin, urlPath) {
  const res = await fetch(origin + urlPath);
  const text = await res.text();
  return { status: res.status, text: text };
}

async function postJson(base, urlPath, body, headers) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_e) {
    json = null;
  }
  return { status: res.status, body: json };
}

async function main() {
  const h = await startLocalAffiliateJoinServer({ joinEnabled: true });
  const origin = h.origin;
  const base = h.base;
  const store = h.store;

  const join = await getText(origin, '/affiliates/join');
  assert.strictEqual(join.status, 200);
  assert.ok(join.text.indexOf('Recomendá Credizona y ganá $500') !== -1);
  assert.ok(join.text.indexOf('viewport') !== -1);
  assert.ok(join.text.indexOf('/affiliates/terms') !== -1);

  const terms = await getText(origin, '/affiliates/terms');
  assert.strictEqual(terms.status, 200);
  assert.ok(terms.text.indexOf('Programa de Afiliados Credizona') !== -1);
  assert.ok(terms.text.indexOf('Versión preliminar 1.0') !== -1);
  assert.ok(terms.text.indexOf('affiliate_v1') !== -1);
  assert.ok(terms.text.indexOf('Mi Plan') === -1, 'must not use loan-application T&C');

  const inc = fs.readFileSync(TERMS_INC, 'utf8');
  assert.ok(inc.indexOf('TERMS_LEGAL_BODY_PENDING') === -1, 'terms inc must not contain placeholder');
  assert.ok(inc.indexOf('data-terms-placeholder') === -1, 'terms inc must not be placeholder markup');
  assert.ok(terms.text.indexOf('data-terms-placeholder') === -1);
  assert.ok(inc.length > 500, 'terms inc must not be empty or truncated');

  const articleTitles = [
    '1. Objeto del programa',
    '2. Inscripción',
    '3. Enlace personal',
    '4. Recompensa',
    '5. Evaluación y otorgamiento de préstamos',
    '6. Confirmación y pago',
    '7. Conductas prohibidas',
    '8. Información y privacidad',
    '9. Modificaciones y finalización',
    '10. Aceptación',
    '11. Legislación aplicable',
  ];
  for (let i = 0; i < articleTitles.length; i += 1) {
    assert.ok(
      terms.text.indexOf(articleTitles[i]) !== -1,
      'missing article: ' + articleTitles[i],
    );
  }
  assert.ok(terms.text.indexOf('$500') !== -1);
  assert.ok(terms.text.indexOf('20 días corridos') !== -1);
  assert.ok(terms.text.indexOf('60 días corridos') !== -1);
  assert.ok(terms.text.indexOf('COPANEL S.A.') !== -1);
  const h2Count = (terms.text.match(/<h2>/g) || []).length;
  assert.strictEqual(h2Count, 11, 'expected 11 article headings');

  const css = await getText(origin, '/affiliates/affiliates.css');
  assert.strictEqual(css.status, 200);
  assert.ok(css.text.indexOf('--cz-accent') !== -1);

  const cfg = await fetch(base + '/config');
  const cfgJson = await cfg.json();
  assert.strictEqual(cfgJson.join_enabled, true);

  store.addSolicitud({ ci: 11111111, celular: '099888777' });
  const invite = store.addInvite({ ci: 11111111 });
  const val = await postJson(base, '/invite/validate', { t: invite.raw });
  assert.strictEqual(val.status, 200);
  const accepted = await postJson(base, '/terms/accept', {
    session_token: val.body.session_token,
    terms_version: 'affiliate_v1',
    accept: true,
  });
  const otpSend = await postJson(base, '/otp/send', {
    session_token: accepted.body.session_token,
  });
  assert.strictEqual(otpSend.status, 200);
  const challenge = store.tables.affiliate_otp_challenges[0];
  challenge.otp_hash = hashOtp('424242', OTP_SECRET);
  const verified = await postJson(base, '/otp/verify', {
    session_token: otpSend.body.session_token,
    otp: '424242',
  });
  assert.strictEqual(verified.status, 200);

  await h.close();

  const hOff = await startLocalAffiliateJoinServer({ joinEnabled: false });
  const blocked = await postJson(hOff.base, '/invite/validate', { t: invite.raw });
  assert.strictEqual(blocked.status, 403);
  const joinOff = await getText(hOff.origin, '/affiliates/join');
  assert.strictEqual(joinOff.status, 200);
  assert.ok(joinOff.text.indexOf('Recomendá Credizona') !== -1);
  await hOff.close();

  console.log('unit-affiliate-join-pages: ok');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
