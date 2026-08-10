'use strict';

/**
 * One-shot: resolve pending google_serp_import rows that exact-match an active
 * monitored entity, or are excluded platform domains (facebook/instagram).
 * Idempotent — only updates decision='pending' rows.
 *
 * Usage: node scripts/cleanup-serp-pending-unmatched.js
 */

require('dotenv').config();
const {
  resolvePendingSerpUnmatchedDomains,
} = require('../src/steps/collectGoogleSerpImports');

(async () => {
  const result = await resolvePendingSerpUnmatchedDomains();
  console.log(
    JSON.stringify(
      {
        scanned: result.scanned,
        resolvedMatched: result.resolvedMatched,
        resolvedPlatform: result.resolvedPlatform,
        leftPending: result.leftPending,
        matched: result.matched,
        platforms: result.platforms,
        remaining: result.remaining,
      },
      null,
      2,
    ),
  );

  // Second pass — should be a no-op if idempotent.
  const again = await resolvePendingSerpUnmatchedDomains();
  console.log(
    JSON.stringify(
      {
        secondPass: {
          scanned: again.scanned,
          resolvedMatched: again.resolvedMatched,
          resolvedPlatform: again.resolvedPlatform,
          leftPending: again.leftPending,
        },
      },
      null,
      2,
    ),
  );
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
