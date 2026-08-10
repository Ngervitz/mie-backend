/**
 * Smoke test for Serper JSON dedup by (file_hash, date).
 *
 * Prerequisites: apply migrations/20260810_serp_captures_source_type_dedup.sql
 *
 * Usage:
 *   node scripts/smoke-serp-json-date-dedup.js
 *
 * Uses samples/serper-prestamo-con-recibo-de-sueldo.json (or first arg path).
 * 1) Import once (or reuse existing same-day capture)
 * 2) Re-import same payload → must be duplicate:true
 * 3) Confirm findCaptureByHashAndDate(hash, otherDate) is null
 *    (would allow a new capture on a different Uruguay calendar day)
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const {
  importGoogleSerpJson,
  hashSerperJson,
} = require('../src/steps/collectGoogleSerpJsonImports');
const { todayUruguay } = require('../src/activity/dates');
const { addCalendarDays } = require('../src/lib/montevideo-week');

async function main() {
  const samplePath =
    process.argv[2] ||
    path.join(
      __dirname,
      '..',
      'samples',
      'serper-prestamo-con-recibo-de-sueldo.json',
    );
  const payload = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  const fileHash = hashSerperJson(payload);
  const today = todayUruguay();
  const otherDay = addCalendarDays(today, -1);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  const { error: probeErr } = await supabase
    .from('google_serp_captures')
    .select('source_type')
    .limit(1);
  if (probeErr && /source_type/i.test(probeErr.message || '')) {
    console.error(
      'Apply migrations/20260810_serp_captures_source_type_dedup.sql first.',
    );
    console.error(probeErr.message);
    process.exit(2);
  }

  console.log('sample', samplePath);
  console.log('fileHash', fileHash);
  console.log('today (UY)', today, 'otherDay', otherDay);

  const first = await importGoogleSerpJson({ payload });
  console.log('first import', {
    duplicate: first.duplicate,
    captureId: first.captureId,
    date: first.date,
    adsInserted: first.adsInserted,
    organicInserted: first.organicInserted,
  });

  const second = await importGoogleSerpJson({ payload });
  console.log('second import (same day)', {
    duplicate: second.duplicate,
    captureId: second.captureId,
    date: second.date,
  });

  if (!second.duplicate) {
    console.error('FAIL: same-day reimport must be duplicate:true');
    process.exit(1);
  }
  if (second.captureId !== first.captureId && !first.duplicate) {
    console.error('FAIL: duplicate should point at first capture');
    process.exit(1);
  }

  const { data: otherDayHit, error: otherErr } = await supabase
    .from('google_serp_captures')
    .select('id, date, source_type')
    .eq('file_hash', fileHash)
    .eq('date', otherDay)
    .eq('source_type', 'serper_json')
    .maybeSingle();
  if (otherErr) throw otherErr;

  console.log('lookup same hash on otherDay', otherDayHit);
  if (otherDayHit) {
    console.log(
      'NOTE: otherDay already has this hash (prior run) — cross-day allowance already exercised historically.',
    );
  } else {
    console.log(
      'OK: no capture for hash+otherDay → a run on that date would insert a new capture.',
    );
  }

  console.log('PASS: same-day Serper dedup works.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
