'use strict';

/**
 * node scripts/unit-sms-marketing-impacts.js
 */

const assert = require('assert');
const {
  IMPACT_INSERT_CHUNK,
  TRACKING_TOKEN_RE,
  TrackingPrepError,
  isIndividualTrackingEnabled,
  generateTrackingToken,
  classifyInsertOutcome,
  buildRecipientPlans,
  prepareIndividualSmsTracking,
} = require('../src/lib/smsMarketingImpacts');
const { isUniqueViolation } = require('../src/lib/smsTinyUrl');

const prevFlag = process.env.SMS_INDIVIDUAL_TRACKING;
delete process.env.SMS_INDIVIDUAL_TRACKING;
assert.strictEqual(isIndividualTrackingEnabled(), false);
process.env.SMS_INDIVIDUAL_TRACKING = 'false';
assert.strictEqual(isIndividualTrackingEnabled(), false);
process.env.SMS_INDIVIDUAL_TRACKING = 'TRUE';
assert.strictEqual(isIndividualTrackingEnabled(), true);
process.env.SMS_INDIVIDUAL_TRACKING = 'true';
assert.strictEqual(isIndividualTrackingEnabled(), true);
if (prevFlag == null) delete process.env.SMS_INDIVIDUAL_TRACKING;
else process.env.SMS_INDIVIDUAL_TRACKING = prevFlag;

const token = generateTrackingToken();
assert.strictEqual(token.length, 22);
assert.match(token, TRACKING_TOKEN_RE);
const seen = new Set();
for (let i = 0; i < 1000; i += 1) {
  const t = generateTrackingToken();
  assert.match(t, TRACKING_TOKEN_RE);
  seen.add(t);
}
assert.strictEqual(seen.size, 1000);

assert.strictEqual(classifyInsertOutcome({ code: '23505' }, null, 2), 'unique_conflict');
assert.strictEqual(classifyInsertOutcome({ status: 409 }, null, 2), 'unique_conflict');
assert.strictEqual(classifyInsertOutcome({ message: 'timeout' }, null, 2), 'uncertain');
assert.strictEqual(classifyInsertOutcome(null, [{}, {}], 2), 'ok');
assert.strictEqual(classifyInsertOutcome(null, [{}], 2), 'uncertain');
assert.strictEqual(classifyInsertOutcome(null, null, 2), 'uncertain');
assert.ok(isUniqueViolation({ code: '23505' }));

