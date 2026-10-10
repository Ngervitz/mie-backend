'use strict';

/**
 * Regression: ELM S1 answered {"success":false,"result":"Repetido. Rechazado"} for the documented
 * "Repetido. rechazado". S1 rejection texts compare ignoring letter case only; every other list
 * (S1 favorable, BCU error, all of S2) stays exact, and undocumented texts stay unknown.
 * "Mocasist" ({"success":false,"result":"Mocasist"}, solicitud 1421) is a documented S1 rejection.
 * Pure functions only: no network, no database.
 *
 * Run: node scripts/unit-elm-response-case.js
 */

const assert = require('assert');

const { OUTCOME, CODES, S1, S2 } = require('../src/services/elm/constants');
const {
  SERVICE1_POSITIVE,
  SERVICE1_NEGATIVE,
  SERVICE1_DUPLICATE_OTHER_CHANNEL,
  SERVICE1_TECHNICAL,
  SERVICE2_POSITIVE,
  SERVICE2_NEGATIVE,
  isService1Negative,
  isService1DuplicateOtherChannel,
  classifyService1Response,
  classifyService2Response,
  createNetSuiteElmClient,
} = require('../src/services/elm/client');
const { classifyElmProcess, blocksSurveyInvite, COMMERCIAL } = require('../src/services/elm/classification');
const { deriveFromProcess } = require('../src/services/providerFallback/outcome');
const { OUTCOME: FB_OUTCOME, REASONS } = require('../src/services/providerFallback/constants');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack : err));
  }
}

const NOW = Date.parse('2026-10-09T19:40:00Z');
const iso = (ms) => new Date(ms).toISOString();

function proc(over) {
  return Object.assign(
    {
      id: 'a9731690-3400-456f-bcd6-8dd9726c1657',
      cz_solicitud_id: 1430,
      ci: 51001152,
      trigger_origin: 'janus_manual',
      s1_status: S1.REJECTED,
      s1_result_message: null,
      s1_attempts: 2,
      s1_started_at: iso(NOW - 60000),
      s1_completed_at: iso(NOW - 59000),
      s1_lease_expires_at: null,
      s2_status: S2.NOT_STARTED,
      s2_result_message: null,
      referred_at: null,
      disbursed_at: null,
      ops_resolved_at: null,
      ops_resolution_code: null,
    },
    over,
  );
}

const UNDOCUMENTED_S1 = [
  'Repetido - Rechazado',
  'Repetido rechazado',
  'Repetido.Rechazado',
  'Repetido.  Rechazado',
  'Repetido. Rechazado por asesor',
  'Repetido',
  'Rechazado',
  'Repetido.Aprobado',
  'Repetido aprobado',
  'Repetido. Aprobado por asesor',
  'Aprobado',
  'Repetído. Rechazado',
  '',
  'Algo nuevo',
];

