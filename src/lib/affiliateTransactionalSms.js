'use strict';

/**
 * Thin Notifyme wrapper for affiliate OTP / welcome SMS.
 * Default is dry-run (no provider call) unless AFFILIATE_TX_SMS_ENABLED=true.
 */

const logger = require('./logger');

/**
 * @param {object} [overrides]
 * @returns {boolean}
 */
function isAffiliateTxSmsDryRun(overrides) {
  if (overrides && overrides.dryRun === true) return true;
  if (overrides && overrides.dryRun === false) return false;
  return String(process.env.AFFILIATE_TX_SMS_ENABLED || '').toLowerCase() !== 'true';
}

/**
 * @param {{
 *   kind: 'otp' | 'welcome',
 *   phone: string,
 *   text: string,
 *   ci: number,
 *   sourceRecordId: string,
 *   sendBatch?: function,
 *   dryRun?: boolean,
 * }} args
 */
async function queueAffiliateTransactionalSms(args) {
  const phone = args && args.phone != null ? String(args.phone).trim() : '';
  const text = args && args.text != null ? String(args.text).trim() : '';
  if (!phone || !text) {
    return { ok: false, error: 'invalid_sms_payload' };
  }

  if (isAffiliateTxSmsDryRun(args)) {
    logger.info('affiliate transactional SMS dry-run', {
      kind: args.kind || 'unknown',
      ci: args.ci,
      phone_length: phone.length,
      text_length: text.length,
    });
    return {
      ok: true,
      dry_run: true,
      provider: 'notifyme',
      queued: false,
    };
  }

  const campaignId = process.env.AFFILIATE_TX_SMS_CAMPAIGN_ID
    ? String(process.env.AFFILIATE_TX_SMS_CAMPAIGN_ID).trim()
    : null;
  if (!campaignId) {
    return { ok: false, error: 'affiliate_tx_sms_not_configured' };
  }

  const sendBatch =
    args.sendBatch ||
    require('../services/notifyme-client').sendBatch;

  const sourceSystem =
    args.kind === 'welcome' ? 'affiliate_welcome' : 'affiliate_otp';

  await sendBatch(campaignId, [
    {
      phone: phone,
      text: text,
      source_system: sourceSystem,
      source_record_id: String(args.sourceRecordId || ''),
      czuid: args.ci != null ? String(args.ci) : null,
    },
  ]);

  try {
    const supabase = require('../clients/supabase');
    const { pollStatus } = require('../services/notifyme-client');
    const { data, error } = await supabase
      .from('sms_messages')
      .select('unique_id, status')
      .eq('campaign_id', campaignId)
      .eq('source_system', sourceSystem)
      .eq('source_record_id', String(args.sourceRecordId || ''))
      .order('created_at', { ascending: false })
      .limit(1);
    if (!error && data && data[0] && data[0].unique_id && String(data[0].status) !== 'DELIVERED') {
      await pollStatus([String(data[0].unique_id)]);
    }
  } catch (pollErr) {
    logger.error('affiliate transactional SMS status poll failed', {
      kind: args.kind || 'unknown',
      ci: args.ci,
      error: pollErr && pollErr.message ? pollErr.message : String(pollErr),
    });
  }

  return {
    ok: true,
    dry_run: false,
    provider: 'notifyme',
    queued: true,
  };
}

module.exports = {
  isAffiliateTxSmsDryRun,
  queueAffiliateTransactionalSms,
};
