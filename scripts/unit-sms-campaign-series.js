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

const CONSUMING_CAMPAIGN_STATUSES = ['sending', 'sent', 'partial_error'];

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

function campaignById(world, campaignId) {
  return (world.campaigns || []).find(function (c) {
    return c.id === campaignId;
  });
}

function alreadySentIdentitiesOnce(world, seriesId) {
  requireCampaignSeriesId(seriesId);
  const seen = Object.create(null);
  const rows = [];
  (world.messages || []).forEach(function (m) {
    const camp = campaignById(world, m.campaign_id);
    if (!camp || camp.campaign_series_id !== seriesId) return;
    if (CONSUMING_CAMPAIGN_STATUSES.indexOf(camp.status) === -1) return;
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
  const alreadySent = alreadySentIdentitiesOnce(world, seriesId);
  return contacts.filter(function (c) {
    if (c.source_system !== sourceSystem) return false;
    if (!String(c.phone || '').trim()) return false;
    if (c.excluded_from_campaigns) return false;
    return !alreadySent.some(function (s) {
      return identityHitsContact(s, c);
    });
  });
}

function classifyPhonesForSeries(phones, seriesId, world) {
  const alreadySent = alreadySentIdentitiesOnce(world, seriesId);
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
    const sentHit = alreadySent.some(function (s) {
      return identityHitsContact(s, contactByPhone || { id: null, phone: phone });
    });
    if (sentHit) return { phone: phone, protection: 'already_sent' };
    const clickHit = clicked.some(function (cl) {
      const byId =
        cl.contact_id != null &&
        contactByPhone &&
        contactByPhone.id != null &&
        cl.contact_id === contactByPhone.id;
      const byPhone = cl.phone != null && cl.phone === phone;
      return byId || byPhone;
    });
    return { phone: phone, protection: clickHit ? 'clicked' : null };
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
    campaigns: [],
    messages: [],
    events: [],
  };
}

function markSentInSeries(world, campaignId, seriesId, contactId, phone, impactId) {
  world.campaigns.push({
    id: campaignId,
    campaign_series_id: seriesId,
    status: 'sent',
  });
  world.messages.push({
    campaign_id: campaignId,
    contact_id: contactId,
    phone: phone,
    marketing_impact_id: impactId,
  });
}

// --- SQL file must not touch legacy RPCs ---
const migPath = path.join(
  __dirname,
  '..',
  'migrations',
  '20260902_sms_series_already_sent_eligibility.sql',
);
const migSql = fs.readFileSync(migPath, 'utf8');
assert.ok(migSql.indexOf('already_sent AS MATERIALIZED') !== -1);
assert.ok(
  migSql.indexOf("camp.status IN ('sending', 'sent', 'partial_error')") !== -1,
);
assert.ok(migSql.indexOf("'already_sent'") !== -1);
assert.ok(migSql.indexOf("'excluded'") < migSql.indexOf("'already_sent'"));
assert.ok(migSql.indexOf("'already_sent'") < migSql.indexOf("'clicked'"));
assert.ok(migSql.indexOf('CREATE OR REPLACE FUNCTION public.sms_eligible_contacts_base') === -1);
assert.ok(
  migSql.indexOf('CREATE OR REPLACE FUNCTION public.sms_contact_clicked_in_series') === -1,
);
assert.ok(migSql.indexOf('CREATE OR REPLACE FUNCTION public.sms_series_protected_clicked_count') === -1);

const legacyMigPath = path.join(
  __dirname,
  '..',
  'migrations',
  '20260828_marketing_campaign_series.sql',
);
const legacyMigSql = fs.readFileSync(legacyMigPath, 'utf8');
assert.ok(legacyMigSql.indexOf('sms_series_protected_clicked_count') !== -1);

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
  { phone: PHONE_A, protection: 'already_sent' },
  { phone: PHONE_EX, protection: 'excluded' },
  { phone: PHONE_B, protection: null },
  { phone: PHONE_A, protection: 'already_sent' },
]);
assert.deepStrictEqual(part.already_sent_in_series, [PHONE_A]);
assert.deepStrictEqual(part.excluded_from_campaigns, [PHONE_EX]);
assert.deepStrictEqual(part.ok, [PHONE_B]);
assert.ok(hasFailClosedProtections(part));
const failBody = buildFailClosedPayload(SERIES_A, part);
assert.strictEqual(failBody.kind, 'validation');
assert.strictEqual(failBody.campaign_series_id, SERIES_A);
assert.deepStrictEqual(failBody.already_sent_in_series, [PHONE_A]);

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

  // 5. First tanda series A — contact eligible (no prior send)
  assert.strictEqual(
    isEligibleForSeries(world.contacts[0], 'credizona2_datos', SERIES_A, world),
    true,
  );

  // 6. Second tanda A after successful send — NOT eligible (already_sent)
  markSentInSeries(world, CAMP_A1, SERIES_A, CONTACT_A, PHONE_A, IMPACT_A1);
  world.campaigns.push({
    id: CAMP_A2,
    campaign_series_id: SERIES_A,
    status: 'sending',
  });
  assert.strictEqual(
    isEligibleForSeries(world.contacts[0], 'credizona2_datos', SERIES_A, world),
    false,
  );
  assert.strictEqual(
    isEligibleForSeries(world.contacts[1], 'credizona2_datos', SERIES_A, world),
    true,
  );

  // 7–8. Click on tanda 1 of A → still not eligible; classify = already_sent
  world.events.push({
    impact_id: IMPACT_A1,
    event_name: 'click',
    source: 'janus',
  });
  assert.strictEqual(
    isEligibleForSeries(world.contacts[0], 'credizona2_datos', SERIES_A, world),
    false,
  );
  assert.strictEqual(classifyPhone(PHONE_A, SERIES_A, world), 'already_sent');

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

  // 11. Directed phone already sent in A
  assert.strictEqual(classifyPhone(PHONE_A, SERIES_A, world), 'already_sent');
  {
    const sb = makeSupabase({
      contacts: world.contacts,
      classify: [{ phone: PHONE_A, protection: 'already_sent' }],
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
    assert.deepStrictEqual(resolved.body.already_sent_in_series, [PHONE_A]);
    assert.strictEqual(sb.calls.rpc.some(function (c) {
      return c.name === 'sms_eligible_contacts';
    }), false);
  }

  // 12. Paste phone already sent in A
  {
    const sb = makeSupabase({
      classify: [{ phone: PHONE_A, protection: 'already_sent' }],
    });
    const resolved = await resolveNewShapeDestinations({
      useFromContacts: false,
      phones: [PHONE_A],
      individualTracking: true,
      seriesId: SERIES_A,
      supabase: sb,
    });
    assert.strictEqual(resolved.ok, false);
    assert.deepStrictEqual(resolved.body.already_sent_in_series, [PHONE_A]);
    assert.strictEqual(resolved.body.campaign_series_id, SERIES_A);
  }

  // 12B. Paste phone clicked but campaign error — fail-closed as clicked, list still eligible
  {
    const clickOnlyWorld = baseWorld();
    clickOnlyWorld.campaigns = [
      { id: 'camp-err-click', campaign_series_id: SERIES_A, status: 'error' },
    ];
    clickOnlyWorld.messages = [
      {
        campaign_id: 'camp-err-click',
        contact_id: CONTACT_A,
        phone: PHONE_A,
        marketing_impact_id: IMPACT_A1,
      },
    ];
    clickOnlyWorld.events = [{ impact_id: IMPACT_A1, event_name: 'click' }];
    assert.strictEqual(
      isEligibleForSeries(
        clickOnlyWorld.contacts[0],
        'credizona2_datos',
        SERIES_A,
        clickOnlyWorld,
      ),
      true,
    );
    assert.strictEqual(
      classifyPhone(PHONE_A, SERIES_A, clickOnlyWorld),
      'clicked',
    );
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
  }

  // 13. Mix eligible + already_sent → fail closed, does not send the rest
  {
    const sb = makeSupabase({
      classify: [
        { phone: PHONE_A, protection: 'already_sent' },
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
    assert.deepStrictEqual(resolved.body.already_sent_in_series, [PHONE_A]);
    assert.ok(!resolved.normalizedPhones);
  }

  // 14. Failed campaign (status=error) with prep messages — still eligible
  {
    const failedWorld = baseWorld();
    failedWorld.campaigns = [
      { id: 'camp-fail', campaign_series_id: SERIES_A, status: 'error' },
    ];
    failedWorld.messages = [
      {
        campaign_id: 'camp-fail',
        contact_id: CONTACT_A,
        phone: PHONE_A,
        marketing_impact_id: IMPACT_A1,
      },
    ];
    assert.strictEqual(
      isEligibleForSeries(
        failedWorld.contacts[0],
        'credizona2_datos',
        SERIES_A,
        failedWorld,
      ),
      true,
    );
    assert.strictEqual(
      classifyPhone(PHONE_A, SERIES_A, failedWorld),
      null,
    );
  }

  // 15. form_step_1 without click but WITH sent — not eligible
  {
    const stepWorld = baseWorld();
    markSentInSeries(stepWorld, CAMP_A1, SERIES_A, CONTACT_A, PHONE_A, IMPACT_A1);
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
      false,
    );
    assert.strictEqual(classifyPhone(PHONE_A, SERIES_A, stepWorld), 'already_sent');
  }

  // 16. Same phone, historical message contact_id null, sent + click in A
  {
    const hist = baseWorld();
    hist.campaigns = [
      { id: CAMP_A1, campaign_series_id: SERIES_A, status: 'sent' },
    ];
    hist.messages = [
      {
        campaign_id: CAMP_A1,
        contact_id: null,
        phone: PHONE_OLD,
        marketing_impact_id: IMPACT_A1,
      },
    ];
    hist.events = [{ impact_id: IMPACT_A1, event_name: 'click' }];
    hist.contacts.push({
      id: '55555555-5555-4555-8555-555555555555',
      phone: PHONE_OLD,
      source_system: 'credizona2_datos',
      excluded_from_campaigns: false,
    });
    assert.strictEqual(
      classifyPhone(PHONE_OLD, SERIES_A, hist),
      'already_sent',
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
    const campaigns = [
      { id: 'camp-scale-a', campaign_series_id: SERIES_A, status: 'sent' },
    ];
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
      campaigns: [{ id: 'camp-id-only', campaign_series_id: SERIES_A, status: 'sent' }],
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
      'already_sent',
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
      campaigns: [{ id: 'camp-phone-only', campaign_series_id: SERIES_A, status: 'sent' }],
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
      'already_sent',
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
      campaigns: [{ id: CAMP_A1, campaign_series_id: SERIES_A, status: 'sent' }],
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
      campaigns: [{ id: CAMP_A1, campaign_series_id: SERIES_A, status: 'sent' }],
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
      'already_sent',
    );
  }

  // partial_error consumes all messages (conservative)
  {
    const w = baseWorld();
    w.campaigns = [
      { id: 'camp-pe', campaign_series_id: SERIES_A, status: 'partial_error' },
    ];
    w.messages = [
      {
        campaign_id: 'camp-pe',
        contact_id: CONTACT_A,
        phone: PHONE_A,
        marketing_impact_id: IMPACT_A1,
      },
    ];
    assert.strictEqual(
      isEligibleForSeries(w.contacts[0], 'credizona2_datos', SERIES_A, w),
      false,
    );
    assert.strictEqual(classifyPhone(PHONE_A, SERIES_A, w), 'already_sent');
  }

  // Gate regression: 200 sent + 500 error same series — error-only contacts stay eligible
  {
    const SERIES_GATE = 'a88eec38-e622-4e0c-9981-b09cf5a23990';
    const CAMP_OK = '929d59a0-b136-4810-86d9-ecf4fad37b8c';
    const CAMP_FAIL = '411cc02d-407b-4bba-89c8-11656fe65414';
    const gateContacts = [];
    for (let i = 0; i < 500; i++) {
      gateContacts.push({
        id: 'gate-c-' + i,
        phone: '099' + String(600000 + i),
        source_system: 'prestafacil',
        excluded_from_campaigns: false,
      });
    }
    const gateWorld = {
      contacts: gateContacts,
      campaigns: [
        { id: CAMP_OK, campaign_series_id: SERIES_GATE, status: 'sent' },
        { id: CAMP_FAIL, campaign_series_id: SERIES_GATE, status: 'error' },
      ],
      messages: [],
      events: [],
    };
    for (let i = 0; i < 500; i++) {
      const msg = {
        campaign_id: i < 200 ? CAMP_OK : CAMP_FAIL,
        contact_id: gateContacts[i].id,
        phone: gateContacts[i].phone,
        marketing_impact_id: 'gate-imp-' + i,
      };
      gateWorld.messages.push(msg);
    }
    const eligible = eligibleContactsForSeries(
      gateContacts,
      'prestafacil',
      SERIES_GATE,
      gateWorld,
    );
    assert.strictEqual(eligible.length, 300, '300 error-only contacts remain eligible');
    const sentOnlyEligible = eligible.filter(function (c) {
      return gateWorld.messages.some(function (m) {
        return m.campaign_id === CAMP_OK && m.contact_id === c.id;
      });
    });
    assert.strictEqual(sentOnlyEligible.length, 0, '200 sent contacts must be 0 eligible');
  }

  restoreFlag();
  console.log('OK unit-sms-campaign-series (cases 1–19 + SQL-perf replica)');
})().catch(function (err) {
  restoreFlag();
  console.error(err);
  process.exit(1);
});
