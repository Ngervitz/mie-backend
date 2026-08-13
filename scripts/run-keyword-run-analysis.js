'use strict';

/**
 * Run Claude keyword analysis for the latest discovered_term_cpc_estimates sync_run,
 * then re-run once to prove UNIQUE upsert idempotency.
 * Requires: migration sync_run_summaries + ANTHROPIC_API_KEY.
 */

require('dotenv').config();
if (!process.env.APIFY_TOKEN) process.env.APIFY_TOKEN = 'local-placeholder';
if (!process.env.APIFY_ACTOR_ID) process.env.APIFY_ACTOR_ID = 'local-placeholder';

const { createClient } = require('@supabase/supabase-js');
const {
  generateKeywordRunAnalysis,
} = require('../src/services/keywordRunAnalysis');

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const { data: latest, error } = await sb
    .from('discovered_term_cpc_estimates')
    .select('sync_run_id, fetched_at, classification_status, efficiency_score')
    .order('fetched_at', { ascending: false })
    .limit(5);

  if (error) throw new Error(error.message);
  if (!latest || !latest.length) {
    console.log('No discovered CPC rows');
    process.exit(1);
  }

  const syncRunId = String(latest[0].sync_run_id);
  console.log('Using sync_run_id:', syncRunId);
  console.log(
    'Sample classification before LLM (must stay unchanged):',
    latest.slice(0, 3).map((r) => ({
      status: r.classification_status,
      score: r.efficiency_score,
    })),
  );

  const sourceTable = 'discovered_term_cpc_estimates';

  const first = await generateKeywordRunAnalysis({ syncRunId, sourceTable });
  console.log('\n=== FIRST RUN ===');
  console.log(
    JSON.stringify(
      {
        ok: first.ok,
        summaryId: first.summaryId,
        modelUsed: first.modelUsed,
        rowCountTotal: first.rowCountTotal,
        rowCountSent: first.rowCountSent,
        suggestionMetrics: first.suggestionMetrics,
        summaryText: first.summaryText,
        comparativeCount: (first.comparativeAnalysis || []).length,
        suggestedCount: (first.suggestedNewTerms || []).length,
      },
      null,
      2,
    ),
  );
  console.log('\ncomparative_analysis:');
  console.log(JSON.stringify(first.comparativeAnalysis || [], null, 2));
  console.log('\nsuggested_new_terms:');
  console.log(JSON.stringify(first.suggestedNewTerms || [], null, 2));

  const second = await generateKeywordRunAnalysis({ syncRunId, sourceTable });
  console.log('\n=== SECOND RUN (idempotency) ===');
  console.log(
    JSON.stringify(
      {
        summaryId: second.summaryId,
        sameId: first.summaryId === second.summaryId,
      },
      null,
      2,
    ),
  );

  const { data: rows, error: countErr } = await sb
    .from('sync_run_summaries')
    .select('id')
    .eq('sync_run_id', syncRunId)
    .eq('source_table', sourceTable);
  if (countErr) throw new Error(countErr.message);
  console.log('Rows for sync_run+source after 2 runs:', (rows || []).length);

  const { data: afterClass } = await sb
    .from('discovered_term_cpc_estimates')
    .select('classification_status, efficiency_score')
    .eq('sync_run_id', syncRunId)
    .limit(5);
  console.log(
    'Classification sample AFTER LLM (must match structure/presence):',
    (afterClass || []).map((r) => ({
      status: r.classification_status,
      score: r.efficiency_score,
    })),
  );

  // Failure path: invalid sync should not clear classification
  try {
    await generateKeywordRunAnalysis({
      syncRunId: '00000000-0000-0000-0000-000000000000',
      sourceTable,
    });
  } catch (e) {
    console.log('\nExpected failure for empty/missing run:', e.message || e);
  }

  const { count } = await sb
    .from('discovered_term_cpc_estimates')
    .select('id', { count: 'exact', head: true })
    .eq('sync_run_id', syncRunId)
    .not('classification_status', 'is', null);
  console.log(
    'Classified rows still present for real sync_run:',
    count,
  );
}

main().catch((err) => {
  console.error('FAILED:', err && err.message ? err.message : err);
  if (err && err.code) console.error('code:', err.code);
  process.exit(1);
});
