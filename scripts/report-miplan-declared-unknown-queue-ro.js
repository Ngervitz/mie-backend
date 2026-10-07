'use strict';

/**
 * Mi Deuda Stage 2 — READ-ONLY review queue of declared creditors not resolved at ingestion.
 * Grouped by (source='miplan_declared', normalized_key): occurrences, active occurrences,
 * distinct CI count (never the CIs), raw examples, Mi Plan display hints and the catalog's
 * CURRENT resolution as a hint only. Nothing is remapped; no write is issued.
 *
 * Run: node scripts/report-miplan-declared-unknown-queue-ro.js [--limit=50]
 */

const { buildUnknownCreditorQueue } = require('../src/lib/miDeudaDeclaredLayer');
const { RESOLUTION } = require('../src/lib/creditorCatalog');
const { DEBT_SELECT, EVENT_SELECT } = require('../src/lib/miplanDebtOptinRead');

const PAGE_SIZE = 1000;

async function fetchAll(supabase, table, select, filter) {
  const out = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(select);
    if (filter) q = filter(q);
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(table + ' read failed: ' + (error.code || 'error'));
    const chunk = Array.isArray(data) ? data : [];
    out.push.apply(out, chunk);
    if (chunk.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

/**
 * @param {object} supabase read-only usage: select only
 * @param {{ loadCatalog: Function }} deps
 */
async function buildQueueReport(supabase, deps) {
  const resolver = await deps.loadCatalog(supabase);
  const events = await fetchAll(supabase, 'miplan_debt_optin_events', EVENT_SELECT);
  const debts = await fetchAll(supabase, 'miplan_declared_debts', DEBT_SELECT, function (q) {
    return q.neq('ingestion_resolution', RESOLUTION.RESOLVED);
  });
  return buildUnknownCreditorQueue({ debts: debts, events: events, resolver: resolver });
}

async function main() {
  const limitArg = process.argv.find(function (a) {
    return a.indexOf('--limit=') === 0;
  });
  const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 50) : 50;
  const supabase = require('../src/clients/supabase');
  const { loadCreditorCatalog } = require('../src/lib/creditorCatalogRead');
  const queue = await buildQueueReport(supabase, { loadCatalog: loadCreditorCatalog });
  console.log(JSON.stringify({ groups: queue.length, queue: queue.slice(0, limit) }, null, 2));
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('report-miplan-declared-unknown-queue-ro failed: ' + (e && e.message));
    process.exit(1);
  });
}

module.exports = { buildQueueReport };
