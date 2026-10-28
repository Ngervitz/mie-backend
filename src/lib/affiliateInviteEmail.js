'use strict';

/**
 * Affiliate program invitation email — image-first HTML (no parallel send stack).
 * Uses existing {{var}} merge via renderTemplate (legacy purpose).
 */

const fs = require('fs');
const path = require('path');
const { applyTemplate } = require('../services/email-campaigns/renderTemplate');

const AFFILIATE_INVITE_EMAIL_SUBJECT = 'Ganá plata con Credizona';

const AFFILIATE_INVITE_HERO_FILENAME = 'affiliate-invite-hero-v1.jpg';

const DEFAULT_PUBLIC_BASE_URL = 'https://s.credizona.net';
const JOIN_PATH = '/affiliates/join';
const TERMS_PATH = '/affiliates/terms';
const EMAIL_ASSETS_PREFIX = '/email-assets/';

const TEMPLATE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'samples',
  'email-drafts',
  'affiliate-invite-v1.template.html',
);

const REQUIRED_TEMPLATE_VARS = Object.freeze([
  'join_url',
  'terms_url',
  'hero_image_url',
]);

let cachedTemplateBody = null;

function readPublicBaseUrl(raw) {
  const trimmed = raw == null ? '' : String(raw).trim();
  if (!trimmed) return DEFAULT_PUBLIC_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

/**
 * @param {string} [origin]
 */
function buildAffiliateTermsUrl(origin) {
  return readPublicBaseUrl(origin) + TERMS_PATH;
}

/**
 * Per-recipient invite link (OTP opt-in entry).
 * @param {string} inviteToken raw token from issueInviteToken (never log)
 * @param {string} [origin]
 */
function buildAffiliateJoinUrl(inviteToken, origin) {
  const base = readPublicBaseUrl(origin);
  const t = encodeURIComponent(String(inviteToken).trim());
  return base + JOIN_PATH + '?t=' + t;
}

/**
 * Stable HTTPS URL for the hero image (served from /email-assets).
 * @param {string} [origin]
 */
function buildAffiliateInviteHeroImageUrl(origin) {
  return (
    readPublicBaseUrl(origin) +
    EMAIL_ASSETS_PREFIX +
    AFFILIATE_INVITE_HERO_FILENAME
  );
}

function loadTemplateBody() {
  if (cachedTemplateBody) return cachedTemplateBody;
  cachedTemplateBody = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return cachedTemplateBody;
}

/**
 * @param {Record<string, string>} vars
 */
function validateAffiliateInviteTemplateVars(vars) {
  for (let i = 0; i < REQUIRED_TEMPLATE_VARS.length; i += 1) {
    const key = REQUIRED_TEMPLATE_VARS[i];
    if (!vars[key]) {
      return { ok: false, missing: key };
    }
  }
  return { ok: true };
}

/**
 * @param {{
 *   publicBaseUrl?: string|null,
 *   joinUrl: string,
 *   termsUrl?: string|null,
 *   heroImageUrl?: string|null,
 * }} input
 */
function buildAffiliateInviteEmailVars(input) {
  const base = readPublicBaseUrl(input.publicBaseUrl);
  return {
    join_url: String(input.joinUrl).trim(),
    terms_url: input.termsUrl
      ? String(input.termsUrl).trim()
      : buildAffiliateTermsUrl(base),
    hero_image_url: input.heroImageUrl
      ? String(input.heroImageUrl).trim()
      : buildAffiliateInviteHeroImageUrl(base),
  };
}

/**
 * @param {{
 *   publicBaseUrl?: string|null,
 *   joinUrl: string,
 *   termsUrl?: string|null,
 *   heroImageUrl?: string|null,
 * }} input
 * @returns {{ ok: true, subject: string, html: string }|{ ok: false, errorReason: string }}
 */
function renderAffiliateInviteEmail(input) {
  const vars = buildAffiliateInviteEmailVars(input);
  const check = validateAffiliateInviteTemplateVars(vars);
  if (!check.ok) {
    return {
      ok: false,
      errorReason: 'missing_required_template_var:' + check.missing,
    };
  }
  const body = loadTemplateBody();
  return {
    ok: true,
    subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
    html: applyTemplate(body, vars),
  };
}

module.exports = {
  AFFILIATE_INVITE_EMAIL_SUBJECT,
  AFFILIATE_INVITE_HERO_FILENAME,
  DEFAULT_PUBLIC_BASE_URL,
  JOIN_PATH,
  TERMS_PATH,
  TEMPLATE_PATH,
  REQUIRED_TEMPLATE_VARS,
  readPublicBaseUrl,
  buildAffiliateJoinUrl,
  buildAffiliateTermsUrl,
  buildAffiliateInviteHeroImageUrl,
  buildAffiliateInviteEmailVars,
  validateAffiliateInviteTemplateVars,
  renderAffiliateInviteEmail,
  loadTemplateBody,
};
