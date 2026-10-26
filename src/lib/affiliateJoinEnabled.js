'use strict';

/**
 * Public affiliate registration gate (env-only, no I/O).
 */

function isAffiliateJoinEnabled() {
  return String(process.env.AFFILIATE_JOIN_ENABLED || '').toLowerCase() === 'true';
}

module.exports = {
  isAffiliateJoinEnabled,
};
