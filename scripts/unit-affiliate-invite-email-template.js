'use strict';

/**
 * node scripts/unit-affiliate-invite-email-template.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  AFFILIATE_INVITE_EMAIL_SUBJECT,
  AFFILIATE_INVITE_HERO_FILENAME,
  buildAffiliateJoinUrl,
  buildAffiliateTermsUrl,
  buildAffiliateInviteHeroImageUrl,
  renderAffiliateInviteEmail,
  loadTemplateBody,
  TEMPLATE_PATH,
} = require('../src/lib/affiliateInviteEmail');

const joinUrl =
  'https://s.credizona.net/affiliates/join?t=' + encodeURIComponent('unit-test-token');
const termsUrl = buildAffiliateTermsUrl('https://s.credizona.net');
const heroUrl = buildAffiliateInviteHeroImageUrl('https://s.credizona.net');

assert.ok(fs.existsSync(TEMPLATE_PATH));
assert.ok(
  fs.existsSync(
    path.join(__dirname, '..', 'public', 'email-assets', AFFILIATE_INVITE_HERO_FILENAME),
  ),
);

const body = loadTemplateBody();
assert.ok(body.indexOf('{{join_url}}') !== -1);
assert.ok(body.indexOf('{{hero_image_url}}') !== -1);
assert.ok(body.indexOf('{{terms_url}}') !== -1);
assert.ok(body.indexOf('<table') !== -1, 'expects table layout for clients');

const out = renderAffiliateInviteEmail({ joinUrl: joinUrl });
assert.strictEqual(out.ok, true);
assert.strictEqual(out.subject, AFFILIATE_INVITE_EMAIL_SUBJECT);
assert.ok(out.html.indexOf(joinUrl) !== -1);
assert.ok(out.html.indexOf(termsUrl) !== -1);
assert.ok(out.html.indexOf(heroUrl) !== -1);
assert.ok(out.html.indexOf('{{') === -1, 'placeholders must be merged');

const imgWrap = new RegExp(
  '<a[^>]+href="' + joinUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>[\\s\\S]*?<img',
  'i',
);
assert.ok(imgWrap.test(out.html), 'hero image wrapped in join link');

assert.ok(
  out.html.indexOf('participá acá en el programa de afiliados') !== -1,
  'text fallback link',
);
assert.ok(out.html.indexOf('affiliate_v3') !== -1, 'terms footer mentions version');

const extraBtn = out.html.match(/<a[^>]+class="[^"]*btn[^"]*"/gi);
assert.strictEqual(extraBtn, null, 'no extra HTML button');

assert.ok(
  buildAffiliateJoinUrl('abc/+=', 'https://s.credizona.net').indexOf(
    '/affiliates/join?t=',
  ) !== -1,
);

console.log('unit-affiliate-invite-email-template: ok');
