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

/** Must appear in template/rendered HTML (UTF-8 Spanish, not Latin-1 mojibake). */
const AFFILIATE_INVITE_REQUIRED_SPANISH = Object.freeze([
  'Invitación al programa de afiliados',
  'participá acá en el programa de afiliados',
  'préstamos',
  'según los',
  'términos y condiciones',
  'recomendá',
  'ganá',
  'Tocá para participar',
]);

/** Typical UTF-8→Latin-1 mis-read markers (e.g. PowerShell Out-File on git show output). */
const AFFILIATE_INVITE_MOJIBAKE_MARKERS = Object.freeze([
  'particip├í',
  'pr├®stamos',
  'Invitaci├│n',
  't├®rminos',
  'seg├║n',
  'recomend├í',
  'gan├í',
  'Toc├í para participar',
  'ac├í',
]);

let cachedTemplateBody = null;

/**
 * Fail closed if invite HTML/subject lost UTF-8 Spanish accents (mojibake).
 *
 * @param {string} text
 * @returns {{ ok: true }|{ ok: false, reason: string }}
 */
function validateAffiliateInviteSpanishUtf8(text) {
  const s = String(text == null ? '' : text);
  for (let i = 0; i < AFFILIATE_INVITE_MOJIBAKE_MARKERS.length; i += 1) {
    const bad = AFFILIATE_INVITE_MOJIBAKE_MARKERS[i];
    if (s.indexOf(bad) !== -1) {
      return { ok: false, reason: 'mojibake_marker:' + bad };
    }
  }
  if (/├/.test(s)) {
    return { ok: false, reason: 'mojibake_box_drawing_char' };
  }
  if (/Ã[¡©­³º]/.test(s)) {
    return { ok: false, reason: 'latin1_mojibake_sequence' };
  }
  for (let j = 0; j < AFFILIATE_INVITE_REQUIRED_SPANISH.length; j += 1) {
    const req = AFFILIATE_INVITE_REQUIRED_SPANISH[j];
    if (s.indexOf(req) === -1) {
      return { ok: false, reason: 'missing_spanish_utf8:' + req };
    }
  }
  return { ok: true };
}

function validateAffiliateInviteSubjectUtf8() {
  const subj = AFFILIATE_INVITE_EMAIL_SUBJECT;
  if (subj.indexOf('Ganá') === -1) {
    return { ok: false, reason: 'subject_missing_accent' };
  }
  if (/├/.test(subj) || subj.indexOf('GanÃ') !== -1) {
    return { ok: false, reason: 'subject_mojibake' };
  }
  return { ok: true };
}

function assertAffiliateInviteSpanishUtf8(text, context) {
  const check = validateAffiliateInviteSpanishUtf8(text);
  if (!check.ok) {
    throw new Error(
      'affiliate_invite_template_invalid:' +
        (context ? context + ':' : '') +
        check.reason,
    );
  }
}

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
  assertAffiliateInviteSpanishUtf8(cachedTemplateBody, 'template_file');
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
  const subjectCheck = validateAffiliateInviteSubjectUtf8();
  if (!subjectCheck.ok) {
    return { ok: false, errorReason: subjectCheck.reason };
  }

  const vars = buildAffiliateInviteEmailVars(input);
  const check = validateAffiliateInviteTemplateVars(vars);
  if (!check.ok) {
    return {
      ok: false,
      errorReason: 'missing_required_template_var:' + check.missing,
    };
  }
  const body = loadTemplateBody();
  const html = applyTemplate(body, vars);
  const utf8Check = validateAffiliateInviteSpanishUtf8(html);
  if (!utf8Check.ok) {
    return { ok: false, errorReason: utf8Check.reason };
  }
  return {
    ok: true,
    subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
    html: html,
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
  validateAffiliateInviteSpanishUtf8,
  validateAffiliateInviteSubjectUtf8,
  AFFILIATE_INVITE_REQUIRED_SPANISH,
  renderAffiliateInviteEmail,
  loadTemplateBody,
};
