'use strict';

/**
 * Stage 5 — read paths for BCU extraction drafts (summary / detail / private file proxy).
 * Reuses Stage 3 reuseFlags semantics. Never exposes storage_path to clients.
 */

const { MIME_TO_EXT, downloadRejectedBcuFile } = require('./rejectedBcuStorage');
const { ACTIVE_DEDUP_STATUSES } = require('./bcuExtractTiming');
const { reuseFlags } = require('./rejectedBcuExtractDraft');

const DRAFT_TABLE = 'rejected_bcu_extraction_drafts';

/** Same active set as Stage 3 soft-dedup (excludes confirmed/abandoned/expired). */
const ACTIVE_DRAFT_STATUSES = ACTIVE_DEDUP_STATUSES;

/** Detail/file readable statuses (confirmed allowed by explicit id). */
const DETAIL_READABLE_STATUSES = Object.freeze([
  'extracting',
  'extraction_failed',
  'pending_review',
  'confirmed',
]);

const DRAFT_READ_SELECT =
  'id, ci, status, storage_path, original_filename, content_type, file_size_bytes, file_sha256, extraction_json, validation_json, extraction_contract_version, currency_view_selected, document_ci_raw, confirmed_snapshot_id, created_by, created_at, updated_at, expires_at, abandoned_at, confirmed_at, purge_after, attempt_id, lease_expires_at';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_CONTENT_TYPES = Object.freeze(Object.keys(MIME_TO_EXT));

function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function assertDraftId(raw) {
  if (!raw || !UUID_RE.test(String(raw))) {
    throw httpError(400, 'draft inválido', 'DRAFT_INVALID');
  }
  return String(raw);
}

/**
 * Relative Janus API path — browser never sees storage_path.
 * @param {string} ci
 * @param {string} draftId
 */
function buildDraftFileUrl(ci, draftId) {
  return (
    '/rechazados/' +
    encodeURIComponent(String(ci)) +
    '/bcu-extraction-drafts/' +
    encodeURIComponent(String(draftId)) +
    '/file'
  );
}

/**
 * Sanitize filename for Content-Disposition (no path / quotes / control chars).
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeDispositionFilename(raw) {
  let name =
    raw != null && String(raw).trim() ? String(raw).trim() : 'bcu-document';
  name = name.replace(/[\r\n\0"\\]/g, '_');
  name = name.replace(/[\/\\]/g, '_');
  name = name.slice(0, 180);
  if (!name) name = 'bcu-document';
  return name;
}

/**
 * Resolve a safe Content-Type from persisted draft metadata.
 * @param {unknown} raw
 * @returns {string}
 */
function resolveContentType(raw) {
  const mime = String(raw || '')
    .trim()
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (SAFE_CONTENT_TYPES.indexOf(mime) >= 0) return mime;
  return 'application/octet-stream';
}

function classificationFromValidation(validationJson) {
  if (
    validationJson &&
    typeof validationJson === 'object' &&
    validationJson.classification != null
  ) {
    return String(validationJson.classification);
  }
  return null;
}

function hasExtractionPayload(row) {
  if (!row) return false;
  if (row.status === 'extracting') return false;
  return row.extraction_json != null && typeof row.extraction_json === 'object';
}

function fileAvailable(row) {
  return !!(row && row.storage_path);
}

/**
 * Public summary for latest-active list (no storage_path / full JSON blobs).
 * @param {object} row
 * @param {{ nowMs?: number }} [opts]
 */
function summarizeDraft(row, opts) {
  if (!row) return null;
  const nowMs =
    opts && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const flags = reuseFlags(row, nowMs);
  return {
    id: row.id,
    ci: row.ci,
    status: row.status,
    original_filename: row.original_filename,
    content_type: row.content_type,
    file_size_bytes:
      row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
    file_sha256: row.file_sha256,
    extraction_contract_version: row.extraction_contract_version,
    currency_view_selected: row.currency_view_selected,
    document_ci_raw: row.document_ci_raw,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lease_expires_at: row.lease_expires_at,
    can_retry: flags.can_retry,
    in_progress: flags.in_progress,
    classification: classificationFromValidation(row.validation_json),
    has_extraction: hasExtractionPayload(row),
    file_available: fileAvailable(row),
    file_url: buildDraftFileUrl(row.ci, row.id),
  };
}

