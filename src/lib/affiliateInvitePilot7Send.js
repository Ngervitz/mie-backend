'use strict';

/**
 * Controlled affiliate invite email for the 7-recipient pilot (new_join only).
 * Same template/subject as Nelson pilot. Per-recipient join tokens at send time.
 */

const {
  AFFILIATE_INVITE_EMAIL_SUBJECT,
  buildAffiliateJoinUrl,
  buildAffiliateTermsUrl,
  buildAffiliateInviteHeroImageUrl,
  renderAffiliateInviteEmail,
} = require('./affiliateInviteEmail');
const { NELSON_JOIN_TOKEN_PLACEHOLDER } = require('./affiliateInviteControlledSend');
const { PILOT7_RECIPIENTS } = require('./affiliateInvitePilot7Roster');

const JOIN_TOKEN_PLACEHOLDER = NELSON_JOIN_TOKEN_PLACEHOLDER;

/**
 * @param {string} key
 * @param {Map<string, string>|Record<string, string>|null} joinTokensByKey
 * @param {{ publicBaseUrl?: string|null }} [opts]
 */
function resolveJoinTokenForKey(key, joinTokensByKey, opts) {
  let token = null;
  if (joinTokensByKey) {
    if (joinTokensByKey instanceof Map) {
      token = joinTokensByKey.get(key);
    } else if (typeof joinTokensByKey === 'object') {
      token = joinTokensByKey[key];
    }
  }
  if (token != null && String(token).trim() !== '') {
    return String(token).trim();
  }
  return JOIN_TOKEN_PLACEHOLDER;
}

function findRecipient(key) {
  for (let i = 0; i < PILOT7_RECIPIENTS.length; i += 1) {
    if (PILOT7_RECIPIENTS[i].key === key) return PILOT7_RECIPIENTS[i];
  }
  return null;
}

/**
 * @param {string} key
 * @param {{
 *   publicBaseUrl?: string|null,
 *   joinTokensByKey?: Map<string, string>|Record<string, string>|null,
 * }} [opts]
 */
function buildPilot7InviteEmail(key, opts) {
  const meta = findRecipient(key);
  if (!meta) {
    return { ok: false, errorReason: 'unknown_pilot7_recipient' };
  }
  const token = resolveJoinTokenForKey(key, opts && opts.joinTokensByKey, opts);
  const clickUrl = buildAffiliateJoinUrl(token, opts && opts.publicBaseUrl);
  const rendered = renderAffiliateInviteEmail({
    publicBaseUrl: opts && opts.publicBaseUrl,
    joinUrl: clickUrl,
    termsUrl: buildAffiliateTermsUrl(opts && opts.publicBaseUrl),
    heroImageUrl: buildAffiliateInviteHeroImageUrl(opts && opts.publicBaseUrl),
  });
  if (!rendered.ok) return rendered;

  return {
    ok: true,
    key: meta.key,
    email: meta.email,
    ci: meta.ci,
    cohort: meta.cohort,
    kind: 'new_join',
    click_url: clickUrl,
    subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
    html: rendered.html,
    terms_public_url: buildAffiliateTermsUrl(opts && opts.publicBaseUrl),
    hero_image_url: buildAffiliateInviteHeroImageUrl(opts && opts.publicBaseUrl),
    join_token_pending: token === JOIN_TOKEN_PLACEHOLDER,
  };
}

/**
 * @param {{
 *   from: string,
 *   publicBaseUrl?: string|null,
 *   joinTokensByKey?: Map<string, string>|Record<string, string>|null,
 * }} input
 */
function buildPilot7PayloadSnapshots(input) {
  const { buildRecipientPayloadSnapshot } = require('../services/email-campaigns/payloadSnapshot');
  const from = input && input.from != null ? String(input.from).trim() : '';
  if (!from) {
    return { ok: false, errorReason: 'EMAIL_CAMPAIGNS_FROM_MISSING' };
  }

  const rows = [];
  for (let i = 0; i < PILOT7_RECIPIENTS.length; i += 1) {
    const key = PILOT7_RECIPIENTS[i].key;
    const mail = buildPilot7InviteEmail(key, input);
    if (!mail.ok) {
      return { ok: false, errorReason: mail.errorReason || 'render_failed', key: key };
    }
    let snap;
    try {
      snap = buildRecipientPayloadSnapshot({
        to: mail.email,
        from: from,
        subject: mail.subject,
        bodyHtml: mail.html,
        purpose: null,
        template_vars: {},
      });
    } catch (err) {
      return {
        ok: false,
        errorReason: err && err.message ? String(err.message) : 'snapshot_failed',
        key: key,
      };
    }
    rows.push({
      key: key,
      email: mail.email,
      ci: mail.ci,
      cohort: mail.cohort,
      kind: mail.kind,
      click_url: mail.click_url,
      join_token_pending: mail.join_token_pending === true,
      snapshot: snap,
    });
  }

  return { ok: true, rows: rows };
}

function buildPilot7Manifest(opts) {
  const out = [];
  for (let i = 0; i < PILOT7_RECIPIENTS.length; i += 1) {
    const key = PILOT7_RECIPIENTS[i].key;
    const mail = buildPilot7InviteEmail(key, opts);
    if (!mail.ok) {
      return { ok: false, errorReason: mail.errorReason, key: key };
    }
    out.push({
      key: mail.key,
      email: mail.email,
      ci: mail.ci,
      cohort: mail.cohort,
      kind: mail.kind,
      subject: mail.subject,
      click_url: mail.join_token_pending
        ? buildAffiliateJoinUrl(JOIN_TOKEN_PLACEHOLDER, opts && opts.publicBaseUrl)
        : mail.click_url,
      join_token_pending: mail.join_token_pending === true,
      terms_url: mail.terms_public_url,
      hero_image_url: mail.hero_image_url,
      html_bytes: Buffer.byteLength(mail.html, 'utf8'),
    });
  }
  return { ok: true, recipients: out, subject: AFFILIATE_INVITE_EMAIL_SUBJECT };
}

module.exports = {
  JOIN_TOKEN_PLACEHOLDER,
  PILOT7_RECIPIENTS,
  buildPilot7InviteEmail,
  buildPilot7PayloadSnapshots,
  buildPilot7Manifest,
};
