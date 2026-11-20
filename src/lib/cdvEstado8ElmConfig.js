'use strict';

/**
 * CDV estado 8 → ELM automation flags. Default off; only the string "true" enables.
 */

const { WORKER_AUTOMATIC_EXCLUDED_CZ_SOLICITUD_IDS } = require('../services/providerFallback/constants');

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BATCH_LIMIT = 5;
const PREAPROBADOS_ESTADO_ID = 8;

function intIn(raw, fallback, min, max) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function readCdvEstado8ElmConfig(env) {
  const e = env || process.env;
  return Object.freeze({
    automationEnabled:
      String(e.CDV_ESTADO8_ELM_AUTOMATION_ENABLED || '').trim().toLowerCase() === 'true',
    maxAttempts: intIn(e.CDV_ESTADO8_ELM_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 50),
    batchLimit: intIn(e.CDV_ESTADO8_ELM_BATCH_LIMIT, DEFAULT_BATCH_LIMIT, 1, 20),
    excludedCzSolicitudIds: WORKER_AUTOMATIC_EXCLUDED_CZ_SOLICITUD_IDS,
    estadoId: PREAPROBADOS_ESTADO_ID,
    triggerOrigin: 'cdv_estado_8',
  });
}

module.exports = {
  PREAPROBADOS_ESTADO_ID,
  readCdvEstado8ElmConfig,
};