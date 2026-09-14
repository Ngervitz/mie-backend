'use strict';

/**
 * Frozen recipient payload.
 * Shared by materializers. No audience/eligibility rules.
 */

const { renderOutboundEmail } = require('./renderTemplate');
const { normalizeEmail } = require('./unsubscribeToken');

const ERROR_PAYLOAD_SNAPSHOT_INCOMPLETE = 'payload_snapshot_incomplete';
const ERROR_FROM_MISSING = 'EMAIL_CAMPAIGNS_FROM is not configured';

const SNAPSHOT_MARKER_FIELDS = [
  'template_subject_snapshot',
  'template_body_html_snapshot',
  'payload_to',
  'payload_from',
  'payload_subject',
  'payload_html',
];

const PAYLOAD_FIELDS = [
  'payload_to',
  'payload_from',
  'payload_subject',
  'payload_html',
];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasFrozenText(value) {
  return value != null && String(value).trim() !== '';
}

/**
 * A written snapshot column (including empty string) means the row was
 * created under the snapshot contract. NULL means the column was never set.
 * provider_send_started_at is intentionally ignored.
 *
 * @param {object|null|undefined} recipient
 * @returns {'legacy'|'snapshot'}
 */
function classifyRecipientPayload(recipient) {
  if (!recipient || typeof recipient !== 'object') return 'legacy';
  for (let i = 0; i < SNAPSHOT_MARKER_FIELDS.length; i += 1) {
    if (recipient[SNAPSHOT_MARKER_FIELDS[i]] != null) return 'snapshot';
  }
  return 'legacy';
}

/**
 * @param {object} recipient
 * @returns {boolean}
 */
function isSnapshotPayloadComplete(recipient) {
  for (let i = 0; i < PAYLOAD_FIELDS.length; i += 1) {
    if (!hasFrozenText(recipient && recipient[PAYLOAD_FIELDS[i]])) return false;
  }
  return true;
}

/**
 * @returns {string}
 */
function readCampaignsFrom() {
  return String(process.env.EMAIL_CAMPAIGNS_FROM || '').trim();
}

/**
 * Abort materialize before any recipient insert when From is missing.
 * @returns {string}
 */
function requireCampaignsFrom() {
  const from = readCampaignsFrom();
  if (!from) {
    const err = new Error(ERROR_FROM_MISSING);
    err.code = 'EMAIL_CAMPAIGNS_FROM_MISSING';
    throw err;
  }
  return from;
}

/**
 * @param {{
 *   to: unknown,
 *   from: unknown,
 *   subject: unknown,
 *   bodyHtml: unknown,
 *   templateVars?: unknown,
 *   purpose?: string|null,
 * }} input
 */
function buildRecipientPayloadSnapshot(input) {
  const to = normalizeEmail(input && input.to);
  const from = input && input.from != null ? String(input.from).trim() : '';
  const sourceSubject =
    input && input.subject != null ? String(input.subject).trim() : '';
  const sourceHtml =
    input && input.bodyHtml != null ? String(input.bodyHtml).trim() : '';
  const templateVars =
    input && input.templateVars && typeof input.templateVars === 'object'
      ? input.templateVars
      : {};

  if (!to) {
    throw new Error('payload snapshot: to is required');
  }
  if (!from) {
    const err = new Error(ERROR_FROM_MISSING);
    err.code = 'EMAIL_CAMPAIGNS_FROM_MISSING';
    throw err;
  }
  if (!sourceSubject) {
    throw new Error('payload snapshot: subject is required');
  }
  if (!sourceHtml) {
    throw new Error('payload snapshot: body_html is required');
  }

  const rendered = renderOutboundEmail({
    purpose: input && input.purpose != null ? input.purpose : null,
    subject: sourceSubject,
    bodyHtml: sourceHtml,
    templateVars: templateVars,
  });
  if (!rendered.ok) {
    const err = new Error(rendered.errorReason || 'payload snapshot render failed');
    err.code = 'TEMPLATE_RENDER';
    err.errorReason = rendered.errorReason;
    throw err;
  }

  const payloadSubject = String(rendered.subject || '').trim();
  const payloadHtml = String(rendered.html || '').trim();
  if (!payloadSubject || !payloadHtml) {
    throw new Error('payload snapshot: rendered content is empty');
  }

  return {
    email: to,
    payload_to: to,
    payload_from: from,
    payload_subject: payloadSubject,
    payload_html: payloadHtml,
    template_subject_snapshot: sourceSubject,
    template_body_html_snapshot: sourceHtml,
    template_vars: templateVars,
  };
}

module.exports = {
  ERROR_PAYLOAD_SNAPSHOT_INCOMPLETE,
  ERROR_FROM_MISSING,
  SNAPSHOT_MARKER_FIELDS,
  PAYLOAD_FIELDS,
  classifyRecipientPayload,
  isSnapshotPayloadComplete,
  readCampaignsFrom,
  requireCampaignsFrom,
  buildRecipientPayloadSnapshot,
};
