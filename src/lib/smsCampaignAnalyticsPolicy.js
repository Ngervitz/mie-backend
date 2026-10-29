'use strict';

const { SMS_PURPOSES } = require('./smsCampaignClassification');
const { isAffiliateOtpCampaignId, isHistoricalTestCampaignId } = require('./smsCampaignHistoricalRegistry');

function isSmsTransactionalPurpose(purpose) {
  const p = purpose == null ? '' : String(purpose).trim().toLowerCase();
  return (
    p === SMS_PURPOSES.TRANSACTIONAL ||
    p === 'affiliate_otp' ||
    p === SMS_PURPOSES.AFFILIATE_OTP
  );
}

function isSmsTestPurpose(purpose) {
  const p = purpose == null ? '' : String(purpose).trim().toLowerCase();
  return p === SMS_PURPOSES.TEST || p === 'test';
}

function isSmsCommercialPerformancePurpose(purpose) {
  return !isSmsTransactionalPurpose(purpose) && !isSmsTestPurpose(purpose);
}

function isSmsCommercialPerformanceCampaign(campaignRow) {
  if (!campaignRow) return true;
  if (isAffiliateOtpCampaignId(campaignRow.id)) return false;
  if (isHistoricalTestCampaignId(campaignRow.id)) return false;
  return isSmsCommercialPerformancePurpose(campaignRow.purpose);
}

module.exports = {
  isSmsTransactionalPurpose,
  isSmsTestPurpose,
  isSmsCommercialPerformancePurpose,
  isSmsCommercialPerformanceCampaign,
};
