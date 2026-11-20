'use strict';

/**
 * Transactional SMS when ELM S2 is referred. Uses frozen s2_request.mobilephone only.
 * Default: dry-run (no Notifyme). Idempotent via sms_messages (source_system + process id).
 */

const supabase = require('../clients/supabase');
const logger = require('./logger');
const { S2, CODES } = require('../services/elm/constants');

const SOURCE_SYSTEM = 'elm_s2_referred';
const MESSAGE_TEXT =
  'Credizona: Tenés una alternativa de crédito con Préstamos en la Mano. ' +
  'Un asesor te llamara pronto para continuar tu solicitud.';

function readElmS2ReferredSmsConfig(env) {
  const e = env || process.env;
  return Object.freeze({
    enabled: String(e.ELM_S2_REFERRED_SMS_ENABLED || '').trim().toLowerCase() === 'true',
    sendEnabled: String(e.ELM_S2_REFERRED_SMS_SEND_ENABLED || '').trim().toLowerCase() === 'true',
    campaignId: e.ELM_S2_REFERRED_SMS_CAMPAIGN_ID
      ? String(e.ELM_S2_REFERRED_SMS_CAMPAIGN_ID).trim()
      : null,
  });
}

function phoneFromS2Request(process) {
  const body = process && process.s2_request;
  if (!body || typeof body !== 'object') return null;
  const raw = body.mobilephone;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

function isEligibleForSms(process) {
  if (!process || !process.id) return false;
  if (process.s2_status !== S2.REFERRED || !process.referred_at) return false;
  if (process.s1_error_code === CODES.S1_DUPLICATE_OTHER_CHANNEL) return false;
  return true;
}

async function existingSms(processId) {
  const { data, error } = await supabase
    .from('sms_messages')
    .select('unique_id')
    .eq('source_system', SOURCE_SYSTEM)
    .eq('source_record_id', String(processId))
    .limit(1);
  if (error) throw new Error('sms_messages lookup: ' + error.message);
  return data && data.length ? data[0] : null;
}

/**
 * @param {object} process elm_lead_processes row (incl. s2_request)
 * @param {object} [deps]
 */
async function trySendElmS2ReferredSms(process, deps) {
  const d = deps || {};
  const config = d.config || readElmS2ReferredSmsConfig();
  if (!config.enabled) return { ok: true, skipped: 'disabled' };
  if (!isEligibleForSms(process)) return { ok: true, skipped: 'not_referred' };

  const processId = String(process.id);
  try {
    if (await existingSms(processId)) {
      return { ok: true, skipped: 'already_sent' };
    }
  } catch (err) {
    logger.warn('elm_s2_referred_sms idempotency check failed', {
      process_id: processId,
      error: err && err.message ? err.message : 'unknown',
    });
    return { ok: false, error: 'idempotency_check_failed' };
  }

  const phone = phoneFromS2Request(process);
  if (!phone) {
    return { ok: false, error: 'mobilephone_missing_in_s2_request' };
  }

  if (!config.sendEnabled) {
    logger.info('elm_s2_referred_sms dry-run', {
      process_id: processId,
      cz_solicitud_id: process.cz_solicitud_id,
      phone_length: phone.length,
      text_length: MESSAGE_TEXT.length,
    });
    return { ok: true, dry_run: true };
  }

  if (!config.campaignId) {
    return { ok: false, error: 'campaign_not_configured' };
  }

  const insertDeliver =
    d.insertDeliver || require('../services/notifyme-client').insertDeliverAndReconcileSingle;
  try {
    const result = await insertDeliver(config.campaignId, {
      phone: phone,
      text: MESSAGE_TEXT,
      source_system: SOURCE_SYSTEM,
      source_record_id: processId,
      czuid: process.ci != null ? String(process.ci) : null,
    });
    return { ok: result.ok !== false, notifyme: result };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : 'unknown';
    if (/duplicate|unique/i.test(msg)) {
      return { ok: true, skipped: 'already_sent_race' };
    }
    logger.warn('elm_s2_referred_sms notifyme failed', {
      process_id: processId,
      error: msg.slice(0, 200),
    });
    return { ok: false, error: 'notifyme_failed' };
  }
}

module.exports = {
  SOURCE_SYSTEM,
  MESSAGE_TEXT,
  readElmS2ReferredSmsConfig,
  phoneFromS2Request,
  isEligibleForSms,
  trySendElmS2ReferredSms,
};