(async function main() {
  await test('1 both duplicate variants are a documented S1 rejection', () => {
    for (const text of ['Repetido. rechazado', 'Repetido. Rechazado', 'REPETIDO. RECHAZADO', '  repetido. rechazado  ']) {
      assert.deepStrictEqual(classifyService1Response(text), { outcome: OUTCOME.NEGATIVE, errorCode: null }, text);
      assert.strictEqual(isService1Negative(text), true, text);
    }
  });

  await test('2 every documented S1 rejection accepts a letter-case variant', () => {
    for (const text of SERVICE1_NEGATIVE) {
      for (const v of [text, text.toUpperCase(), text.toLowerCase()]) {
        assert.strictEqual(classifyService1Response(v).outcome, OUTCOME.NEGATIVE, v);
      }
    }
  });

  await test('3 undocumented texts stay unknown (never a rejection)', () => {
    for (const text of UNDOCUMENTED_S1) {
      assert.deepStrictEqual(classifyService1Response(text), { outcome: OUTCOME.UNKNOWN, errorCode: null }, JSON.stringify(text));
      assert.strictEqual(isService1Negative(text), false, JSON.stringify(text));
    }
    for (const raw of [null, undefined, 42, {}, ['Repetido. Rechazado']]) {
      assert.strictEqual(classifyService1Response(raw).outcome, OUTCOME.UNKNOWN);
      assert.strictEqual(isService1Negative(raw), false);
    }
  });

  await test('4 S1 favorable and BCU error stay exact; S2 lists stay exact', () => {
    for (const text of SERVICE1_POSITIVE) {
      assert.strictEqual(classifyService1Response(text).outcome, OUTCOME.POSITIVE);
      assert.strictEqual(classifyService1Response(text.toLowerCase()).outcome, OUTCOME.UNKNOWN);
      assert.strictEqual(classifyService1Response(text.toUpperCase()).outcome, OUTCOME.UNKNOWN);
    }
    for (const text of Object.keys(SERVICE1_TECHNICAL)) {
      assert.deepStrictEqual(classifyService1Response(text), {
        outcome: OUTCOME.TECHNICAL_ERROR,
        errorCode: SERVICE1_TECHNICAL[text],
      });
      for (const v of [text.toLowerCase(), text.toUpperCase()]) {
        assert.deepStrictEqual(classifyService1Response(v), { outcome: OUTCOME.UNKNOWN, errorCode: null }, v);
      }
    }
    for (const text of SERVICE2_POSITIVE) {
      assert.strictEqual(classifyService2Response(text).outcome, OUTCOME.POSITIVE);
      assert.strictEqual(classifyService2Response(text.toLowerCase()).outcome, OUTCOME.UNKNOWN);
    }
    for (const text of SERVICE2_NEGATIVE) {
      assert.strictEqual(classifyService2Response(text).outcome, OUTCOME.NEGATIVE);
      assert.strictEqual(classifyService2Response(text.toUpperCase()).outcome, OUTCOME.UNKNOWN);
    }
    assert.strictEqual(classifyService2Response('Repetido. Rechazado').outcome, OUTCOME.UNKNOWN, 'S1 texts are not S2 answers');
  });

  await test('5 no S1 rejection collides with a favorable or technical text once case is ignored', () => {
    const negatives = new Set(SERVICE1_NEGATIVE.map((s) => s.toLowerCase()));
    for (const s of SERVICE1_POSITIVE.concat(Object.keys(SERVICE1_TECHNICAL), SERVICE1_DUPLICATE_OTHER_CHANNEL)) {
      assert.ok(!negatives.has(s.toLowerCase()), s);
    }
    assert.strictEqual(negatives.size, SERVICE1_NEGATIVE.length, 'no duplicate keys');
    const duplicates = new Set(SERVICE1_DUPLICATE_OTHER_CHANNEL.map((s) => s.toLowerCase()));
    for (const s of SERVICE1_POSITIVE.concat(Object.keys(SERVICE1_TECHNICAL))) {
      assert.ok(!duplicates.has(s.toLowerCase()), s);
    }
  });

  await test('6 transport keeps the original text and body for audit', async () => {
    const body = { result: 'Repetido. Rechazado', success: false, docNumber: '51001152' };
    const client = createNetSuiteElmClient({
      transport: {
        realm: 'TEST',
        service1Url: 'https://example.invalid/s1',
        service2Url: 'https://example.invalid/s2',
        credentials: { consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
      },
      timeoutMs: 1000,
      fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify(body) }),
      now: () => NOW,
      nonce: () => 'n',
    });
    const r = await client.service1({ docNumber: '51001152' });
    assert.strictEqual(r.outcome, OUTCOME.NEGATIVE);
    assert.strictEqual(r.errorCode, null);
    assert.strictEqual(r.httpStatus, 200);
    assert.strictEqual(r.resultMessage, 'Repetido. Rechazado', 'received text, not the documented spelling');
    assert.deepStrictEqual(r.responseBody, body, 'full response kept (success:false included)');

    const unknown = await createNetSuiteElmClient({
      transport: {
        realm: 'TEST',
        service1Url: 'https://example.invalid/s1',
        service2Url: 'https://example.invalid/s2',
        credentials: { consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
      },
      timeoutMs: 1000,
      fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ success: false, result: 'Repetido - Rechazado' }) }),
      now: () => NOW,
      nonce: () => 'n',
    }).service1({ docNumber: '1' });
    assert.strictEqual(unknown.outcome, OUTCOME.UNKNOWN);
    assert.strictEqual(unknown.errorCode, CODES.RESPONSE_UNDOCUMENTED);
    assert.strictEqual(unknown.resultMessage, 'Repetido - Rechazado');
  });

  await test('7 commercial label: persisted S1 rejection with either spelling is "Rechazado ELM (S1)"', () => {
    for (const text of ['Repetido. rechazado', 'Repetido. Rechazado']) {
      const c = classifyElmProcess(proc({ s1_result_message: text }), { nowMs: NOW });
      assert.strictEqual(c.state, COMMERCIAL.REJECTED, text);
      assert.strictEqual(c.detail, 's1_negative', text);
    }
    for (const text of UNDOCUMENTED_S1) {
      const c = classifyElmProcess(proc({ s1_result_message: text }), { nowMs: NOW });
      assert.strictEqual(c.state, COMMERCIAL.REVIEW, JSON.stringify(text));
      assert.strictEqual(c.detail, 's1_rejection_not_definitive', JSON.stringify(text));
    }
  });

  await test('8 rows already persisted as unknown are not reclassified (1430 stays in review)', () => {
    const p1430 = proc({ s1_status: S1.UNKNOWN, s1_result_message: 'Repetido. Rechazado' });
    const c = classifyElmProcess(p1430, { nowMs: NOW });
    assert.strictEqual(c.state, COMMERCIAL.REVIEW);
    assert.strictEqual(c.detail, 's1_unknown');
    const d = deriveFromProcess(p1430, NOW, null);
    assert.strictEqual(d.kind, 'final');
    assert.strictEqual(d.outcome, FB_OUTCOME.MANUAL_REVIEW);
    assert.strictEqual(d.reasonCode, REASONS.ELM_S1_UNKNOWN);
  });

  await test('9 fallback outcome: either spelling is a definitive rejection; others manual review', () => {
    for (const text of ['Repetido. rechazado', 'Repetido. Rechazado']) {
      const d = deriveFromProcess(proc({ s1_result_message: text }), NOW, null);
      assert.strictEqual(d.kind, 'final', text);
      assert.strictEqual(d.outcome, FB_OUTCOME.REJECTED, text);
      assert.strictEqual(d.reasonCode, REASONS.ELM_S1_REJECTED, text);
    }
    for (const text of UNDOCUMENTED_S1) {
      const d = deriveFromProcess(proc({ s1_result_message: text }), NOW, null);
      assert.strictEqual(d.outcome, FB_OUTCOME.MANUAL_REVIEW, JSON.stringify(text));
      assert.strictEqual(d.reasonCode, REASONS.ELM_S1_REJECTION_NOT_DEFINITIVE, JSON.stringify(text));
    }
  });

  await test('10 approval, grant and other errors keep their classification', () => {
    const referred = classifyElmProcess(
      proc({ s1_status: S1.ELIGIBLE, s1_result_message: SERVICE1_POSITIVE[0], s2_status: S2.REFERRED, referred_at: iso(NOW) }),
      { nowMs: NOW },
    );
    assert.strictEqual(referred.state, COMMERCIAL.REFERRED);
    const granted = classifyElmProcess(
      proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, referred_at: iso(NOW), disbursed_at: iso(NOW) }),
      { nowMs: NOW },
    );
    assert.strictEqual(granted.state, COMMERCIAL.GRANTED);
    const tech = classifyElmProcess(proc({ s1_status: S1.TECHNICAL_ERROR, s1_result_message: 'BCU error' }), { nowMs: NOW });
    assert.strictEqual(tech.detail, 's1_technical_error');
    const s2rej = classifyElmProcess(
      proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REJECTED, s2_result_message: 'telefono no válido' }),
      { nowMs: NOW },
    );
    assert.strictEqual(s2rej.state, COMMERCIAL.REVIEW, 'S2 rejection texts stay exact');
  });

  const MOCASIST_VARIANTS = ['Mocasist', 'MOCASIST', 'mocasist', 'mOcAsIsT', '  Mocasist  ', '\tMocasist\n'];
  const NOT_MOCASIST = ['Mocasist.', 'Moca sist', 'Mocasist rechazado', 'Mocásist', 'Mocasis', 'Mocasist - Rechazado'];

  await test('11 Mocasist is a documented S1 rejection in any letter case, surrounding spaces ignored', () => {
    assert.ok(SERVICE1_NEGATIVE.includes('Mocasist'));
    for (const text of MOCASIST_VARIANTS) {
      assert.deepStrictEqual(classifyService1Response(text), { outcome: OUTCOME.NEGATIVE, errorCode: null }, JSON.stringify(text));
      assert.strictEqual(isService1Negative(text), true, JSON.stringify(text));
    }
    for (const text of NOT_MOCASIST) {
      assert.deepStrictEqual(classifyService1Response(text), { outcome: OUTCOME.UNKNOWN, errorCode: null }, JSON.stringify(text));
      assert.strictEqual(isService1Negative(text), false, JSON.stringify(text));
    }
    assert.strictEqual(classifyService2Response('Mocasist').outcome, OUTCOME.UNKNOWN, 'S1 texts are not S2 answers');
  });

  await test('12 transport: Mocasist is a rejection and keeps the received text and body', async () => {
    const body = { result: 'Mocasist', success: false, docNumber: '46816299' };
    const r = await createNetSuiteElmClient({
      transport: {
        realm: 'TEST',
        service1Url: 'https://example.invalid/s1',
        service2Url: 'https://example.invalid/s2',
        credentials: { consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
      },
      timeoutMs: 1000,
      fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify(body) }),
      now: () => NOW,
      nonce: () => 'n',
    }).service1({ docNumber: '46816299' });
    assert.strictEqual(r.outcome, OUTCOME.NEGATIVE);
    assert.strictEqual(r.errorCode, null);
    assert.strictEqual(r.resultMessage, 'Mocasist');
    assert.deepStrictEqual(r.responseBody, body);
  });

  await test('13 persisted Mocasist rejection: "Rechazado ELM (S1)" in the dashboard, elm_s1_rejected in fallback', () => {
    for (const text of MOCASIST_VARIANTS) {
      const p = proc({ cz_solicitud_id: 1421, ci: 46816299, s1_attempts: 1, s1_result_message: text });
      const c = classifyElmProcess(p, { nowMs: NOW });
      assert.strictEqual(c.state, COMMERCIAL.REJECTED, JSON.stringify(text));
      assert.strictEqual(c.detail, 's1_negative', JSON.stringify(text));
      const d = deriveFromProcess(p, NOW, null);
      assert.strictEqual(d.outcome, FB_OUTCOME.REJECTED, JSON.stringify(text));
      assert.strictEqual(d.reasonCode, REASONS.ELM_S1_REJECTED, JSON.stringify(text));
    }
    for (const text of NOT_MOCASIST) {
      const p = proc({ s1_result_message: text });
      assert.strictEqual(classifyElmProcess(p, { nowMs: NOW }).detail, 's1_rejection_not_definitive', JSON.stringify(text));
      assert.strictEqual(deriveFromProcess(p, NOW, null).reasonCode, REASONS.ELM_S1_REJECTION_NOT_DEFINITIVE, JSON.stringify(text));
    }
  });

  await test('14 rows already persisted as unknown are not reclassified (1421 Mocasist, 1430 stay in review)', () => {
    const p1421 = proc({ cz_solicitud_id: 1421, ci: 46816299, s1_status: S1.UNKNOWN, s1_attempts: 1, s1_error_code: CODES.RESPONSE_UNDOCUMENTED, s1_result_message: 'Mocasist' });
    const p1430 = proc({ s1_status: S1.UNKNOWN, s1_error_code: CODES.RESPONSE_UNDOCUMENTED, s1_result_message: 'Repetido. Rechazado' });
    for (const p of [p1421, p1430]) {
      const c = classifyElmProcess(p, { nowMs: NOW });
      assert.strictEqual(c.state, COMMERCIAL.REVIEW, p.cz_solicitud_id);
      assert.strictEqual(c.detail, 's1_unknown', p.cz_solicitud_id);
      assert.strictEqual(deriveFromProcess(p, NOW, null).reasonCode, REASONS.ELM_S1_UNKNOWN, p.cz_solicitud_id);
    }
  });

  await test('15 "Repetido. Aprobado" is a duplicate from another channel (terminal); "Repetido. Rechazado" stays a rejection', async () => {
    const transport = {
      realm: 'TEST',
      service1Url: 'https://example.invalid/s1',
      service2Url: 'https://example.invalid/s2',
      credentials: { consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
    };
    const s1 = (body) =>
      createNetSuiteElmClient({
        transport: transport,
        timeoutMs: 1000,
        fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify(body) }),
        now: () => NOW,
        nonce: () => 'n',
      }).service1({ docNumber: '1' });

    const DUP = { outcome: OUTCOME.DUPLICATE_OTHER_CHANNEL, errorCode: CODES.S1_DUPLICATE_OTHER_CHANNEL };
    for (const text of ['Repetido. Aprobado', 'Repetido. aprobado', 'REPETIDO. APROBADO', '  repetido. aprobado  ']) {
      assert.deepStrictEqual(classifyService1Response(text), DUP, JSON.stringify(text));
      assert.strictEqual(isService1DuplicateOtherChannel(text), true, JSON.stringify(text));
      assert.strictEqual(isService1Negative(text), false, 'never a rejection: ' + JSON.stringify(text));
    }
    assert.ok(!SERVICE1_POSITIVE.includes('Repetido. Aprobado') && !SERVICE1_NEGATIVE.includes('Repetido. Aprobado'));
    assert.strictEqual(classifyService2Response('Repetido. Aprobado').outcome, OUTCOME.UNKNOWN, 'S1 text, not an S2 answer');

    const approvedBody = { result: 'Repetido. Aprobado', success: true, docNumber: '1' };
    const approved = await s1(approvedBody);
    assert.strictEqual(approved.outcome, OUTCOME.DUPLICATE_OTHER_CHANNEL, 'success:true does not make it eligible');
    assert.strictEqual(approved.errorCode, CODES.S1_DUPLICATE_OTHER_CHANNEL);
    assert.strictEqual(approved.resultMessage, 'Repetido. Aprobado', 'original text kept');
    assert.deepStrictEqual(approved.responseBody, approvedBody, 'full response kept');

    const dup = proc({ cz_solicitud_id: 1500, s1_attempts: 1, s1_error_code: CODES.S1_DUPLICATE_OTHER_CHANNEL, s1_result_message: 'Repetido. Aprobado' });
    const c = classifyElmProcess(dup, { nowMs: NOW });
    assert.strictEqual(c.state, COMMERCIAL.CLOSED, 'neither accepted, rejected nor review');
    assert.strictEqual(c.detail, 's1_duplicate_other_channel');
    assert.strictEqual(c.detail_label, 'Duplicado · Otro canal');
    assert.strictEqual(c.stage, 's1');
    assert.strictEqual(blocksSurveyInvite(c), true, 'no rejected-lead survey for a client approved elsewhere');
    const d = deriveFromProcess(dup, NOW, null);
    assert.strictEqual(d.kind, 'final');
    assert.strictEqual(d.outcome, FB_OUTCOME.MANUAL_REVIEW, 'fallback never turns it into a rejection (no CZ 3)');
    assert.strictEqual(d.reasonCode, REASONS.ELM_S1_DUPLICATE_OTHER_CHANNEL);

    const p1341 = proc({ cz_solicitud_id: 1341, ci: 1, s1_status: S1.UNKNOWN, s1_attempts: 1, s1_error_code: CODES.RESPONSE_UNDOCUMENTED, s1_result_message: 'Repetido. Aprobado' });
    const c1341 = classifyElmProcess(p1341, { nowMs: NOW });
    assert.strictEqual(c1341.state, COMMERCIAL.REVIEW, 'historical 1341 is not reclassified');
    assert.strictEqual(c1341.detail, 's1_unknown');
    assert.strictEqual(deriveFromProcess(p1341, NOW, null).reasonCode, REASONS.ELM_S1_UNKNOWN);

    const rejected = await s1({ result: 'Repetido. Rechazado', success: false, docNumber: '1' });
    assert.strictEqual(rejected.outcome, OUTCOME.NEGATIVE);
    assert.strictEqual(rejected.errorCode, null);
    const pRej = proc({ s1_result_message: 'Repetido. Rechazado' });
    assert.strictEqual(classifyElmProcess(pRej, { nowMs: NOW }).state, COMMERCIAL.REJECTED);
    assert.strictEqual(blocksSurveyInvite(classifyElmProcess(pRej, { nowMs: NOW })), false);
    const dRej = deriveFromProcess(pRej, NOW, null);
    assert.strictEqual(dRej.outcome, FB_OUTCOME.REJECTED);
    assert.strictEqual(dRej.reasonCode, REASONS.ELM_S1_REJECTED);
  });

  await test('16 the persisted error code decides the duplicate reading, not the text alone', () => {
    const textWithoutCode = proc({ s1_error_code: null, s1_result_message: 'Repetido. Aprobado' });
    assert.strictEqual(
      classifyElmProcess(textWithoutCode, { nowMs: NOW }).detail,
      's1_rejection_not_definitive',
      'a rejected row without the code is never read as a duplicate',
    );
    const s2Referred = proc({
      s1_status: S1.ELIGIBLE,
      s2_status: S2.REFERRED,
      referred_at: iso(NOW),
      s1_error_code: CODES.S1_DUPLICATE_OTHER_CHANNEL,
    });
    assert.strictEqual(classifyElmProcess(s2Referred, { nowMs: NOW }).state, COMMERCIAL.REFERRED, 'only an S1 rejection reads the code');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
