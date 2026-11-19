'use strict';

/**
 * Unit checks: explicit backlog exclusion list + worker claim wiring (no DB).
 */

const assert = require('assert');
const { WORKER_AUTOMATIC_EXCLUDED_CZ_SOLICITUD_IDS } = require('../src/services/providerFallback/constants');
const { readProviderFallbackConfig } = require('../src/services/providerFallback/config');
const fs = require('fs');
const path = require('path');

const EXPECTED = [1490, 1491, 1948, 1962, 1966, 2424, 3115, 3532];

assert.deepStrictEqual(
  [...WORKER_AUTOMATIC_EXCLUDED_CZ_SOLICITUD_IDS],
  EXPECTED,
  'frozen exclusion list must match ops triage ids',
);

const cfg = readProviderFallbackConfig({ PROVIDER_FALLBACK_WORKER_ENABLED: 'true' });
assert.deepStrictEqual(
  [...cfg.workerExcludedCzSolicitudIds],
  EXPECTED,
  'config must pass the same frozen list to claim',
);
assert.strictEqual(cfg.kickRetryDelayMs, 20000);
assert.strictEqual(cfg.kickRetryMaxAttempts, 2);

const mig = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20261120_provider_fallback_claim_excluded_cz.sql'),
  'utf8',
);
assert.match(mig, /p_excluded_cz_solicitud_ids/, 'migration adds exclusion parameter');
assert.match(
  mig,
  /NOT \(o\.cz_solicitud_id = ANY\(p_excluded_cz_solicitud_ids\)\)/,
  'excluded rows must not block younger jobs on same CI',
);

const repo = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'providerFallback', 'repository.js'),
  'utf8',
);
assert.match(repo, /p_excluded_cz_solicitud_ids/, 'repository passes exclusion array to RPC');

const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'providerFallback', 'worker.js'), 'utf8');
assert.match(worker, /excludedCzSolicitudIds: config\.workerExcludedCzSolicitudIds/, 'runOnce claim uses exclusion');
assert.match(worker, /kickRetryMaxAttempts/, 'kick retries when claim empty');

console.log('unit-worker-automatic-exclusion: ok');