/**
 * Detail payload. extracting → extraction null. Never includes storage_path.
 * @param {object} row
 * @param {{ nowMs?: number }} [opts]
 */
function detailDraft(row, opts) {
  if (!row) return null;
  const summary = summarizeDraft(row, opts);
  let extraction = null;
  if (row.status !== 'extracting' && hasExtractionPayload(row)) {
    extraction = row.extraction_json;
  }
  return {
    draft: summary,
    confirmed_snapshot_id:
      row.confirmed_snapshot_id != null ? row.confirmed_snapshot_id : null,
    confirmed_at: row.confirmed_at != null ? row.confirmed_at : null,
    extraction: extraction,
    validation:
      row.validation_json != null && typeof row.validation_json === 'object'
        ? row.validation_json
        : null,
    can_retry: summary.can_retry,
    in_progress: summary.in_progress,
    file_available: summary.file_available,
    file_url: summary.file_url,
  };
}

/**
 * Latest active draft for CI: created_at DESC, id DESC LIMIT 1 among active statuses.
 * @param {object} supabase
 * @param {string} ci
 */
async function fetchLatestActiveDraft(supabase, ci) {
  const { data, error } = await supabase
    .from(DRAFT_TABLE)
    .select(DRAFT_READ_SELECT)
    .eq('ci', ci)
    .in('status', ACTIVE_DRAFT_STATUSES.slice())
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    const err = new Error('Error interno');
    err.statusCode = 500;
    err.code = 'DRAFT_READ_FAILED';
    err.cause = error;
    throw err;
  }
  return data || null;
}

/**
 * Draft by id + ci ownership. 404 if missing or CI mismatch.
 * @param {object} supabase
 * @param {string} draftId
 * @param {string} ci
 */
async function fetchDraftByIdAndCi(supabase, draftId, ci) {
  const id = assertDraftId(draftId);
  const { data, error } = await supabase
    .from(DRAFT_TABLE)
    .select(DRAFT_READ_SELECT)
    .eq('id', id)
    .eq('ci', ci)
    .maybeSingle();

  if (error) {
    const err = new Error('Error interno');
    err.statusCode = 500;
    err.code = 'DRAFT_READ_FAILED';
    err.cause = error;
    throw err;
  }
  if (!data) {
    throw httpError(404, 'No encontrado', 'DRAFT_NOT_FOUND');
  }
  return data;
}

/**
 * Assert draft status is readable via detail/file GETs.
 * @param {object} row
 */
function assertDraftReadableStatus(row) {
  if (!row || DETAIL_READABLE_STATUSES.indexOf(row.status) === -1) {
    throw httpError(404, 'No encontrado', 'DRAFT_NOT_FOUND');
  }
  return row;
}

/**
 * Download private draft bytes. Caller must already own the draft row.
 * @param {object} supabase
 * @param {object} row
 * @returns {Promise<{ buffer: Buffer, contentType: string, filename: string }>}
 */
async function loadDraftFileBytes(supabase, row) {
  if (!row || !row.storage_path) {
    throw httpError(500, 'Error interno', 'BCU_DOWNLOAD_FAILED');
  }
  const buffer = await downloadRejectedBcuFile(supabase, row.storage_path);
  return {
    buffer: buffer,
    contentType: resolveContentType(row.content_type),
    filename: sanitizeDispositionFilename(row.original_filename),
  };
}

module.exports = {
  DRAFT_TABLE,
  ACTIVE_DRAFT_STATUSES,
  DETAIL_READABLE_STATUSES,
  DRAFT_READ_SELECT,
  assertDraftId,
  buildDraftFileUrl,
  sanitizeDispositionFilename,
  resolveContentType,
  summarizeDraft,
  detailDraft,
  fetchLatestActiveDraft,
  fetchDraftByIdAndCi,
  assertDraftReadableStatus,
  loadDraftFileBytes,
};
