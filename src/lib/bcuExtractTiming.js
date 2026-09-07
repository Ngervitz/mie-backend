'use strict';

/**
 * Stage 3 BCU extract timing constants.
 * LEASE_TTL_MS is derived — do not treat timeout and lease as independent knobs.
 */

const OPENAI_TIMEOUT_MS = 120000;
const LEASE_MARGIN_MS = 60000;
const LEASE_TTL_MS = OPENAI_TIMEOUT_MS + LEASE_MARGIN_MS;

if (!(LEASE_TTL_MS > OPENAI_TIMEOUT_MS)) {
  throw new Error(
    'Invariant violated: LEASE_TTL_MS must be greater than OPENAI_TIMEOUT_MS',
  );
}

const BCU_EXTRACT_MODEL_DEFAULT = 'gpt-4.1';
const BCU_EXTRACT_DETAIL_DEFAULT = 'high';

/** Active same_upload statuses (V1). Deliberately excludes confirmed/abandoned/expired/snapshots. */
const ACTIVE_DEDUP_STATUSES = Object.freeze([
  'extracting',
  'extraction_failed',
  'pending_review',
]);

module.exports = {
  OPENAI_TIMEOUT_MS,
  LEASE_MARGIN_MS,
  LEASE_TTL_MS,
  BCU_EXTRACT_MODEL_DEFAULT,
  BCU_EXTRACT_DETAIL_DEFAULT,
  ACTIVE_DEDUP_STATUSES,
};
