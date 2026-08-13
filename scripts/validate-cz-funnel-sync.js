/**
 * Post-migration validation for CZ funnel sync.
 * Requires: migration applied + CZ_API_BEARER_TOKEN + local/prod server or inline job.
 *
 *   node scripts/validate-cz-funnel-sync.js
 *
 * Runs runCzFunnelSync() in-process (no HTTP server required).
 */

require('dotenv').config();

if (!process.env.APIFY_TOKEN) process.env.APIFY_TOKEN = 'validate-stub';
if (!process.env.APIFY_ACTOR_ID) process.env.APIFY_ACTOR_ID = 'validate-stub';

const supabase = require('../src/clients/supabase');
const { runCzFunnelSync } = require('../src/jobs/czFunnelSync');
const {
  TRACKING_SUMMARY_ALLOWLIST,
} = require('../src/lib/sanitizeCzTrackingData');

const FORBIDDEN = [
  'ip',
  'user-agent',
  'user_agent',
  'fbp',
  'fbc',
  'fbclid',
  'fbclid_init',
  'ga4_client_id',
  'gtag',
  'gtm',
  'ctwa_id',
  'ua',
];

async function count(table) {
  const { count, error } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count || 0;
}

async function main() {
  if (!String(process.env.CZ_API_BEARER_TOKEN || '').trim()) {
    throw new Error('CZ_API_BEARER_TOKEN missing');
  }

  // Reset cursors to initial historical window for first full run report
  for (const source of [
    'cz_funnel_granted_loans',
    'cz_funnel_solicitudes',
    'cz_funnel_encuestas',
  ]) {
    await supabase
      .from('cz_funnel_sync_cursors')
      .upsert({
        source_name: source,
        last_since: null,
        last_sync_status: null,
        last_sync_error: null,
        updated_at: new Date().toISOString(),
      });
  }

  console.log('Running runCzFunnelSync from initialSince…');
  const result = await runCzFunnelSync();
  console.log(JSON.stringify(result, null, 2));

  const tables = [
    'cz_funnel_granted_loans',
    'cz_funnel_solicitudes',
    'cz_funnel_encuestas',
  ];
  console.log('\n--- counts ---');
  for (const t of tables) {
    console.log(t, await count(t));
  }

  // Legacy untouched
  console.log('\n--- legacy counts (must be unchanged by this job) ---');
  for (const t of [
    'cz_granted_loans',
    'cz_solicitudes_synced',
    'cz_encuestas_synced',
    'cz_sync_cursor',
  ]) {
    try {
      console.log(t, await count(t));
    } catch (e) {
      console.log(t, 'err', e.message);
    }
  }

  // tracking allowlist audit
  const { data: sols, error } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id, tracking_data_summary');
  if (error) throw new Error(error.message);
  const allow = new Set(TRACKING_SUMMARY_ALLOWLIST);
  let bad = 0;
  for (const row of sols || []) {
    const obj = row.tracking_data_summary || {};
    for (const k of Object.keys(obj)) {
      if (!allow.has(k) || FORBIDDEN.includes(k)) {
        bad += 1;
        console.log('BAD key', row.cz_id, k);
      }
    }
  }
  console.log('\ntracking_data_summary forbidden keys found:', bad);

  // summary endpoint logic via direct import would need express; query aggregates simply
  console.log('\nDONE');
}

main().catch((err) => {
  console.error('FAIL', err.message || err);
  process.exit(1);
});
