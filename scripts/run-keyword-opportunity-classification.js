'use strict';

/**
 * One-shot: classify the latest discovered_term_cpc_estimates sync_run_id.
 * Requires migration 20260813_keyword_cpc_classification.sql applied.
 */

require('dotenv').config();
if (!process.env.APIFY_TOKEN) process.env.APIFY_TOKEN = 'local-placeholder';
if (!process.env.APIFY_ACTOR_ID) process.env.APIFY_ACTOR_ID = 'local-placeholder';

const { createClient } = require('@supabase/supabase-js');
const {
  classifyAndPersistSyncRun,
} = require('../src/lib/keywordOpportunityClassification');

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const { data: latestRows, error: latestErr } = await sb
    .from('discovered_term_cpc_estimates')
    .select('sync_run_id, fetched_at')
    .order('fetched_at', { ascending: false })
    .limit(1);

  if (latestErr) throw new Error(latestErr.message);
  if (!latestRows || !latestRows.length) {
    console.log('No discovered_term_cpc_estimates rows');
    process.exit(1);
  }

  const syncRunId = String(latestRows[0].sync_run_id);
  console.log('Latest sync_run_id:', syncRunId);
  console.log('fetched_at:', latestRows[0].fetched_at);

  const result = await classifyAndPersistSyncRun(
    'discovered_term_cpc_estimates',
    syncRunId,
  );

  console.log('\n=== COUNTS ===');
  console.log(JSON.stringify(result.counts, null, 2));
  console.log('total:', result.total);
  console.log('version:', result.classificationVersion);
  console.log('transactionNote:', result.transactionNote);

  const byStatus = {};
  for (const r of result.results) {
    if (!byStatus[r.classification_status]) {
      byStatus[r.classification_status] = [];
    }
    byStatus[r.classification_status].push(r);
  }

  console.log('\n=== EXAMPLES (up to 5 per category) ===');
  for (const [status, list] of Object.entries(byStatus)) {
    console.log(`\n--- ${status} (${list.length}) ---`);
    list.slice(0, 5).forEach((r) => {
      console.log(
        JSON.stringify({
          term: r.term,
          volume: r.avgMonthlySearches,
          competition: r.competitionLevel,
          bidUnit: r.bidUnit,
          efficiency_score: r.efficiency_score,
          status: r.classification_status,
          classification_version: r.classification_version,
        }),
      );
    });
  }
}

main().catch((err) => {
  console.error('FAILED:', err && err.message ? err.message : err);
  if (err && err.code) console.error('code:', err.code);
  process.exit(1);
});
