'use strict';

const assert = require('assert');
const {
  planAffiliateInsert,
  planAffiliateLandingOptInInsert,
  listCell,
  describeOutcome,
  describeAffiliateAdhesion,
  splitAttributions,
} = require('../src/lib/affiliateDirectory');

const AT = '2026-10-22T18:00:00.000Z';

{
  const missing = planAffiliateInsert({ code: 'real01', ci: 12345678 }, AT);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error, 'Falta la aceptación documentada');
}

{
  const real = planAffiliateInsert({
    code: 'real01',
    ci: '12345678',
    acceptance_channel: 'dashboard',
    terms_version: '2026-10-22',
    acceptance_evidence: 'acta-mesa-14',
  }, AT);
  assert.strictEqual(real.ok, true);
  assert.strictEqual(real.row.is_test, false);
  assert.strictEqual(real.row.ci, 12345678);
  assert.strictEqual(real.row.status, 'active');
  assert.strictEqual(real.row.accepted_at, AT);
  assert.strictEqual(real.row.acceptance_evidence, 'acta-mesa-14');
}

{
  const landing = planAffiliateLandingOptInInsert(
    {
      ci: 87654321,
      code: 'LAND01',
      terms_version: 'affiliate_v1',
      invite_token_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      otp_challenge_id: 'ffffffff-1111-4222-8222-222222222222',
    },
    AT,
  );
  assert.strictEqual(landing.ok, true);
  assert.strictEqual(landing.row.acceptance_channel, 'affiliate_landing_otp');
  assert.ok(landing.row.acceptance_evidence.indexOf('|otp:') > 0);
}

{
  const test = planAffiliateInsert({ code: 'test01', is_test: true }, AT);
  assert.strictEqual(test.ok, true);
  assert.strictEqual(test.row.ci, null);
  assert.strictEqual(test.row.accepted_at, null);
  assert.strictEqual(test.row.is_test, true);
}

{
  const external = planAffiliateInsert({ code: 'ext001', ci: null }, AT);
  assert.strictEqual(external.ok, false);
}

{
  const pending = describeOutcome(null);
  assert.strictEqual(pending.kind, 'pending');
  assert.strictEqual(pending.detail, 'Sin evaluar');
  const plain = describeOutcome('no_click');
  assert.strictEqual(plain.kind, 'recorded');
  assert.strictEqual(plain.detail, 'Sin clic');
  const excluded = describeOutcome('excluded_prior_solicitud');
  assert.strictEqual(excluded.kind, 'excluded');
  assert.strictEqual(excluded.label, 'Solicitud anterior registrada');
  assert.ok(excluded.detail.indexOf('REF · Excluido · ') === 0);
}

{
  const { formatAffiliateDisplayName } = require('../src/lib/affiliateDirectory');
  assert.strictEqual(formatAffiliateDisplayName('Ana', 'Pérez', 123), 'Ana Pérez');
  assert.strictEqual(formatAffiliateDisplayName(null, null, 12345678), '12345678');
}

{
  const cell = listCell({
    isAffiliate: true,
    isTest: false,
    status: 'active',
    attributedCzIds: [30, 10],
  });
  assert.strictEqual(cell.ref, 'REF 2');
  assert.deepStrictEqual(cell.attributed_cz_ids, [10, 30]);
  assert.ok(cell.tooltip.indexOf('10, 30') !== -1);
  assert.ok(cell.tooltip.indexOf('No marca al resto de solicitudes de la CI.') !== -1);
  const one = listCell({
    isAffiliate: false,
    isTest: false,
    status: null,
    attributedCzIds: [10],
  });
  assert.strictEqual(one.is_affiliate, false);
  assert.strictEqual(one.ref, 'REF');
}

{
  const split = splitAttributions([
    { cz_id: 1, ci: 9, outcome: 'attributed' },
    { cz_id: 2, ci: 9, outcome: 'expired' },
    { cz_id: 3, ci: 9, outcome: 'no_click' },
  ]);
  assert.strictEqual(split.attributed_count, 1);
  assert.strictEqual(split.excluded_count, 1);
  assert.strictEqual(split.recorded_count, 1);
  assert.strictEqual(split.recorded[0].detail, 'Sin clic');
}

{
  const otp = describeAffiliateAdhesion({
    is_test: false,
    status: 'active',
    accepted_at: AT,
    acceptance_channel: 'affiliate_landing_otp',
    terms_version: 'affiliate_v1',
    acceptance_evidence:
      'invite:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee|otp:ffffffff-1111-4222-8222-222222222222|terms:affiliate_v1',
  });
  assert.ok(otp.summary.indexOf('Bases affiliate_v1') >= 0);
  assert.ok(otp.summary.indexOf('OTP documentado') >= 0);
  assert.ok(otp.detail.indexOf('Canal de inscripción') >= 0);
  assert.ok(otp.detail.indexOf('evidencia almacenada') >= 0);
}

{
  const test = describeAffiliateAdhesion({ is_test: true, status: 'active' });
  assert.strictEqual(test.summary, 'Prueba');
}

console.log('unit-affiliate-directory: ok');
