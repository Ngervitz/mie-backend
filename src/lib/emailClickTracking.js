'use strict';

/**
 * Email survey-invite click tracking helpers (freeze-time PUBLIC URL + RPC wrapper).
 * Does not send email. Does not touch SMS short links.
 */

const { resolveEmailPublicBaseUrl } = require('../services/email-campaigns/unsubscribeToken');

const RPC_NAME = 'upsert_email_survey_invite_recipient_impact';
const TRACKING_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Public tracked URL for email survey CTA.
 * @param {string} trackingToken
 * @param {string} [publicBaseUrl]
 * @returns {string}
 */
function buildEmailClickTrackedUrl(trackingToken, publicBaseUrl) {
  const token = String(trackingToken || '').trim();
  if (!TRACKING_TOKEN_RE.test(token)) {
    throw new Error('invalid tracking_token for email click URL');
  }
  const base =
    publicBaseUrl != null && String(publicBaseUrl).trim()
      ? String(publicBaseUrl).trim().replace(/\/+$/, '')
      : resolveEmailPublicBaseUrl();
  if (!base) {
    throw new Error('EMAIL_PUBLIC_BASE_URL is not configured');
  }
  return base + '/email/c/' + encodeURIComponent(token);
}

/**
 * Append or replace jt on an absolute destination URL.
 * @param {string} destinationUrl
 * @param {string} trackingToken
 * @returns {string}
 */
function appendJtToDestination(destinationUrl, trackingToken) {
  const url = new URL(String(destinationUrl).trim());
  url.searchParams.set('jt', String(trackingToken));
  return url.toString();
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   idempotencyKey: string,
 *   campaignId: string|number,
 *   ci: string|number,
 *   email: string,
 *   purpose: string,
 *   destinationUrl: string,
 * }} input
 */
async function upsertEmailSurveyInviteRecipientImpact(supabase, input) {
  const { data, error } = await supabase.rpc(RPC_NAME, {
    p_idempotency_key: String(input.idempotencyKey),
    p_campaign_id: Number(input.campaignId),
    p_ci: input.ci == null ? null : String(input.ci),
    p_email: String(input.email),
    p_purpose: String(input.purpose),
    p_destination_url: String(input.destinationUrl),
  });
  if (error) {
    const err = new Error(
      'upsert_email_survey_invite_recipient_impact failed: ' + error.message,
    );
    err.code = error.code || 'RPC_FAILED';
    err.cause = error;
    throw err;
  }
  if (!data || typeof data !== 'object') {
    throw new Error('upsert_email_survey_invite_recipient_impact returned empty');
  }
  const token = data.tracking_token != null ? String(data.tracking_token) : '';
  if (!TRACKING_TOKEN_RE.test(token)) {
    throw new Error('RPC returned invalid tracking_token');
  }
  if (data.recipient_id == null || data.impact_id == null) {
    throw new Error('RPC returned incomplete recipient/impact ids');
  }
  return {
    created: Boolean(data.created),
    recipient_id: data.recipient_id,
    impact_id: String(data.impact_id),
    tracking_token: token,
    destination_url: data.destination_url != null ? String(data.destination_url) : null,
    campaign_id: data.campaign_id,
    idempotency_key: data.idempotency_key != null ? String(data.idempotency_key) : null,
    status: data.status != null ? String(data.status) : null,
    provider_send_started_at:
      data.provider_send_started_at != null
        ? String(data.provider_send_started_at)
        : null,
  };
}

module.exports = {
  RPC_NAME,
  TRACKING_TOKEN_RE,
  buildEmailClickTrackedUrl,
  appendJtToDestination,
  upsertEmailSurveyInviteRecipientImpact,
};
