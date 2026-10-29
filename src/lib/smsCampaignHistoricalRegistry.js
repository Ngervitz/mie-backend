'use strict';

/**
 * Explicit sms_campaigns.id registry for historical backfill.
 * OTP / transactional / test buckets are identified ONLY by id — never name or URL.
 */

const { SMS_DEFAULT_VERTICAL, SMS_DEFAULT_PURPOSE, SMS_PURPOSES } = require('./smsCampaignClassification');

/**
 * Affiliate OTP + welcome Notifyme bucket(s). Verified in prod audit 2026-10-29.
 */
const SMS_AFFILIATE_OTP_CAMPAIGN_IDS = Object.freeze([
  '62894481-1b47-4f73-b8c0-f9515d3bb943',
  'd0446992-7dd9-428a-a052-f7091a184b02',
]);

/** Engine / internal SMS test campaigns (loans vertical, purpose=test). */
const SMS_HISTORICAL_TEST_CAMPAIGN_IDS = Object.freeze([
  'ee3285f6-40f6-4866-b208-63a37cf33696',
  'ecc608f1-8297-436f-9278-4ecd9029d2e2',
  '3501584d-5e66-4e23-90dc-52e138284476',
  '9efe67e6-e557-4529-8cbf-e4fae030c534',
  'ad31c33a-f4d9-42de-ada3-0e5144bf5b11',
  'a803c8d7-a1ee-4df3-8d8f-7f5f22ad48f2',
  '9912a496-189a-4481-88e5-453cc826205a',
  '22aaedf3-d9a4-427b-8519-ac78e5145e0b',
  'd2b7f687-ee5e-4f26-b91a-78f26497d71c',
  'd6cec290-a343-4fed-9ee1-d9825b34fc53',
  'a5651b31-11a7-4814-85d9-db37c3418da2',
  'b024cd01-3cb2-4e54-8e75-3c7f168c2e5b',
]);

/**
 * Non-default classifications for specific campaign ids (exceptions to loans default).
 * OTP ids are handled via SMS_AFFILIATE_OTP_CAMPAIGN_IDS.
 */
const SMS_HISTORICAL_CLASSIFICATION_EXCEPTIONS = Object.freeze({});

const SMS_AFFILIATE_OTP_CAMPAIGN_ID_SET = new Set(
  SMS_AFFILIATE_OTP_CAMPAIGN_IDS.map(function (id) {
    return String(id).trim().toLowerCase();
  }),
);

const SMS_HISTORICAL_TEST_CAMPAIGN_ID_SET = new Set(
  SMS_HISTORICAL_TEST_CAMPAIGN_IDS.map(function (id) {
    return String(id).trim().toLowerCase();
  }),
);

function normalizeCampaignId(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
}

function affiliateOtpIdsIncludingEnv() {
  const ids = SMS_AFFILIATE_OTP_CAMPAIGN_IDS.slice();
  const fromEnv =
    process.env.AFFILIATE_TX_SMS_CAMPAIGN_ID != null
      ? String(process.env.AFFILIATE_TX_SMS_CAMPAIGN_ID).trim()
      : '';
  if (fromEnv && ids.indexOf(fromEnv) === -1) {
    ids.push(fromEnv);
  }
  return ids;
}

function affiliateOtpIdSetIncludingEnv() {
  return new Set(
    affiliateOtpIdsIncludingEnv().map(function (id) {
      return normalizeCampaignId(id);
    }),
  );
}

function isHistoricalTestCampaignId(campaignId) {
  return SMS_HISTORICAL_TEST_CAMPAIGN_ID_SET.has(normalizeCampaignId(campaignId));
}

/**
 * @param {string} campaignId
 * @returns {{ vertical: string, purpose: string, source: string }}
 */
function resolveHistoricalSmsCampaignClassification(campaignId) {
  const id = normalizeCampaignId(campaignId);
  if (!id) {
    return {
      vertical: SMS_DEFAULT_VERTICAL,
      purpose: SMS_DEFAULT_PURPOSE,
      source: 'default',
    };
  }

  if (affiliateOtpIdSetIncludingEnv().has(id) || SMS_AFFILIATE_OTP_CAMPAIGN_ID_SET.has(id)) {
    return {
      vertical: 'affiliates',
      purpose: SMS_PURPOSES.TRANSACTIONAL,
      source: 'otp_campaign_id_registry',
    };
  }

  if (SMS_HISTORICAL_TEST_CAMPAIGN_ID_SET.has(id)) {
    return {
      vertical: SMS_DEFAULT_VERTICAL,
      purpose: SMS_PURPOSES.TEST,
      source: 'test_campaign_id_registry',
    };
  }

  const exc = SMS_HISTORICAL_CLASSIFICATION_EXCEPTIONS[id];
  if (exc && exc.vertical && exc.purpose) {
    return {
      vertical: String(exc.vertical),
      purpose: String(exc.purpose),
      source: 'explicit_exception',
    };
  }

  return {
    vertical: SMS_DEFAULT_VERTICAL,
    purpose: SMS_DEFAULT_PURPOSE,
    source: 'default_loans',
  };
}

/**
 * Build audit rows for a list of campaigns from DB (read-only helper).
 * @param {Array<{ id: string, name?: string, created_at?: string }>} campaigns
 */
function buildHistoricalClassificationAudit(campaigns) {
  const rows = (campaigns || []).map(function (c) {
    const classif = resolveHistoricalSmsCampaignClassification(c && c.id);
    return {
      campaign_id: c && c.id != null ? String(c.id) : null,
      name: c && c.name != null ? String(c.name) : null,
      created_at: c && c.created_at != null ? c.created_at : null,
      proposed_vertical: classif.vertical,
      proposed_purpose: classif.purpose,
      classification_source: classif.source,
    };
  });
  rows.sort(function (a, b) {
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  return {
    otp_campaign_ids_registry: affiliateOtpIdsIncludingEnv(),
    test_campaign_ids_registry: SMS_HISTORICAL_TEST_CAMPAIGN_IDS.slice(),
    exception_ids: Object.keys(SMS_HISTORICAL_CLASSIFICATION_EXCEPTIONS),
    campaigns: rows,
  };
}

function isAffiliateOtpCampaignId(campaignId) {
  const id = normalizeCampaignId(campaignId);
  return affiliateOtpIdSetIncludingEnv().has(id) || SMS_AFFILIATE_OTP_CAMPAIGN_ID_SET.has(id);
}

module.exports = {
  SMS_AFFILIATE_OTP_CAMPAIGN_IDS,
  SMS_HISTORICAL_TEST_CAMPAIGN_IDS,
  SMS_HISTORICAL_CLASSIFICATION_EXCEPTIONS,
  affiliateOtpIdsIncludingEnv,
  resolveHistoricalSmsCampaignClassification,
  buildHistoricalClassificationAudit,
  isAffiliateOtpCampaignId,
  isHistoricalTestCampaignId,
};
