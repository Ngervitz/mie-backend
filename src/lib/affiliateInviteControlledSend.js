'use strict';

/**
 * Controlled affiliate invite email for the two-recipient pilot.
 * Uses JANUS email payload snapshots (same stack as campaigns). No send I/O here.
 */

const { buildReferralUrl, readReferralOrigin } = require('./affiliateJoinContract');
const {
  AFFILIATE_INVITE_EMAIL_SUBJECT,
  buildAffiliateJoinUrl,
  buildAffiliateTermsUrl,
  buildAffiliateInviteHeroImageUrl,
  renderAffiliateInviteEmail,
} = require('./affiliateInviteEmail');

/** Inserted at send time via issueInviteToken — never log real tokens in manifests. */
const NELSON_JOIN_TOKEN_PLACEHOLDER = '__ISSUE_INVITE_TOKEN_AT_SEND__';

const PILOT_NELSON = Object.freeze({
  key: 'nelson',
  email: 'nelson.russo74@gmail.com',
  ci: 19118189,
  kind: 'new_join',
});

const PILOT_NICO = Object.freeze({
  key: 'nico',
  email: 'nico@copanel.uy',
  ci: 25167491,
  kind: 'existing_referral',
  referral_code: '6SNY5C3NR5',
});

const CONTROLLED_PILOT_RECIPIENTS = Object.freeze([PILOT_NELSON, PILOT_NICO]);

/**
 * @param {'nelson'|'nico'} key
 * @param {{
 *   publicBaseUrl?: string|null,
 *   nelsonJoinToken?: string|null,
 *   referralOrigin?: string|null,
 * }} [opts]
 */
function resolvePilotClickUrl(key, opts) {
  const o = opts || {};
  const base = o.publicBaseUrl;
  const origin = readReferralOrigin(o.referralOrigin);

  if (key === PILOT_NELSON.key) {
    const token =
      o.nelsonJoinToken != null && String(o.nelsonJoinToken).trim() !== ''
        ? String(o.nelsonJoinToken).trim()
        : NELSON_JOIN_TOKEN_PLACEHOLDER;
    return buildAffiliateJoinUrl(token, base || origin);
  }
  if (key === PILOT_NICO.key) {
    return buildReferralUrl(PILOT_NICO.referral_code, origin);
  }
  throw new Error('unknown_pilot_recipient:' + String(key));
}

/**
 * @param {'nelson'|'nico'} key
 * @param {{
 *   publicBaseUrl?: string|null,
 *   nelsonJoinToken?: string|null,
 *   referralOrigin?: string|null,
 * }} [opts]
 */
function buildPilotInviteEmail(key, opts) {
  const meta =
    key === PILOT_NELSON.key
      ? PILOT_NELSON
      : key === PILOT_NICO.key
        ? PILOT_NICO
        : null;
  if (!meta) {
    return { ok: false, errorReason: 'unknown_pilot_recipient' };
  }

  const clickUrl = resolvePilotClickUrl(key, opts);
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
    kind: meta.kind,
    click_url: clickUrl,
    subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
    html: rendered.html,
    terms_public_url: buildAffiliateTermsUrl(opts && opts.publicBaseUrl),
    hero_image_url: buildAffiliateInviteHeroImageUrl(opts && opts.publicBaseUrl),
    join_token_pending:
      key === PILOT_NELSON.key &&
      (!opts ||
        opts.nelsonJoinToken == null ||
        String(opts.nelsonJoinToken).trim() === ''),
  };
}

/**
 * Build frozen provider payload rows (no DB). Requires fromAddr (EMAIL_CAMPAIGNS_FROM).
 *
 * @param {{
 *   from: string,
 *   publicBaseUrl?: string|null,
 *   nelsonJoinToken?: string|null,
 *   referralOrigin?: string|null,
 * }} input
 */
function buildControlledPilotPayloadSnapshots(input) {
  const { buildRecipientPayloadSnapshot } = require('../services/email-campaigns/payloadSnapshot');
  const from = input && input.from != null ? String(input.from).trim() : '';
  if (!from) {
    return { ok: false, errorReason: 'EMAIL_CAMPAIGNS_FROM_MISSING' };
  }

  const rows = [];
  for (let i = 0; i < CONTROLLED_PILOT_RECIPIENTS.length; i += 1) {
    const key = CONTROLLED_PILOT_RECIPIENTS[i].key;
    const mail = buildPilotInviteEmail(key, input);
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
        templateVars: {},
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
      kind: mail.kind,
      click_url: mail.click_url,
      join_token_pending: mail.join_token_pending === true,
      snapshot: snap,
    });
  }

  return { ok: true, rows: rows };
}

/**
 * Safe manifest for operators (no raw invite tokens).
 */
function buildControlledPilotManifest(opts) {
  const out = [];
  for (let i = 0; i < CONTROLLED_PILOT_RECIPIENTS.length; i += 1) {
    const key = CONTROLLED_PILOT_RECIPIENTS[i].key;
    const mail = buildPilotInviteEmail(key, opts);
    if (!mail.ok) {
      return { ok: false, errorReason: mail.errorReason, key: key };
    }
    out.push({
      key: mail.key,
      email: mail.email,
      ci: mail.ci,
      kind: mail.kind,
      subject: mail.subject,
      click_url: mail.join_token_pending
        ? buildAffiliateJoinUrl(NELSON_JOIN_TOKEN_PLACEHOLDER, opts && opts.publicBaseUrl)
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
  NELSON_JOIN_TOKEN_PLACEHOLDER,
  PILOT_NELSON,
  PILOT_NICO,
  CONTROLLED_PILOT_RECIPIENTS,
  resolvePilotClickUrl,
  buildPilotInviteEmail,
  buildControlledPilotPayloadSnapshots,
  buildControlledPilotManifest,
};
