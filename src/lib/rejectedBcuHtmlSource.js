'use strict';

/**
 * Sanitized BCU HTML source evidence (Stage 6D.7).
 *
 * Untrusted document: never execute. Store as application/octet-stream.
 * Hash is SHA-256 of exact sanitized UTF-8 bytes uploaded.
 */

const { createHash, randomUUID } = require('crypto');
const {
  decodeBcuHtml,
  sanitizeBcuHtmlSensitive,
  assertNoCaptchaLeak,
} = require('./bcuHtmlParser');
const {
  uploadRejectedBcuSourceDocument,
  removeRejectedBcuFile,
  buildRejectedBcuObjectPath,
  pathContainsCi,
  BCU_SOURCE_CONTENT_TYPE,
  BCU_SOURCE_EXT,
  MAX_FILE_BYTES,
} = require('./rejectedBcuStorage');
const logger = require('./logger');

/**
 * Decode + sanitize HTML into UTF-8 bytes for storage.
 * @param {Buffer|string} input
 * @returns {{ buffer: Buffer, charset: string, sha256: string, byteLength: number }}
 */
function prepareSanitizedBcuHtmlSource(input) {
  const decoded = decodeBcuHtml(input);
  const sanitized = sanitizeBcuHtmlSensitive(decoded.html);
  assertNoCaptchaLeak(sanitized, 'sanitized_html_source');
  // Normalize to UTF-8 bytes (NFC) for stable hash/recovery.
  const normalized = String(sanitized).normalize('NFC');
  const buffer = Buffer.from(normalized, 'utf8');
  if (!buffer.length) {
    const err = new Error('empty_sanitized_html');
    err.code = 'EMPTY_SANITIZED_HTML';
    throw err;
  }
  if (buffer.length > MAX_FILE_BYTES) {
    const err = new Error('archivo demasiado grande');
    err.statusCode = 400;
    err.code = 'SOURCE_TOO_LARGE';
    throw err;
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return {
    buffer: buffer,
    charset: decoded.charset || 'utf-8',
    sha256: sha256,
    byteLength: buffer.length,
  };
}

/**
 * Upload sanitized source. Path owner is a random UUID (never CI / period).
 * @returns {Promise<{ storage_path: string, content_type: string, file_size_bytes: number, file_sha256: string, original_filename: string, owner_id: string }>}
 */
async function uploadSanitizedBcuHtmlSource(supabase, prepared, opts) {
  const options = opts || {};
  const ownerId = options.ownerId || randomUUID();
  const objectId = options.objectId || randomUUID();
  if (pathContainsCi(ownerId, options.ci) || pathContainsCi(objectId, options.ci)) {
    const err = new Error('storage path must not contain CI');
    err.code = 'SOURCE_PATH_CONTAINS_CI';
    throw err;
  }
  const storagePath = await uploadRejectedBcuSourceDocument(supabase, {
    ownerId: ownerId,
    objectId: objectId,
    buffer: prepared.buffer,
  });
  if (pathContainsCi(storagePath, options.ci)) {
    try {
      await removeRejectedBcuFile(supabase, storagePath);
    } catch (_e) {
      /* ignore */
    }
    const err = new Error('storage path must not contain CI');
    err.code = 'SOURCE_PATH_CONTAINS_CI';
    throw err;
  }
  return {
    storage_path: storagePath,
    content_type: BCU_SOURCE_CONTENT_TYPE,
    file_size_bytes: prepared.byteLength,
    file_sha256: prepared.sha256,
    original_filename: 'bcu-source.' + BCU_SOURCE_EXT,
    owner_id: ownerId,
  };
}

/**
 * Upload-then-persist compensation helper.
 * Calls persistFn({ fileMeta }) after upload; deletes object if persistFn throws/fails.
 *
 * @param {object} supabase
 * @param {{ buffer: Buffer, sha256: string, byteLength: number }} prepared
 * @param {(fileMeta: object) => Promise<{ ok: boolean, result?: string, [k: string]: unknown }>} persistFn
 *   persistFn must return { ok:false } or throw on failure; { ok:true } on success.
 *   For ALREADY_CONFIRMED / CONFLICT, pass skipUpload=true to caller instead.
 */
async function uploadSourceThenPersist(supabase, prepared, persistFn, opts) {
  const uploaded = await uploadSanitizedBcuHtmlSource(supabase, prepared, opts);
  try {
    const out = await persistFn({
      storage_path: uploaded.storage_path,
      content_type: uploaded.content_type,
      file_size_bytes: uploaded.file_size_bytes,
      file_sha256: uploaded.file_sha256,
      original_filename: uploaded.original_filename,
    });
    if (!out || out.ok !== true) {
      try {
        await removeRejectedBcuFile(supabase, uploaded.storage_path);
      } catch (cleanErr) {
        logger.error('bcu html source compensate delete failed', {
          storagePath: uploaded.storage_path,
          error: cleanErr && cleanErr.message,
        });
      }
      return out;
    }
    return Object.assign({}, out, { source_file: uploaded });
  } catch (err) {
    try {
      await removeRejectedBcuFile(supabase, uploaded.storage_path);
    } catch (cleanErr) {
      logger.error('bcu html source compensate delete failed', {
        storagePath: uploaded.storage_path,
        error: cleanErr && cleanErr.message,
      });
    }
    throw err;
  }
}

/**
 * Backfill planner (no I/O). Returns whether attach is allowed.
 */
function planHtmlSourceBackfill(input) {
  const snap = input && input.snapshot;
  const parsed = input && input.parsed;
  if (!snap || !parsed) {
    return { ok: false, reason: 'MISSING_INPUT' };
  }
  if (snap.source !== 'html_import') {
    return { ok: false, reason: 'SOURCE_NOT_HTML_IMPORT' };
  }
  if (snap.storage_path) {
    return { ok: false, reason: 'SOURCE_FILE_ALREADY_PRESENT' };
  }
  if (parsed.page_type !== 'RESULT_PAGE') {
    return { ok: false, reason: 'NOT_RESULT_PAGE' };
  }
  if (Number(snap.ci) !== Number(input.ci)) {
    return { ok: false, reason: 'CI_MISMATCH' };
  }
  if (String(snap.period_label) !== String(parsed.period)) {
    return { ok: false, reason: 'PERIOD_MISMATCH' };
  }
  if (!input.trusted) {
    return { ok: false, reason: 'UNTRUSTED' };
  }
  return { ok: true, reason: null };
}

/**
 * Local cleanup gate (no deletes). SAFE_TO_DELETE only when all true.
 */
function evaluateLocalHtmlSafeToDelete(input) {
  const reasons = [];
  if (!input || input.page_type !== 'RESULT_PAGE') {
    reasons.push('NOT_RESULT_PAGE');
  }
  if (!input.snapshot_confirmed) reasons.push('NO_CONFIRMED_SNAPSHOT');
  if (!input.source_file_stored) reasons.push('NO_SOURCE_FILE');
  if (!input.source_hash_verified) reasons.push('HASH_NOT_VERIFIED');
  if (!input.ci_period_match) reasons.push('CI_PERIOD_MISMATCH');
  if (!input.payload_match) reasons.push('PAYLOAD_MISMATCH');
  if (input.conflict) reasons.push('CONFLICT');
  return {
    safe_to_delete: reasons.length === 0,
    reasons: reasons,
  };
}

module.exports = {
  prepareSanitizedBcuHtmlSource,
  uploadSanitizedBcuHtmlSource,
  uploadSourceThenPersist,
  planHtmlSourceBackfill,
  evaluateLocalHtmlSafeToDelete,
  buildRejectedBcuObjectPath,
};
