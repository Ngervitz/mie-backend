/**
 * Shared transformation: discoverRelatedQueries result -> search_term_discoveries
 * rows. Used by the /jobs/run-discovery-refresh route (Railway) and by
 * scripts/local-discovery-refresh.js (local machine). Extracted verbatim from
 * jobs.js — behavior unchanged.
 */
function buildDiscoveryRows(seed, result, discoveredAt) {
  const rows = [];
  for (const [queryType, items] of [
    ['top', result.top || []],
    ['rising', result.rising || []],
  ]) {
    for (const item of items) {
      if (!item.query) continue;
      rows.push({
        seed,
        term: item.query,
        query_type: queryType,
        score: item.value,
        formatted_value: item.formattedValue,
        raw_json: item,
        discovered_at: discoveredAt,
      });
    }
  }
  return rows;
}

module.exports = { buildDiscoveryRows };
