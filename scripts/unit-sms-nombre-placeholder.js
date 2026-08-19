'use strict';

/**
 * node scripts/unit-sms-nombre-placeholder.js
 */

const assert = require('assert');
const {
  titleCaseNombre,
  applyNombrePlaceholder,
  composeSmsText,
  normalizeDirectedPhones,
  SMS_MAX_MESSAGE_CHARS,
} = require('../src/lib/smsCampaignContacts');

function composedLen(body, link) {
  return Array.from(composeSmsText(body, link)).length;
}

assert.strictEqual(titleCaseNombre('ELSA MACHADO'), 'Elsa Machado');
assert.strictEqual(titleCaseNombre('maría del valle'), 'María Del Valle');
assert.strictEqual(titleCaseNombre('  '), '');
assert.strictEqual(titleCaseNombre(null), '');

assert.strictEqual(
  applyNombrePlaceholder('Hola {{nombre}}, tu link', 'ELSA MACHADO'),
  'Hola Elsa Machado, tu link',
);
assert.strictEqual(
  applyNombrePlaceholder('Hola {{nombre}}, tu link', null),
  'Hola, tu link',
);
assert.strictEqual(
  applyNombrePlaceholder('Hola {{nombre}}!', ''),
  'Hola!',
);
assert.strictEqual(
  applyNombrePlaceholder('Hola, tu link', 'Ana'),
  'Hola, tu link',
);

assert.deepStrictEqual(normalizeDirectedPhones([' 59891 ', '', '59891', '59892']), [
  '59891',
  '59892',
]);
assert.deepStrictEqual(normalizeDirectedPhones([]), []);

assert.strictEqual(SMS_MAX_MESSAGE_CHARS, 160);

const shortLink = 'https://tinyurl.com/abcd';
const fitsBody = applyNombrePlaceholder(
  'Hola {{nombre}}, tu link',
  'María del Valle',
  { link: shortLink, maxChars: SMS_MAX_MESSAGE_CHARS },
);
assert.strictEqual(fitsBody, 'Hola María Del Valle, tu link');
assert.ok(composedLen(fitsBody, shortLink) <= SMS_MAX_MESSAGE_CHARS);

const pad = 'x'.repeat(120);
const tightLink = 'L'.repeat(20);
const tightTemplate = 'Hola {{nombre}}, ' + pad;
const truncatedBody = applyNombrePlaceholder(tightTemplate, 'maría del valle', {
  link: tightLink,
  maxChars: SMS_MAX_MESSAGE_CHARS,
});
assert.strictEqual(truncatedBody, 'Hola María Del Va, ' + pad);
assert.ok(
  truncatedBody.indexOf(pad) !== -1,
  'fixed message text must not be truncated',
);
assert.ok(!truncatedBody.includes('Valle'));
assert.strictEqual(composedLen(truncatedBody, tightLink), SMS_MAX_MESSAGE_CHARS);

const anaBody = applyNombrePlaceholder(tightTemplate, 'Ana', {
  link: tightLink,
  maxChars: SMS_MAX_MESSAGE_CHARS,
});
assert.strictEqual(anaBody, 'Hola Ana, ' + pad);
assert.ok(composedLen(anaBody, tightLink) <= SMS_MAX_MESSAGE_CHARS);
assert.notStrictEqual(
  anaBody,
  truncatedBody,
  'different names must truncate independently',
);

const omitPad = 'x'.repeat(131);
const omitTemplate = 'Hola {{nombre}}, ' + omitPad;
const omitted = applyNombrePlaceholder(omitTemplate, 'María del Valle', {
  link: tightLink,
  maxChars: SMS_MAX_MESSAGE_CHARS,
});
assert.strictEqual(omitted, 'Hola, ' + omitPad);
assert.ok(composedLen(omitted, tightLink) <= SMS_MAX_MESSAGE_CHARS);
assert.ok(!/\bM/.test(omitted.replace(omitPad, '')));

const oneChar = applyNombrePlaceholder('Hola {{nombre}}, ok', 'A', {
  link: shortLink,
  maxChars: SMS_MAX_MESSAGE_CHARS,
});
assert.strictEqual(oneChar, 'Hola, ok');

const linkCountsTemplate = 'Hola {{nombre}} ' + 'y'.repeat(130);
const withoutLink = applyNombrePlaceholder(
  linkCountsTemplate,
  'María del Valle',
);
const withLink = applyNombrePlaceholder(linkCountsTemplate, 'María del Valle', {
  link: tightLink,
  maxChars: SMS_MAX_MESSAGE_CHARS,
});
assert.ok(withoutLink.indexOf('María Del Valle') !== -1);
assert.ok(withLink.length < withoutLink.length);
assert.ok(composedLen(withLink, tightLink) <= SMS_MAX_MESSAGE_CHARS);

console.log('OK unit-sms-nombre-placeholder');
