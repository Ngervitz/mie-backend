'use strict';

/**
 * node scripts/unit-sms-campaign-series.js
 *
 * Matrix 1–19 for campaign series + contextual eligibility.
 * In-memory replicas of the new RPCs (CTE + anti-join, NULL series RAISE).
 * These mocks do NOT substitute executing the SQL on real PostgreSQL.
 * Does not apply migrations or change SMS_INDIVIDUAL_TRACKING in the environment.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const prevFlag = process.env.SMS_INDIVIDUAL_TRACKING;

const {
  parseCampaignSeriesId,
  parseSeriesName,
  seriesRequiredBody,
  seriesNotFoundBody,
  partitionPhoneClassifications,
  hasFailClosedProtections,
  buildFailClosedPayload,
} = require('../src/lib/smsCampaignSeries');
const {
  normalizeDirectedPhones,
  resolveEligibleCount,
  resolveNewShapeDestinations,
} = require('../src/lib/smsCampaignContacts');

const SERIES_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SERIES_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTACT_A = '11111111-1111-4111-8111-111111111111';
const CAMP_A1 = 'cccc1111-cccc-4ccc-8ccc-cccccccccccc';
const CAMP_A2 = 'cccc2222-cccc-4ccc-8ccc-cccccccccccc';
const IMPACT_A1 = 'dddd1111-dddd-4ddd-8ddd-dddddddddddd';
const PHONE_A = '099111111';
const PHONE_B = '099222222';
const PHONE_C = '099333333';
const PHONE_EX = '099444444';
const PHONE_OLD = '099555555';

function restoreFlag() {
  if (prevFlag == null) delete process.env.SMS_INDIVIDUAL_TRACKING;
  else process.env.SMS_INDIVIDUAL_TRACKING = prevFlag;
}

function makeSupabase(state) {
  const calls = { rpc: [] };
  return {
    calls: calls,
    from: function (table) {
      return {
        select: function () {
          return {
            in: function (_col, phones) {
              const data = (state.contacts || []).filter(function (c) {
                return phones.indexOf(c.phone) !== -1;
              });
              return Promise.resolve({ data: data, error: null });
            },
          };
        },
      };
    },
    rpc: function (name, args) {
      calls.rpc.push({ name: name, args: args });
      if (typeof state.rpc === 'function') {
        return Promise.resolve(state.rpc(name, args));
      }
      if (name === 'sms_eligible_contacts') {
        return Promise.resolve({ data: state.legacyList || [], error: null });
      }
      if (name === 'sms_eligible_contacts_for_series') {
        return Promise.resolve({ data: state.seriesList || [], error: null });
      }
      if (name === 'sms_eligible_contacts_count') {
        return Promise.resolve({ data: state.legacyCount || 0, error: null });
      }
      if (name === 'sms_eligible_contacts_for_series_count') {
        return Promise.resolve({ data: state.seriesCount || 0, error: null });
      }
      if (name === 'sms_series_protected_clicked_count') {
        return Promise.resolve({
          data: state.protectedCount || 0,
          error: null,
        });
      }
      if (name === 'sms_classify_phones_for_series') {
        return Promise.resolve({ data: state.classify || [], error: null });
      }
      return Promise.resolve({
        data: null,
        error: { message: 'unknown rpc ' + name },
      });
    },
  };
}

function requireCampaignSeriesId(seriesId) {
  if (seriesId == null) {
    const err = new Error('campaign_series_id is required');
    err.code = '22023';
    throw err;
  }
}

function clickedIdentitiesOnce(world, seriesId) {
  requireCampaignSeriesId(seriesId);
  const seen = Object.create(null);
  const rows = [];
  world.messages.forEach(function (m) {
    const camp = world.campaigns.find(function (c) {
      return c.id === m.campaign_id;
    });
    if (!camp || camp.campaign_series_id !== seriesId) return;
    if (!m.marketing_impact_id) return;
    const clicked = world.events.some(function (e) {
      return e.impact_id === m.marketing_impact_id && e.event_name === 'click';
    });
    if (!clicked) return;
    const key = String(m.contact_id || '') + '\0' + String(m.phone || '');
    if (seen[key]) return;
    seen[key] = true;
    rows.push({
      contact_id: m.contact_id || null,
      phone: m.phone || null,
    });
  });
  return rows;
}

function identityHitsContact(cl, contact) {
  return (
    (cl.contact_id != null && cl.contact_id === contact.id) ||
    (cl.phone != null && cl.phone === contact.phone)
  );
}

function eligibleContactsForSeries(contacts, sourceSystem, seriesId, world) {
  const clicked = clickedIdentitiesOnce(world, seriesId);
  return contacts.filter(function (c) {
    if (c.source_system !== sourceSystem) return false;
    if (!String(c.phone || '').trim()) return false;
    if (c.excluded_from_campaigns) return false;
    return !clicked.some(function (cl) {
      return identityHitsContact(cl, c);
    });
  });
}

function classifyPhonesForSeries(phones, seriesId, world) {
  const clicked = clickedIdentitiesOnce(world, seriesId);
  const unique = [];
  const seen = Object.create(null);
  phones.forEach(function (p) {
    const phone = String(p || '').trim();
    if (!phone || seen[phone]) return;
    seen[phone] = true;
    unique.push(phone);
  });
  return unique.map(function (phone) {
    const excludedHit = world.contacts.some(function (c) {
      return c.phone === phone && c.excluded_from_campaigns;
    });
    if (excludedHit) return { phone: phone, protection: 'excluded' };
    const contactByPhone = world.contacts.find(function (c) {
      return c.phone === phone;
    });
    const hit = clicked.some(function (cl) {
      const byId =
        cl.contact_id != null &&
        contactByPhone &&
        contactByPhone.id != null &&
        cl.contact_id === contactByPhone.id;
      const byPhone = cl.phone != null && cl.phone === phone;
      return byId || byPhone;
    });
    return { phone: phone, protection: hit ? 'clicked' : null };
  });
}

function isEligibleForSeries(contact, sourceSystem, seriesId, world) {
  return (
    eligibleContactsForSeries([contact], sourceSystem, seriesId, world)
      .length === 1
  );
}

function classifyPhone(phone, seriesId, world) {
  return classifyPhonesForSeries([phone], seriesId, world)[0].protection;
}

function baseWorld() {
  return {
    contacts: [
      {
        id: CONTACT_A,
        phone: PHONE_A,
        source_system: 'credizona2_datos',
        excluded_from_campaigns: false,
        nombre: 'Ana',
        source_record_id: '1',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        phone: PHONE_B,
        source_system: 'credizona2_datos',
        excluded_from_campaigns: false,
        nombre: 'Beto',
        source_record_id: '2',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        phone: PHONE_EX,
        source_system: 'credizona2_datos',
        excluded_from_campaigns: true,
        nombre: 'Ex',
        source_record_id: '4',
      },
    ],
    campaigns: [
      {
        id: CAMP_A1,
        campaign_series_id: SERIES_A,
      },
    ],
    messages: [
      {
        campaign_id: CAMP_A1,
        contact_id: CONTACT_A,
        phone: PHONE_A,
        marketing_impact_id: IMPACT_A1,
        status: 'sent',
      },
    ],
    events: [],
  };
}

// --- SQL file must not touch legacy RPCs ---
const migPath = path.join(
  __dirname,
  '..',
  'migrations',
  '20260828_marketing_campaign_series.sql',
);
const migSql = fs.readFileSync(migPath, 'utf8');
assert.ok(migSql.indexOf('CREATE TABLE IF NOT EXISTS public.marketing_campaign_series') !== -1);
assert.ok(migSql.indexOf('campaign_series_id uuid NULL') !== -1);
assert.ok(migSql.indexOf('ON DELETE RESTRICT') !== -1);
assert.ok(migSql.indexOf('sms_eligible_contacts_for_series') !== -1);
assert.ok(migSql.indexOf("e.event_name = 'click'") !== -1);
assert.ok(migSql.indexOf('sms_classify_phones_for_series') !== -1);
assert.ok(migSql.indexOf('CREATE OR REPLACE FUNCTION public.sms_eligible_contacts_base') === -1);
assert.ok(migSql.indexOf('CREATE OR REPLACE FUNCTION public.sms_contact_has_prior_message') === -1);
assert.ok(migSql.indexOf('CREATE OR REPLACE FUNCTION public.sms_eligible_contacts(') === -1);
assert.ok(migSql.indexOf('clicked') !== -1);

function sliceFn(name) {
  const needle = 'CREATE OR REPLACE FUNCTION public.' + name + '(';
  const start = migSql.indexOf(needle);
  assert.ok(start !== -1, 'missing function ' + name);
  const next = migSql.indexOf(
    'CREATE OR REPLACE FUNCTION public.',
    start + needle.length,
  );
  return migSql.slice(start, next === -1 ? undefined : next);
}

const massFnNames = [
  'sms_eligible_contacts_for_series_base',
  'sms_eligible_contacts_for_series_count',
  'sms_eligible_contacts_for_series',
  'sms_series_protected_clicked_count',
  'sms_classify_phones_for_series',
];
massFnNames.forEach(function (name) {
  const body = sliceFn(name);
  assert.ok(
    body.indexOf("RAISE EXCEPTION 'campaign_series_id is required'") !== -1,
    name + ' must fail-closed on NULL series',
  );
  assert.ok(
    body.indexOf('sms_contact_clicked_in_series(') === -1,
    name + ' must not call per-contact helper',
  );
});
assert.ok(
  sliceFn('sms_contact_clicked_in_series').indexOf(
    "RAISE EXCEPTION 'campaign_series_id is required'",
  ) !== -1,
);
const baseFnSql = sliceFn('sms_eligible_contacts_for_series_base');
assert.ok(baseFnSql.indexOf('WITH clicked AS MATERIALIZED') !== -1);
assert.ok(baseFnSql.indexOf('NOT EXISTS') !== -1);
const protFnSql = sliceFn('sms_series_protected_clicked_count');
assert.ok(protFnSql.indexOf('clicked AS MATERIALIZED') !== -1);
const classifyFnSql = sliceFn('sms_classify_phones_for_series');
assert.ok(classifyFnSql.indexOf('clicked AS MATERIALIZED') !== -1);
assert.ok(classifyFnSql.indexOf("'excluded'") < classifyFnSql.indexOf("'clicked'"));
assert.ok(!/CREATE INDEX[\s\S]{0,80}sms_messages\s*\(\s*phone\s*\)/.test(migSql));

// --- helpers ---
assert.deepStrictEqual(parseCampaignSeriesId(null), { id: null, error: null });
assert.deepStrictEqual(parseCampaignSeriesId(''), { id: null, error: null });
assert.strictEqual(parseCampaignSeriesId('nope').id, null);
assert.ok(parseCampaignSeriesId('nope').error);
assert.strictEqual(parseCampaignSeriesId(SERIES_A).id, SERIES_A);
assert.strictEqual(parseSeriesName('  Reactivación Agosto 2026  '), 'Reactivación Agosto 2026');
assert.strictEqual(parseSeriesName(''), null);
assert.ok(seriesRequiredBody().error);
assert.ok(seriesNotFoundBody().error);

const part = partitionPhoneClassifications([
  { phone: PHONE_A, protection: 'clicked' },
  { phone: PHONE_EX, protection: 'excluded' },
  { phone: PHONE_B, protection: null },
  { phone: PHONE_A, protection: 'clicked' },
]);
assert.deepStrictEqual(part.protected_clicked, [PHONE_A]);
assert.deepStrictEqual(part.excluded_from_campaigns, [PHONE_EX]);
assert.deepStrictEqual(part.ok, [PHONE_B]);
assert.ok(hasFailClosedProtections(part));
const failBody = buildFailClosedPayload(SERIES_A, part);
assert.strictEqual(failBody.kind, 'validation');
assert.strictEqual(failBody.campaign_series_id, SERIES_A);
assert.deepStrictEqual(failBody.protected_clicked, [PHONE_A]);

assert.deepStrictEqual(
  normalizeDirectedPhones([PHONE_A, ' ' + PHONE_A, PHONE_B, '']),
  [PHONE_A, PHONE_B],
);

(async function run() {
  // 1. Historical campaign_series_id NULL is still a valid parse/omit
  assert.strictEqual(parseCampaignSeriesId(undefined).id, null);
  assert.strictEqual(parseCampaignSeriesId(null).id, null);

  // 2. Tracking OFF count uses legacy RPC, ignores series
  {
    const sb = makeSupabase({ legacyCount: 17 });
    const result = await resolveEligibleCount({
      sourceSystem: 'credizona2_datos',
      seriesId: SERIES_A,
      individualTracking: false,
      supabase: sb,
    });
    assert.ok(result.ok);
    assert.strictEqual(result.body.eligibility, 'legacy');
    assert.strictEqual(result.body.individual_tracking, false);
    assert.strictEqual(result.body.count, 17);
    assert.strictEqual(sb.calls.rpc.length, 1);
    assert.strictEqual(sb.calls.rpc[0].name, 'sms_eligible_contacts_count');
  }

  // 3. Tracking ON without series
  {
    const parsed = parseCampaignSeriesId('');
    assert.strictEqual(parsed.id, null);
    const result = await resolveEligibleCount({
      sourceSystem: 'credizona2_datos',
      seriesId: null,
      individualTracking: true,
      supabase: makeSupabase({}),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.kind, 'validation');
  }

  // 4. Tracking ON invalid UUID
  {
    const parsed = parseCampaignSeriesId('not-a-uuid');
    assert.ok(parsed.error);
    assert.strictEqual(parsed.id, null);
  }

  const world = baseWorld();

  // 5. First tanda series A — contact eligible (no click yet)
  assert.strictEqual(
    isEligibleForSeries(world.contacts[0], 'credizona2_datos', SERIES_A, world),
    true,
  );

  // 6. Second tanda A without clicks — still eligible
  world.campaigns.push({ id: CAMP_A2, campaign_series_id: SERIES_A });
  assert.strictEqual(
    isEligibleForSeries(world.contacts[0], 'credizona2_datos', SERIES_A, world),
    true,
  );

  // 7–8. Click on tanda 1 of A → not eligible for tanda 2 of A
  world.events.push({
    impact_id: IMPACT_A1,
    event_name: 'click',
    source: 'janus',
  });
  assert.strictEqual(
    isEligibleForSeries(world.contacts[0], 'credizona2_datos', SERIES_A, world),
    false,
  );
  assert.strictEqual(
    isEligibleForSeries(world.contacts[1], 'credizona2_datos', SERIES_A, world),
    true,
  );

  // 9. Same contact, series B — eligible
  assert.strictEqual(
    isEligibleForSeries(world.contacts[0], 'credizona2_datos', SERIES_B, world),
    true,
  );

  // 10. excluded_from_campaigns
  assert.strictEqual(
    isEligibleForSeries(world.contacts[2], 'credizona2_datos', SERIES_A, world),
    false,
  );
  assert.strictEqual(classifyPhone(PHONE_EX, SERIES_A, world), 'excluded');

  // 11. Directed phone that clicked A
  assert.strictEqual(classifyPhone(PHONE_A, SERIES_A, world), 'clicked');
  {
    const sb = makeSupabase({
      contacts: world.contacts,
      classify: [{ phone: PHONE_A, protection: 'clicked' }],
    });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: true,
      fromContactsRaw: { phones: [PHONE_A] },
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb,
    });
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.status, 400);
    assert.deepStrictEqual(resolved.body.protected_clicked, [PHONE_A]);
    assert.strictEqual(sb.calls.rpc.some(function (c) {
      return c.name === 'sms_eligible_contacts';
    }), false);
  }

  // 12. Paste phone that clicked A
  {
    const sb = makeSupabase({
      classify: [{ phone: PHONE_A, protection: 'clicked' }],
    });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: false,
      phones: [PHONE_A],
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb,
    });
    assert.strictEqual(resolved.ok, false);
    assert.deepStrictEqual(resolved.body.protected_clicked, [PHONE_A]);
    assert.strictEqual(resolved.body.campaign_series_id, SERIES_A);
  }

  // 13. Mix eligible + protected → fail closed, does not send the rest
  {
    const sb = makeSupabase({
      classify: [
        { phone: PHONE_A, protection: 'clicked' },
        { phone: PHONE_B, protection: null },
        { phone: PHONE_C, protection: null },
      ],
    });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: false,
      phones: [PHONE_A, PHONE_B, PHONE_C],
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb,
    });
    assert.strictEqual(resolved.ok, false);
    assert.deepStrictEqual(resolved.body.protected_clicked, [PHONE_A]);
    assert.ok(!resolved.normalizedPhones);
  }

  // 14. Failed SMS without click — still eligible
  {
    const failedWorld = baseWorld();
    failedWorld.messages[0].status = 'error';
    failedWorld.messages[0].marketing_impact_id = IMPACT_A1;
    failedWorld.events = [];
    assert.strictEqual(
      isEligibleForSeries(
        failedWorld.contacts[0],
        'credizona2_datos',
        SERIES_A,
        failedWorld,
      ),
      true,
    );
  }

  // 15. form_step_1 without click — still eligible
  {
    const stepWorld = baseWorld();
    stepWorld.events = [
      { impact_id: IMPACT_A1, event_name: 'form_step_1', source: 'credizona' },
    ];
    assert.strictEqual(
      isEligibleForSeries(
        stepWorld.contacts[0],
        'credizona2_datos',
        SERIES_A,
        stepWorld,
      ),
      true,
    );
    assert.strictEqual(classifyPhone(PHONE_A, SERIES_A, stepWorld), null);
  }

  // 16. Same phone, historical message contact_id null, click in A
  {
    const hist = baseWorld();
    hist.messages[0].contact_id = null;
    hist.messages[0].phone = PHONE_OLD;
    hist.events = [{ impact_id: IMPACT_A1, event_name: 'click' }];
    hist.contacts.push({
      id: '55555555-5555-4555-8555-555555555555',
      phone: PHONE_OLD,
      source_system: 'credizona2_datos',
      excluded_from_campaigns: false,
    });
    assert.strictEqual(
      classifyPhone(PHONE_OLD, SERIES_A, hist),
      'clicked',
    );
    assert.strictEqual(
      isEligibleForSeries(
        hist.contacts[hist.contacts.length - 1],
        'credizona2_datos',
        SERIES_A,
        hist,
      ),
      false,
    );
  }

  // 17. Legacy list tracking OFF still calls never-messaged RPC
  {
    const sb = makeSupabase({
      legacyList: [
        {
          id: CONTACT_A,
          phone: PHONE_A,
          nombre: 'Ana',
          source_system: 'credizona2_datos',
          source_record_id: '1',
        },
      ],
    });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: true,
      fromContactsRaw: { source_system: 'credizona2_datos', limit: 10 },
      individualTracking: false,
      seriesId: null,
      supabase: sb,
    });
    assert.ok(resolved.ok);
    assert.strictEqual(resolved.selectedContacts.length, 1);
    assert.strictEqual(sb.calls.rpc[0].name, 'sms_eligible_contacts');
    assert.ok(
      !sb.calls.rpc.some(function (c) {
        return c.name.indexOf('for_series') !== -1;
      }),
    );
  }

  // Tracking ON list uses series RPC with the same series id
  {
    const sb = makeSupabase({
      seriesList: [
        {
          id: CONTACT_A,
          phone: PHONE_A,
          nombre: 'Ana',
          source_system: 'credizona2_datos',
          source_record_id: '1',
        },
      ],
    });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: true,
      fromContactsRaw: { source_system: 'credizona2_datos', limit: 50 },
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb,
    });
    assert.ok(resolved.ok);
    assert.strictEqual(sb.calls.rpc[0].name, 'sms_eligible_contacts_for_series');
    assert.strictEqual(
      sb.calls.rpc[0].args.p_campaign_series_id,
      SERIES_A,
    );
  }

  // 18. Two concurrent tandas of A (no clicks): both see the same pool (no lock)
  {
    const sb1 = makeSupabase({
      seriesList: [{ id: CONTACT_A, phone: PHONE_A, nombre: 'Ana', source_system: 'credizona2_datos', source_record_id: '1' }],
    });
    const sb2 = makeSupabase({
      seriesList: [{ id: CONTACT_A, phone: PHONE_A, nombre: 'Ana', source_system: 'credizona2_datos', source_record_id: '1' }],
    });
    const r1 = await resolveNewShapeDestinations({
      useFromContacts: true,
      fromContactsRaw: { source_system: 'credizona2_datos', limit: 10 },
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb1,
    });
    const r2 = await resolveNewShapeDestinations({
      useFromContacts: true,
      fromContactsRaw: { source_system: 'credizona2_datos', limit: 10 },
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb2,
    });
    assert.ok(r1.ok && r2.ok);
    assert.strictEqual(r1.selectedContacts[0].id, r2.selectedContacts[0].id);
  }

  // 19A. Tracking OFF + paste duplicates → legacy trim, keep repeats (no dedup)
  {
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: false,
      phones: [PHONE_B, PHONE_B, ' ' + PHONE_B],
      individualTracking: false,
      seriesId: null,
      supabase: makeSupabase({}),
    });
    assert.ok(resolved.ok);
    assert.deepStrictEqual(resolved.normalizedPhones, [
      PHONE_B,
      PHONE_B,
      PHONE_B,
    ]);
    assert.strictEqual(resolved.selectedContacts, null);
  }

  // 19B. Tracking ON + paste duplicates → first-wins, one candidate
  {
    const sb = makeSupabase({ classify: [{ phone: PHONE_B, protection: null }] });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: false,
      phones: [PHONE_B, PHONE_B, ' ' + PHONE_B],
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb,
    });
    assert.ok(resolved.ok);
    assert.deepStrictEqual(resolved.normalizedPhones, [PHONE_B]);
    assert.deepStrictEqual(sb.calls.rpc[0].args.p_phones, [PHONE_B]);
  }

  // Directed unknown still 400 before classify
  {
    const sb = makeSupabase({ contacts: [] });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: true,
      fromContactsRaw: { phones: [PHONE_C] },
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb,
    });
    assert.strictEqual(resolved.ok, false);
    assert.deepStrictEqual(resolved.body.missing_phones, [PHONE_C]);
    assert.ok(
      !sb.calls.rpc.some(function (c) {
        return c.name === 'sms_classify_phones_for_series';
      }),
    );
  }

  // Tracking ON eligible count uses series RPCs with same id
  {
    const sb = makeSupabase({ seriesCount: 9, protectedCount: 3 });
    const result = await resolveEligibleCount({
      sourceSystem: 'credizona2_datos',
      seriesId: SERIES_A,
      individualTracking: true,
      supabase: sb,
    });
    assert.ok(result.ok);
    assert.strictEqual(result.body.eligibility, 'series');
    assert.strictEqual(result.body.count, 9);
    assert.strictEqual(result.body.protected_clicked_count, 3);
    assert.strictEqual(result.body.campaign_series_id, SERIES_A);
    const names = sb.calls.rpc.map(function (c) {
      return c.name;
    });
    assert.ok(names.indexOf('sms_eligible_contacts_for_series_count') !== -1);
    assert.ok(names.indexOf('sms_eligible_contacts_count') === -1);
    sb.calls.rpc.forEach(function (c) {
      if (c.args && c.args.p_campaign_series_id) {
        assert.strictEqual(c.args.p_campaign_series_id, SERIES_A);
      }
    });
  }

  // Directed tracking OFF does not classify (legacy behaviour)
  {
    const contact = {
      id: CONTACT_A,
      phone: PHONE_A,
      nombre: 'Ana',
      source_system: 'credizona2_datos',
      source_record_id: '1',
    };
    const sb = makeSupabase({ contacts: [contact] });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: true,
      fromContactsRaw: { phones: [PHONE_A] },
      individualTracking: false,
      seriesId: null,
      supabase: sb,
    });
    assert.ok(resolved.ok);
    assert.strictEqual(resolved.selectedContacts.length, 1);
    assert.strictEqual(sb.calls.rpc.length, 0);
  }

  // --- SQL semantics replica (in-memory; does NOT replace real PostgreSQL) ---
  {
    let threw = false;
    try {
      eligibleContactsForSeries(
        world.contacts,
        'credizona2_datos',
        null,
        world,
      );
    } catch (e) {
      threw = e.message === 'campaign_series_id is required';
    }
    assert.ok(threw, 'NULL series eligible must raise, not return all');
  }
  {
    let threw = false;
    try {
      classifyPhonesForSeries([PHONE_A], null, world);
    } catch (e) {
      threw = e.message === 'campaign_series_id is required';
    }
    assert.ok(threw, 'NULL series classify must raise, not fail-open');
  }

  {
    const contacts = [];
    const campaigns = [{ id: 'camp-scale-a', campaign_series_id: SERIES_A }];
    const messages = [];
    const events = [];
    for (let i = 0; i < 100; i++) {
      const id = 'scale-c-' + i;
      const phone = '099' + String(100000 + i);
      contacts.push({
        id: id,
        phone: phone,
        source_system: 'credizona2_datos',
        excluded_from_campaigns: false,
      });
      if (i < 5) {
        const impact = 'scale-imp-' + i;
        messages.push({
          campaign_id: 'camp-scale-a',
          contact_id: id,
          phone: phone,
          marketing_impact_id: impact,
        });
        events.push({ impact_id: impact, event_name: 'click' });
      }
    }
    const scaleWorld = {
      contacts: contacts,
      campaigns: campaigns,
      messages: messages,
      events: events,
    };
    assert.strictEqual(
      eligibleContactsForSeries(
        contacts,
        'credizona2_datos',
        SERIES_A,
        scaleWorld,
      ).length,
      95,
    );
    assert.strictEqual(
      eligibleContactsForSeries(
        contacts,
        'credizona2_datos',
        SERIES_B,
        scaleWorld,
      ).length,
      100,
      'click on series A must not affect series B',
    );
  }

  {
    const cid = 'id-only-1';
    const currentPhone = '099888001';
    const w = {
      contacts: [
        {
          id: cid,
          phone: currentPhone,
          source_system: 'credizona2_datos',
          excluded_from_campaigns: false,
        },
      ],
      campaigns: [{ id: 'camp-id-only', campaign_series_id: SERIES_A }],
      messages: [
        {
          campaign_id: 'camp-id-only',
          contact_id: cid,
          phone: '099888999',
          marketing_impact_id: 'imp-id-only',
        },
      ],
      events: [{ impact_id: 'imp-id-only', event_name: 'click' }],
    };
    assert.strictEqual(
      eligibleContactsForSeries(w.contacts, 'credizona2_datos', SERIES_A, w)
        .length,
      0,
    );
    assert.strictEqual(
      classifyPhonesForSeries([currentPhone], SERIES_A, w)[0].protection,
      'clicked',
    );
  }

  {
    const phoneOnly = '099888002';
    const w = {
      contacts: [
        {
          id: 'id-phone-only',
          phone: phoneOnly,
          source_system: 'credizona2_datos',
          excluded_from_campaigns: false,
        },
      ],
      campaigns: [{ id: 'camp-phone-only', campaign_series_id: SERIES_A }],
      messages: [
        {
          campaign_id: 'camp-phone-only',
          contact_id: null,
          phone: phoneOnly,
          marketing_impact_id: 'imp-phone-only',
        },
      ],
      events: [{ impact_id: 'imp-phone-only', event_name: 'click' }],
    };
    assert.strictEqual(
      eligibleContactsForSeries(w.contacts, 'credizona2_datos', SERIES_A, w)
        .length,
      0,
    );
    assert.strictEqual(
      classifyPhonesForSeries([phoneOnly], SERIES_A, w)[0].protection,
      'clicked',
    );
  }

  {
    const w = {
      contacts: [
        {
          id: 'id-ex-win',
          phone: PHONE_EX,
          source_system: 'credizona2_datos',
          excluded_from_campaigns: true,
        },
      ],
      campaigns: [{ id: CAMP_A1, campaign_series_id: SERIES_A }],
      messages: [
        {
          campaign_id: CAMP_A1,
          contact_id: 'id-ex-win',
          phone: PHONE_EX,
          marketing_impact_id: IMPACT_A1,
        },
      ],
      events: [{ impact_id: IMPACT_A1, event_name: 'click' }],
    };
    assert.strictEqual(
      classifyPhonesForSeries([PHONE_EX], SERIES_A, w)[0].protection,
      'excluded',
    );
    assert.strictEqual(
      eligibleContactsForSeries(w.contacts, 'credizona2_datos', SERIES_A, w)
        .length,
      0,
    );
  }

  {
    const unknown = '099777777';
    const w = {
      contacts: [],
      campaigns: [{ id: CAMP_A1, campaign_series_id: SERIES_A }],
      messages: [
        {
          campaign_id: CAMP_A1,
          contact_id: null,
          phone: unknown,
          marketing_impact_id: IMPACT_A1,
        },
      ],
      events: [{ impact_id: IMPACT_A1, event_name: 'click' }],
    };
    assert.strictEqual(
      classifyPhonesForSeries([unknown], SERIES_A, w)[0].protection,
      'clicked',
    );
  }

  restoreFlag();
  console.log('OK unit-sms-campaign-series (cases 1–19 + SQL-perf replica)');
})().catch(function (err) {
  restoreFlag();
  console.error(err);
  process.exit(1);
});