const plans = buildRecipientPlans([
  { phone: '1', contact_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  { phone: '2', contact_id: null },
]);
assert.strictEqual(plans.length, 2);
assert.notStrictEqual(plans[0].tracking_token, plans[1].tracking_token);
assert.notStrictEqual(plans[0].short_code, plans[1].short_code);
assert.strictEqual(plans[0].impact_id, null);
assert.strictEqual(Math.ceil(16500 / IMPACT_INSERT_CHUNK), 165);
const many = buildRecipientPlans(
  Array.from({ length: 16500 }, function (_, i) {
    return { phone: String(i) };
  }),
);
assert.strictEqual(many.length, 16500);
assert.strictEqual(
  new Set(many.map(function (p) { return p.tracking_token; })).size,
  16500,
);

function createFakeDb(options) {
  const opts = options || {};
  const impacts = new Map();
  const shortsByImpact = new Map();
  const shortsByCode = new Map();
  const insertedShortRows = [];
  let impactSeq = 0;
  const calls = {
    impactInserts: [],
    shortInserts: [],
    impactSelects: 0,
    shortSelects: 0,
    shortCodeSelects: 0,
    impactInClauseSizes: [],
    shortInClauseSizes: [],
  };
  let impactInsertN = 0;
  let shortInsertN = 0;

  function insertImpacts(rows) {
    impactInsertN += 1;
    calls.impactInserts.push(rows.map(function (r) { return r.tracking_token; }));
    const mode = typeof opts.impactInsert === 'function'
      ? opts.impactInsert(impactInsertN, rows)
      : opts.impactInsert || 'ok';
    if (mode === 'timeout') {
      if (opts.persistOnUncertain) {
        persistImpactRows(rows);
      }
      return { data: null, error: { message: 'fetch failed', status: 500 } };
    }
    if (mode === 'unique') {
      return { data: null, error: { code: '23505', message: 'duplicate key' } };
    }
    if (mode === 'short_return') {
      persistImpactRows(rows);
      return { data: persistImpactRows.returning.slice(0, rows.length - 1), error: null };
    }
    const returning = persistImpactRows(rows);
    return { data: returning, error: null };
  }

  function persistImpactRows(rows) {
    const returning = [];
    for (const row of rows) {
      if (!impacts.has(row.tracking_token)) {
        impactSeq += 1;
        const id = '00000000-0000-4000-8000-' + String(impactSeq).padStart(12, '0');
        impacts.set(row.tracking_token, {
          id: id,
          tracking_token: row.tracking_token,
          contact_id: row.contact_id,
        });
      }
      returning.push(impacts.get(row.tracking_token));
    }
    persistImpactRows.returning = returning;
    return returning;
  }

  function insertShorts(rows) {
    shortInsertN += 1;
    calls.shortInserts.push(rows.map(function (r) { return r.short_code; }));
    insertedShortRows.push.apply(insertedShortRows, rows);
    const mode = typeof opts.shortInsert === 'function'
      ? opts.shortInsert(shortInsertN, rows)
      : opts.shortInsert || 'ok';
    if (mode === 'timeout') {
      if (opts.persistOnUncertain) persistShortRows(rows);
      return { data: null, error: { message: 'fetch failed', status: 500 } };
    }
    if (mode === 'unique') {
      return { data: null, error: { code: '23505', message: 'duplicate key' } };
    }
    const returning = persistShortRows(rows);
    return { data: returning, error: null };
  }

  function persistShortRows(rows) {
    const returning = [];
    for (const row of rows) {
      if (shortsByCode.has(row.short_code) &&
          shortsByCode.get(row.short_code) !== row.impact_id) {
        return null;
      }
      shortsByImpact.set(row.impact_id, row.short_code);
      shortsByCode.set(row.short_code, row.impact_id);
      returning.push({ impact_id: row.impact_id, short_code: row.short_code });
    }
    return returning;
  }

  return {
    calls: calls,
    impacts: impacts,
    shortsByImpact: shortsByImpact,
    shortsByCode: shortsByCode,
    insertedShortRows: insertedShortRows,
    from: function (table) {
      return {
        insert: function (rows) {
          return {
            select: function () {
              if (table === 'marketing_impacts') return Promise.resolve(insertImpacts(rows));
              if (table === 'sms_short_links') return Promise.resolve(insertShorts(rows));
              return Promise.resolve({ data: null, error: { message: 'unknown table' } });
            },
          };
        },
        select: function () {
          return {
            in: function (column, values) {
              if (table === 'marketing_impacts') {
                calls.impactSelects += 1;
                calls.impactInClauseSizes.push(values.length);
                const data = values
                  .map(function (token) { return impacts.get(token); })
                  .filter(Boolean);
                return Promise.resolve({ data: data, error: null });
              }
              if (table === 'sms_short_links' && column === 'short_code') {
                calls.shortCodeSelects += 1;
                if (opts.shortCodeSelectError) {
                  return Promise.resolve({
                    data: null,
                    error: { message: 'short_code select failed', status: 500 },
                  });
                }
                const data = values
                  .map(function (code) {
                    if (!shortsByCode.has(code)) return null;
                    return {
                      short_code: String(code),
                      impact_id: shortsByCode.get(code),
                    };
                  })
                  .filter(Boolean);
                return Promise.resolve({ data: data, error: null });
              }
              if (table === 'sms_short_links') {
                calls.shortSelects += 1;
                calls.shortInClauseSizes.push(values.length);
                if (opts.seedAdoptedShorts && shortsByImpact.size === 0) {
                  values.forEach(function (id, i) {
                    const key = String(id);
                    const code = 'SEED' + String(i);
                    shortsByImpact.set(key, code);
                    shortsByCode.set(code, key);
                  });
                }
                const data = values
                  .map(function (id) {
                    const code = shortsByImpact.get(String(id));
                    return code ? { impact_id: String(id), short_code: code } : null;
                  })
                  .filter(Boolean);
                return Promise.resolve({ data: data, error: null });
              }
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };
}

function makeRecipients(count) {
  return Array.from({ length: count }, function (_, i) {
    return { phone: String(90000000 + i), contact_id: null };
  });
}

function expectedPersistChunks(count) {
  return Math.ceil(count / IMPACT_INSERT_CHUNK);
}

function assertInsertChunkSizes(insertCalls, expectedChunks, totalCount) {
  assert.strictEqual(insertCalls.length, expectedChunks);
  let sum = 0;
  for (const batch of insertCalls) {
    assert.ok(
      batch.length <= IMPACT_INSERT_CHUNK,
      'insert batch must not exceed IMPACT_INSERT_CHUNK',
    );
    sum += batch.length;
  }
  assert.strictEqual(sum, totalCount);
}

function assertOneToOneTracking(db, plans, count) {
  assert.strictEqual(plans.length, count);
  assert.strictEqual(db.impacts.size, count);
  assert.strictEqual(db.shortsByImpact.size, count);
  assert.strictEqual(db.insertedShortRows.length, count);
  assert.ok(
    plans.every(function (p) { return p.impact_id && p.short_code; }),
    'each plan must have impact_id and short_code',
  );
  assert.strictEqual(
    new Set(plans.map(function (p) { return String(p.impact_id); })).size,
    count,
  );
  assert.strictEqual(
    new Set(plans.map(function (p) { return String(p.short_code); })).size,
    count,
  );
}

function assertJtOnShortRows(rows) {
  assert.ok(
    rows.every(function (r) {
      const u = new URL(r.destination_url);
      return Boolean(u.searchParams.get('jt'));
    }),
    'each short row must persist destination_url with jt',
  );
}

async function runChunkedHappyPath(count) {
  const db = createFakeDb();
  const destinationUrl = 'https://cz.uy/?utm_campaign=chunk-test';
  const plans = await prepareIndividualSmsTracking({
    campaignId: '22222222-2222-4222-8222-222222222222',
    recipients: makeRecipients(count),
    destinationUrl: destinationUrl,
    skipShorts: false,
    supabase: db,
  });
  const chunks = expectedPersistChunks(count);
  assertInsertChunkSizes(db.calls.impactInserts, chunks, count);
  assertInsertChunkSizes(db.calls.shortInserts, chunks, count);
  assert.ok(
    db.calls.impactInClauseSizes.every(function (n) {
      return n <= IMPACT_INSERT_CHUNK;
    }),
  );
  assert.ok(
    db.calls.shortInClauseSizes.every(function (n) {
      return n <= IMPACT_INSERT_CHUNK;
    }),
  );
  assertOneToOneTracking(db, plans, count);
  assertJtOnShortRows(db.insertedShortRows);
  return { db: db, plans: plans, chunks: chunks };
}

(async function run() {
  const recipients = [
    { phone: '099111111', contact_id: null },
    { phone: '099222222', contact_id: null },
    { phone: '099333333', contact_id: null },
  ];

  const happy = createFakeDb();
  const happyPlans = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    destinationUrl: 'https://cz.uy/?utm_campaign=x',
    skipShorts: false,
    supabase: happy,
  });
  assert.strictEqual(happyPlans.length, 3);
  assert.strictEqual(happy.impacts.size, 3);
  assert.strictEqual(happy.shortsByImpact.size, 3);
  assert.ok(happyPlans.every(function (p) { return p.impact_id && p.short_code; }));
  assert.strictEqual(happy.insertedShortRows.length, 3);
  assert.ok(
    happy.insertedShortRows.every(function (r) {
      const u = new URL(r.destination_url);
      return u.searchParams.get('utm_campaign') === 'x' && Boolean(u.searchParams.get('jt'));
    }),
    'new individual shorts must persist destination_url with jt',
  );

  const skipDb = createFakeDb();
  const skipPlans = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    skipShorts: true,
    supabase: skipDb,
  });
  assert.strictEqual(skipPlans.length, 3);
  assert.strictEqual(skipDb.impacts.size, 3);
  assert.strictEqual(skipDb.shortsByImpact.size, 0);
  assert.strictEqual(skipDb.calls.shortInserts.length, 0);

  const tokensBefore = [];
  const uncertain = createFakeDb({
    impactInsert: function (n) {
      return n === 1 ? 'timeout' : 'ok';
    },
    persistOnUncertain: true,
  });
  const uncertainPlans = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    destinationUrl: 'https://cz.uy/x',
    skipShorts: true,
    supabase: uncertain,
  });
  tokensBefore.push.apply(
    tokensBefore,
    uncertain.calls.impactInserts[0],
  );
  assert.deepStrictEqual(uncertain.calls.impactInserts[1], undefined);
  assert.strictEqual(uncertainPlans.length, 3);
  assert.deepStrictEqual(
    uncertainPlans.map(function (p) { return p.tracking_token; }).sort(),
    tokensBefore.slice().sort(),
  );

  const uniqueDb = createFakeDb({
    impactInsert: function (n) {
      return n === 1 ? 'unique' : 'ok';
    },
  });
  const uniqueResult = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    skipShorts: true,
    supabase: uniqueDb,
  });
  const uniqueTokens = uniqueResult.map(function (p) { return p.tracking_token; }).sort();
  assert.deepStrictEqual(uniqueDb.calls.impactInserts[0].slice().sort(), uniqueTokens);
  assert.deepStrictEqual(uniqueDb.calls.impactInserts[1].slice().sort(), uniqueTokens);
  assert.strictEqual(uniqueResult.length, 3);

  const codeCollide = createFakeDb({
    shortInsert: function (n, rows) {
      if (n === 1) {
        codeCollide.shortsByCode.set(
          rows[0].short_code,
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
        );
        return 'unique';
      }
      return 'ok';
    },
  });
  const codeCollidePlans = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    destinationUrl: 'https://cz.uy/x',
    skipShorts: false,
    supabase: codeCollide,
  });
  const firstShortCodes = codeCollide.calls.shortInserts[0];
  assert.ok(firstShortCodes && firstShortCodes.length === 3);
  assert.notStrictEqual(codeCollidePlans[0].short_code, firstShortCodes[0]);
  assert.strictEqual(codeCollidePlans[1].short_code, firstShortCodes[1]);
  assert.strictEqual(codeCollidePlans[2].short_code, firstShortCodes[2]);
  assert.strictEqual(codeCollidePlans.length, 3);
  assert.strictEqual(codeCollide.shortsByImpact.size, 3);
  assert.ok(codeCollide.calls.shortCodeSelects >= 1);

  const adopted = createFakeDb({ seedAdoptedShorts: true });
  const adoptedPlans = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    destinationUrl: 'https://cz.uy/x',
    skipShorts: false,
    supabase: adopted,
  });
  assert.strictEqual(adopted.calls.shortInserts.length, 0);
  assert.strictEqual(adopted.shortsByImpact.size, 3);
  assert.strictEqual(adoptedPlans.length, 3);
  assert.deepStrictEqual(
    adoptedPlans.map(function (p) { return p.short_code; }).sort(),
    ['SEED0', 'SEED1', 'SEED2'],
  );
  adoptedPlans.forEach(function (p) {
    assert.strictEqual(adopted.shortsByImpact.get(String(p.impact_id)), p.short_code);
  });

  const shortTimeoutPersisted = createFakeDb({
    shortInsert: function (n) {
      return n === 1 ? 'timeout' : 'ok';
    },
    persistOnUncertain: true,
  });
  const shortTimeoutPersistedPlans = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    destinationUrl: 'https://cz.uy/x',
    skipShorts: false,
    supabase: shortTimeoutPersisted,
  });
  assert.strictEqual(shortTimeoutPersisted.calls.shortInserts.length, 1);
  assert.deepStrictEqual(
    shortTimeoutPersistedPlans.map(function (p) { return p.short_code; }).sort(),
    shortTimeoutPersisted.calls.shortInserts[0].slice().sort(),
  );
  assert.strictEqual(shortTimeoutPersisted.calls.shortCodeSelects, 0);

  const shortTimeoutMissing = createFakeDb({
    shortInsert: function (n) {
      return n === 1 ? 'timeout' : 'ok';
    },
    persistOnUncertain: false,
  });
  const shortTimeoutMissingPlans = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    destinationUrl: 'https://cz.uy/x',
    skipShorts: false,
    supabase: shortTimeoutMissing,
  });
  assert.strictEqual(shortTimeoutMissing.calls.shortInserts.length, 2);
  assert.deepStrictEqual(
    shortTimeoutMissing.calls.shortInserts[0].slice().sort(),
    shortTimeoutMissing.calls.shortInserts[1].slice().sort(),
  );
  assert.deepStrictEqual(
    shortTimeoutMissingPlans.map(function (p) { return p.short_code; }).sort(),
    shortTimeoutMissing.calls.shortInserts[0].slice().sort(),
  );
  assert.strictEqual(shortTimeoutMissing.calls.shortCodeSelects, 0);

  const genericUnique = createFakeDb({
    shortInsert: function (n) {
      return n === 1 ? 'unique' : 'ok';
    },
  });
  const genericUniquePlans = await prepareIndividualSmsTracking({
    campaignId: '11111111-1111-4111-8111-111111111111',
    recipients: recipients,
    destinationUrl: 'https://cz.uy/x',
    skipShorts: false,
    supabase: genericUnique,
  });
  assert.strictEqual(genericUnique.calls.shortInserts.length, 2);
  assert.deepStrictEqual(
    genericUnique.calls.shortInserts[0].slice().sort(),
    genericUnique.calls.shortInserts[1].slice().sort(),
  );
  assert.deepStrictEqual(
    genericUniquePlans.map(function (p) { return p.short_code; }).sort(),
    genericUnique.calls.shortInserts[0].slice().sort(),
  );
  assert.ok(genericUnique.calls.shortCodeSelects >= 1);

  const atChunk = await runChunkedHappyPath(IMPACT_INSERT_CHUNK);
  assert.strictEqual(atChunk.chunks, 1);

  const overChunk = await runChunkedHappyPath(IMPACT_INSERT_CHUNK + 1);
  assert.strictEqual(overChunk.chunks, 2);
  assert.strictEqual(overChunk.db.calls.impactInserts[0].length, IMPACT_INSERT_CHUNK);
  assert.strictEqual(overChunk.db.calls.impactInserts[1].length, 1);
  assert.strictEqual(overChunk.db.calls.shortInserts[0].length, IMPACT_INSERT_CHUNK);
  assert.strictEqual(overChunk.db.calls.shortInserts[1].length, 1);

  const atFiveHundred = await runChunkedHappyPath(500);
  assert.strictEqual(atFiveHundred.chunks, 5);
  assert.strictEqual(atFiveHundred.db.impacts.size, 500);
  assert.strictEqual(atFiveHundred.db.shortsByImpact.size, 500);

  const partialImpactPersist = createFakeDb({
    impactInsert: function (n) {
      return n === 2 ? 'timeout' : 'ok';
    },
    persistOnUncertain: true,
  });
  const partialImpactPlans = await prepareIndividualSmsTracking({
    campaignId: '33333333-3333-4333-8333-333333333333',
    recipients: makeRecipients(IMPACT_INSERT_CHUNK + 1),
    destinationUrl: 'https://cz.uy/x',
    skipShorts: true,
    supabase: partialImpactPersist,
  });
  assert.strictEqual(partialImpactPlans.length, IMPACT_INSERT_CHUNK + 1);
  assert.strictEqual(partialImpactPersist.impacts.size, IMPACT_INSERT_CHUNK + 1);
  assertInsertChunkSizes(
    partialImpactPersist.calls.impactInserts,
    2,
    IMPACT_INSERT_CHUNK + 1,
  );

  const failAfterOneShortChunk = createFakeDb({
    shortInsert: function (n, rows) {
      if (rows.length < IMPACT_INSERT_CHUNK) return 'timeout';
      return 'ok';
    },
    persistOnUncertain: false,
  });
  let failAfterOneShortChunkErr = false;
  try {
    await prepareIndividualSmsTracking({
      campaignId: '44444444-4444-4444-8444-444444444444',
      recipients: makeRecipients(IMPACT_INSERT_CHUNK + 1),
      destinationUrl: 'https://cz.uy/x',
      skipShorts: false,
      supabase: failAfterOneShortChunk,
    });
  } catch (err) {
    failAfterOneShortChunkErr = true;
    assert.ok(err instanceof TrackingPrepError);
  }
  assert.ok(failAfterOneShortChunkErr, 'prep must fail after a later short chunk fails');
  assert.strictEqual(
    failAfterOneShortChunk.shortsByImpact.size,
    IMPACT_INSERT_CHUNK,
  );
  assert.ok(failAfterOneShortChunk.calls.shortInserts.length >= 1);
  assert.strictEqual(
    failAfterOneShortChunk.calls.shortInserts[0].length,
    IMPACT_INSERT_CHUNK,
  );

  const failAfterTwoOfFiveShortChunks = createFakeDb({
    shortInsert: function (n, rows) {
      if (n >= 3) return 'timeout';
      return 'ok';
    },
    persistOnUncertain: false,
  });
  let failAfterTwoChunksErr = false;
  try {
    await prepareIndividualSmsTracking({
      campaignId: '55555555-5555-4555-8555-555555555555',
      recipients: makeRecipients(500),
      destinationUrl: 'https://cz.uy/x',
      skipShorts: false,
      supabase: failAfterTwoOfFiveShortChunks,
    });
  } catch (err) {
    failAfterTwoChunksErr = true;
    assert.ok(err instanceof TrackingPrepError);
  }
  assert.ok(failAfterTwoChunksErr, 'prep must fail when a later 500-recipient short chunk fails');
  assert.strictEqual(
    failAfterTwoOfFiveShortChunks.shortsByImpact.size,
    IMPACT_INSERT_CHUNK * 2,
  );
  assert.ok(failAfterTwoOfFiveShortChunks.calls.shortInserts.length >= 2);
  assert.strictEqual(failAfterTwoOfFiveShortChunks.impacts.size, 500);

  const broken = createFakeDb({
    impactInsert: function () {
      return 'timeout';
    },
    persistOnUncertain: false,
  });
  let failed = false;
  try {
    await prepareIndividualSmsTracking({
      campaignId: '11111111-1111-4111-8111-111111111111',
      recipients: recipients,
      skipShorts: true,
      supabase: broken,
    });
  } catch (err) {
    failed = true;
    assert.ok(err instanceof TrackingPrepError);
  }
  assert.ok(failed, 'prep must fail when reconcile cannot close N impacts');

  console.log('OK unit-sms-marketing-impacts');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
