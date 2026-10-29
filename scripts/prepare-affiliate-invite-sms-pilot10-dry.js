'use strict';

/**
 * Dry-run simulation for affiliate SMS pilot 10 (no DB, no send).
 *
 * node scripts/prepare-affiliate-invite-sms-pilot10-dry.js
 */

const { buildAffiliateSmsPilot10DryPlans } = require('../src/lib/affiliateInviteSmsPilot10');

const plan = buildAffiliateSmsPilot10DryPlans({
  publicBaseUrl: 'https://s.credizona.net',
});

const output = {
  mode: plan.mode,
  campaign: plan.campaign,
  copy_template: plan.copy_template,
  gsm7: plan.gsm7,
  segments: plan.segments,
  fits_single_gsm7_segment: plan.fits_single_gsm7_segment,
  sample_sms_text: plan.sample_sms_text,
  recipients: plan.recipients.map(function (r) {
    return {
      ci: r.ci,
      idempotency_key: r.idempotency_key,
      join_url: r.join_url,
      short_url: r.short_url,
      sms_chars: r.sms_chars,
      sms_text: r.sms_text,
    };
  }),
};

console.log(JSON.stringify(output, null, 2));
