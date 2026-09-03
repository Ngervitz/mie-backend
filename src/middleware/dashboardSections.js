/**
 * Central map: dashboard section_key → protected HTTP routes.
 *
 * Authorization is enforced via requireDashboardPermission(sectionKey) at
 * router mount points, and via enforceMappedSectionPermission for mixed
 * routers (/reports, /jobs) whose paths span multiple sections.
 *
 * Frontend tab show/hide is UX only — this map is the source of truth for
 * real access control on the backend.
 */

/** @type {readonly string[]} */
const SECTION_KEYS = Object.freeze([
  'market',
  'discoveries',
  'ai-visibility',
  'ga4',
  'searchconsole',
  'meta',
  'sms',
  'email',
  'inbox',
  'cz-funnel',
  'rechazados',
]);

/**
 * Absolute path prefixes (Express mount + route). Trailing slash optional.
 * More specific prefixes should be listed before shorter ones when overlapping
 * (matcher picks longest matching prefix).
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const SECTION_ROUTE_PREFIXES = Object.freeze({
  market: Object.freeze([
    '/reports/daily-summary',
    '/reports/auction-pressure',
    '/reports/competitor-activity-weekly',
    '/reports/import-google-serp',
    '/reports/import-google-serp-json',
    '/reports/serp-queries',
    '/reports/google-serp-imports',
    '/reports/google-serp-competitor-presence',
    '/reports/google-serp-entity-presence',
    '/reports/keyword-cpc-estimates',
    '/reports/sync-run-summaries',
    '/competitor-activity-predictions',
    '/market-patterns',
    '/ml-notes',
    '/assist',
    '/jobs/run-sync',
    '/jobs/status',
    '/jobs/run-activity',
    '/jobs/activity-status',
    '/jobs/run-economic-calendar',
    '/jobs/economic-calendar-status',
    '/jobs/run-serp-import-sync',
    '/jobs/run-keyword-cpc-sync',
    '/jobs/run-keyword-run-analysis',
  ]),
  discoveries: Object.freeze([
    '/reports/search-discoveries',
    '/reports/coverage-suggestions',
    '/reports/seo-landing-drafts',
    '/reports/keyword-research',
    '/jobs/run-search-trends',
    '/jobs/search-trends-status',
    '/jobs/discover-search-terms',
    '/jobs/run-discovery-refresh',
    '/jobs/discovery-refresh-status',
    '/jobs/run-discovered-term-cpc-sync',
  ]),
  'ai-visibility': Object.freeze(['/ai-visibility']),
  ga4: Object.freeze([
    '/reports/ga4-metrics',
    '/jobs/run-ga4-metrics',
    '/jobs/ga4-metrics-status',
    '/jobs/ga4-audit',
  ]),
  searchconsole: Object.freeze(['/jobs/search-console-audit']),
  meta: Object.freeze([
    '/reports/own-ad-changes',
    '/reports/hugo-context',
    '/reports/next-economic-events',
    '/hugo/knowledge-own-ads',
    '/api/liquidity-cycle',
    '/api/bcu-usura-rate',
    '/jobs/run-metaagente',
    '/jobs/metaagente-status',
    '/jobs/run-own-ad-changes',
    '/jobs/own-ad-changes-status',
    '/jobs/run-liquidity-cycle-sync',
  ]),
  sms: Object.freeze(['/sms', '/jobs/run-sms-notifyme-poll']),
  email: Object.freeze(['/email', '/jobs/run-cz-sync']),
  inbox: Object.freeze([
    '/api/social-comments',
    '/api/social-conversations',
    '/jobs/run-instagram-posts-sync',
    '/jobs/run-instagram-comments-poll',
    '/jobs/run-instagram-reply-recovery',
    '/jobs/run-instagram-dms-sync',
    '/jobs/run-facebook-posts-sync',
    '/jobs/run-facebook-comments-poll',
    '/jobs/run-facebook-reply-recovery',
  ]),
  'cz-funnel': Object.freeze([
    '/reports/cz-funnel-summary',
    '/reports/cz-funnel-channel-utility',
    '/jobs/run-cz-data-sync',
    '/jobs/run-bcu-usd-rate-sync',
  ]),
  rechazados: Object.freeze(['/rechazados']),
});

/**
 * Mount-level section → Express path prefix (used in app.js / server.js).
 * These routers are dedicated to one section.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const SECTION_MOUNT_PREFIXES = Object.freeze({
  inbox: Object.freeze([
    '/api/social-comments',
    '/api/social-conversations',
  ]),
  sms: Object.freeze(['/sms']),
  email: Object.freeze(['/email']),
  'ai-visibility': Object.freeze(['/ai-visibility']),
  market: Object.freeze([
    '/competitor-activity-predictions',
    '/market-patterns',
    '/ml-notes',
    '/assist',
  ]),
  meta: Object.freeze(['/api/liquidity-cycle', '/api/bcu-usura-rate']),
  rechazados: Object.freeze(['/rechazados']),
});

/**
 * @param {string} pathname
 * @param {string} prefix
 * @returns {boolean}
 */
function pathMatchesPrefix(pathname, prefix) {
  if (pathname === prefix) return true;
  if (pathname.startsWith(prefix + '/')) return true;
  return false;
}

/**
 * Resolve which section (if any) a request path belongs to.
 * Longest matching prefix wins when multiple sections could match.
 *
 * @param {string} pathname  req.path or full path after mounts (use originalUrl path)
 * @returns {string|null} section_key or null if not section-gated
 */
function resolveSectionForPath(pathname) {
  const path = String(pathname || '').split('?')[0];
  let bestKey = null;
  let bestLen = -1;

  for (const key of SECTION_KEYS) {
    const prefixes = SECTION_ROUTE_PREFIXES[key] || [];
    for (const prefix of prefixes) {
      if (pathMatchesPrefix(path, prefix) && prefix.length > bestLen) {
        bestKey = key;
        bestLen = prefix.length;
      }
    }
  }
  return bestKey;
}

module.exports = {
  SECTION_KEYS,
  SECTION_ROUTE_PREFIXES,
  SECTION_MOUNT_PREFIXES,
  resolveSectionForPath,
  pathMatchesPrefix,
};
