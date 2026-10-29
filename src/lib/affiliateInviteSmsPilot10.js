'use strict';

/**
 * Affiliate program SMS invite pilot 10 — dry-run planning only (no tokens, no Notifyme).
 */

const { buildAffiliateJoinUrl } = require('./affiliateInviteEmail');
const { composePublicShortUrl, SHORT_CODE_LENGTH } = require('./smsTinyUrl');
const {
  SMS_PURPOSES,
  SMS_DEFAULT_VERTICAL,
} = require('./smsCampaignClassification');

/** Fixed order — do not reorder. */
const AFFILIATE_SMS_PILOT10_CIS = Object.freeze([
  55597953, 49825508, 18526448, 50479964, 39236232, 49658210, 51001152,
  46225735, 30901272, 46143731,
]);

const PILOT10_SMS_TEMPLATE =
  'Credizona: gana $500 por cada prestamo otorgado a quien recomiendes. Sumate: {{short_url}}';

const DRY_RUN_TOKEN_PREFIX = 'DRY_RUN_INVITE_TOKEN_';

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

function dryRunInviteTokenForCi(ci) {
  return DRY_RUN_TOKEN_PREFIX + String(ci);
}

function sampleShortUrl(publicBase) {
  const base =
    publicBase != null && String(publicBase).trim()
      ? String(publicBase).trim().replace(/\/+$/, '')
      : 'https://s.credizona.net';
  const code = 'A'.repeat(SHORT_CODE_LENGTH);
  return composePublicShortUrl(code).replace(
    /^https?:\/\/[^/]+/,
    base.replace(/\/+$/, ''),
  );
}

function renderPilot10SmsText(shortUrl) {
  return PILOT10_SMS_TEMPLATE.replace('{{short_url}}', String(shortUrl).trim());
}

function gsm7Septets(text) {
  const basic = new Set(GSM7_BASIC.split(''));
  const ext = new Set(GSM7_EXT.split(''));
  let units = 0;
  for (const ch of String(text)) {
    if (basic.has(ch)) units += 1;
    else if (ext.has(ch)) units += 2;
    else return { encoding: 'UCS-2', septets: null, invalid_char: ch };
  }
  return { encoding: 'GSM-7', septets: units, invalid_char: null };
}

function smsSegmentsGsm7(septets) {
  if (septets == null) return null;
  if (septets <= 160) return 1;
  return Math.ceil(septets / 153);
}

/**
 * Build per-recipient plan rows for tracking prep (dry-run tokens only).
 *
 * @param {{
 *   publicBaseUrl?: string,
 *   shortUrlForCi?: function(number): string,
 * }} [opts]
 */
function buildAffiliateSmsPilot10DryPlans(opts) {
  const o = opts || {};
  const publicBase = o.publicBaseUrl || 'https://s.credizona.net';
  const shortForCi =
    typeof o.shortUrlForCi === 'function'
      ? o.shortUrlForCi
      : function () {
          return sampleShortUrl(publicBase);
        };

  const sampleShort = shortForCi(AFFILIATE_SMS_PILOT10_CIS[0]);
  const sampleText = renderPilot10SmsText(sampleShort);
  const gsm = gsm7Septets(sampleText);

  const recipients = AFFILIATE_SMS_PILOT10_CIS.map(function (ci) {
    const token = dryRunInviteTokenForCi(ci);
    const joinUrl = buildAffiliateJoinUrl(token);
    const shortUrl = shortForCi(ci);
    const text = renderPilot10SmsText(shortUrl);
    return {
      ci: ci,
      phone: null,
      dry_run_invite_token: token,
      join_url: joinUrl,
      short_url: shortUrl,
      sms_text: text,
      sms_chars: text.length,
      destination_url: joinUrl,
      source_system: 'affiliate_invite_sms',
      source_record_id: 'dry-run-invite-' + String(ci),
      idempotency_key: 'affiliate-sms-pilot10:' + String(ci),
    };
  });

  return {
    ok: true,
    mode: 'dry-run',
    campaign: {
      name: 'PILOT affiliate SMS invite 10-recipient (join tokens)',
      vertical: 'affiliates',
      purpose: SMS_PURPOSES.AFFILIATE_PROGRAM_INVITE,
      vertical_default: SMS_DEFAULT_VERTICAL,
    },
    copy_template: PILOT10_SMS_TEMPLATE,
    sample_short_url: sampleShort,
    sample_sms_text: sampleText,
    gsm7: gsm,
    segments: smsSegmentsGsm7(gsm.septets),
    fits_single_gsm7_segment:
      gsm.encoding === 'GSM-7' && gsm.septets != null && gsm.septets <= 160,
    recipients: recipients,
    tokens_minted: 0,
    sms_sent: 0,
  };
}

module.exports = {
  AFFILIATE_SMS_PILOT10_CIS,
  PILOT10_SMS_TEMPLATE,
  DRY_RUN_TOKEN_PREFIX,
  dryRunInviteTokenForCi,
  sampleShortUrl,
  renderPilot10SmsText,
  gsm7Septets,
  smsSegmentsGsm7,
  buildAffiliateSmsPilot10DryPlans,
};
