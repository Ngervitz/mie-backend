/**
 * Temporary smoke test for accent-insensitive mention detection.
 * Run: node scripts/test-detector-accents.js
 */

const {
  detectMentions,
  detectCredizona,
} = require('../src/services/ai-visibility/detector');

const cases = [
  {
    id: 'a',
    text: 'Pago Después es una opción',
    entities: [{ id: 1, name: 'Pago Despues', aliases: [] }],
    expectMatch: true,
  },
  {
    id: 'b',
    text: 'Itaú y Santander destacan',
    entities: [{ id: 2, name: 'Itau', aliases: [] }],
    expectMatch: true,
  },
  {
    id: 'c',
    text: 'esto no menciona nada relevante',
    entities: [{ id: 3, name: 'Pago Despues', aliases: [] }],
    expectMatch: false,
  },
];

let failed = 0;

for (const testCase of cases) {
  const mentions = detectMentions(testCase.text, testCase.entities);
  const credizona = detectCredizona(testCase.text);
  const didMatch = mentions.length > 0;
  const ok = didMatch === testCase.expectMatch;

  if (!ok) failed += 1;

  console.log(`\n=== Case ${testCase.id} ===`);
  console.log('text:', JSON.stringify(testCase.text));
  console.log('entity:', JSON.stringify(testCase.entities[0]));
  console.log('expected match:', testCase.expectMatch);
  console.log('actual match:', didMatch);
  console.log('pass:', ok ? 'YES' : 'NO');
  console.log('mentioned_entities:', JSON.stringify(mentions, null, 2));
  if (mentions[0]) {
    console.log('matched_text:', JSON.stringify(mentions[0].matched_text));
    console.log('first_index:', mentions[0].first_index);
  }
  console.log('detectCredizona:', credizona);
}

console.log(`\nSummary: ${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed ? 1 : 0;
