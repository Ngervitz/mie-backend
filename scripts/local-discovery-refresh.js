#!/usr/bin/env node
/**
 * Local discovery refresh — run this on a LOCAL machine, NOT on Railway.
 *
 * WHY THIS EXISTS
 * Google Trends' relatedsearches endpoint persistently 429s content-bearing
 * queries coming from Railway's datacenter IP (verified in production:
 * "préstamo"/"crédito" fail after 10 patient backoff attempts, while the same
 * code succeeds in seconds from a residential IP). Empty-result queries
 * succeed either way. This is a deliberate architectural exception: the
 * monthly discovery refresh runs from Nico's PC instead of the deployed app.
 *
 * HOW TO RUN
 *   node scripts/local-discovery-refresh.js
 * Requires a local .env at the repo root (gitignored) with:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   <- service role, NOT the anon key
 * RLS audit (2026-07-17): search_term_discoveries has RLS enabled and NO
 * anon INSERT policy ("new row violates row-level security"), so the service
 * role key is required. It bypasses RLS entirely — treat it as a secret,
 * never commit it.
 *
 * CADENCE: manual, roughly once a month. The table is append-only by design,
 * so each run adds a new discovery snapshot. Within a single run, each seed's
 * successful result is persisted exactly once (the retry/backoff loop lives
 * inside the fetch, before any persistence happens).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = REQUIRED_ENV.filter((name) => !process.env[name] || !String(process.env[name]).trim());
if (missing.length) {
  console.error(
    `ERROR: missing required environment variable(s): ${missing.join(', ')}\n` +
      'Create a .env file at the repo root (see .env.example). ' +
      'This script needs the SERVICE ROLE key (anon has no INSERT policy on search_term_discoveries).',
  );
  process.exit(1);
}

// Fail fast with a specific message if the configured key is not actually a
// service-role JWT (e.g. the anon key was pasted by mistake): inserts would
// otherwise fail later with an opaque RLS violation per seed.
try {
  const payload = JSON.parse(
    Buffer.from(String(process.env.SUPABASE_SERVICE_ROLE_KEY).split('.')[1], 'base64').toString(),
  );
  if (payload.role !== 'service_role') {
    console.error(
      `ERROR: SUPABASE_SERVICE_ROLE_KEY has role "${payload.role}", expected "service_role".\n` +
        'You probably pasted the anon key. Copy the service_role key from ' +
        'Supabase Dashboard > Settings > API (keep it secret — it bypasses RLS).',
    );
    process.exit(1);
  }
} catch (err) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY does not look like a valid Supabase JWT.');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const {
  discoverRelatedQueries,
  createSession,
} = require('../src/steps/discoverRelatedQueries');
const { buildDiscoveryRows } = require('../src/lib/discovery-rows');

// Direct client on purpose: src/clients/supabase.js pulls src/config/env.js,
// which demands unrelated variables (Apify, etc.) this script doesn't need.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SEEDS = ['préstamo', 'crédito', 'dinero rápido', 'efectivo urgente'];
const INTER_SEED_DELAY_MS = 15000; // residential IP needs less spacing than Railway's 45s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Local discovery refresh — ${SEEDS.length} seeds, geo UY`);
  console.log('');

  // One shared session so later seeds reuse the NID cookie.
  const session = createSession();
  const succeeded = [];
  const failed = [];
  let rowsPersisted = 0;

  for (let i = 0; i < SEEDS.length; i += 1) {
    const seed = SEEDS[i];
    if (i > 0) {
      console.log(`  (waiting ${INTER_SEED_DELAY_MS / 1000}s before next seed...)`);
      await sleep(INTER_SEED_DELAY_MS);
    }
    console.log(`[${i + 1}/${SEEDS.length}] seed "${seed}" — fetching...`);

    try {
      // All retry/backoff happens inside this call; it resolves at most once,
      // so the persistence below runs exactly once per successful fetch.
      const result = await discoverRelatedQueries(seed, session);
      const rows = buildDiscoveryRows(seed, result, new Date().toISOString());

      let persisted = 0;
      if (rows.length) {
        const { error } = await supabase.from('search_term_discoveries').insert(rows);
        if (error) {
          throw new Error(`Persist failed: ${error.message}`);
        }
        persisted = rows.length;
      }
      rowsPersisted += persisted;
      succeeded.push({ seed, top: result.top.length, rising: result.rising.length, persisted });
      console.log(
        `  OK — top: ${result.top.length}, rising: ${result.rising.length}, persisted: ${persisted} rows`,
      );
    } catch (err) {
      const message = err && err.message ? err.message : 'unknown';
      failed.push({ seed, error: message });
      console.error(`  FAILED — ${message} (continuing with remaining seeds)`);
    }
  }

  console.log('');
  console.log('===== SUMMARY =====');
  console.log(`Seeds OK:     ${succeeded.length}/${SEEDS.length}`);
  for (const s of succeeded) {
    console.log(`  "${s.seed}": top ${s.top} / rising ${s.rising} / persisted ${s.persisted}`);
  }
  if (failed.length) {
    console.log(`Seeds FAILED: ${failed.length}`);
    for (const f of failed) {
      console.log(`  "${f.seed}": ${f.error}`);
    }
  }
  console.log(`Rows persisted total: ${rowsPersisted}`);
  process.exit(failed.length === SEEDS.length ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
