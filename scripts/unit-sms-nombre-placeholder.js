'use strict';

/**
 * node scripts/unit-sms-nombre-placeholder.js
 */

const assert = require('assert');
const {
  titleCaseNombre,
  applyNombrePlaceholder,
  normalizeDirectedPhones,
} = require('../src/lib/smsCampaignContacts');

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

console.log('OK unit-sms-nombre-placeholder');
