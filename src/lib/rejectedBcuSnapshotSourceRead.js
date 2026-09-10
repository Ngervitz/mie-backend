'use strict';

/**
 * Authenticated download of private BCU snapshot source evidence (Stage 6D.7).
 * Never exposes storage_path to callers. Always attachment + nosniff.
 */

const {
  downloadRejectedBcuFile,
  BCU_SOURCE_CONTENT_TYPE,
  BCU_SOURCE_EXT,
} = require('./rejectedBcuStorage');

const SNAPSHOT_TABLE = 'rejected_bcu_snapshots';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function assertSnapshotId(raw) {
  if (!raw || !UUID_RE.test(String(raw))) {
    throw httpError(400, 'snapshot inválido', 'SNAPSHOT_INVALID');
  }
  return String(raw);
}

/**
 * @param {object} supabase
 * @param {string} snapshotId
 * @param {number} ci
 */
async function fetchSnapshotSourceMeta(supabase, snapshotId, ci) {
  const id = assertSnapshotId(snapshotId);
  const { data, error } = await supabase
    .from(SNAPSHOT_TABLE)
    .select(
      'id, ci, storage_path, original_filename, content_type, file_size_bytes, source',
    )
    .eq('id', id)
    .eq('ci', ci)
    .maybeSingle();
  if (error) {
    throw httpError(500, 'Error interno', 'SNAPSHOT_LOAD_FAILED');
  }
  if (!data) {
    throw httpError(404, 'No encontrado', 'SNAPSHOT_NOT_FOUND');
  }
  return data;
}

/**
 * Load source bytes for authenticated proxy response.
 * @returns {Promise<{ buffer: Buffer, contentType: string, filename: string, headers: object }>}
 */
async function loadSnapshotSourceFileBytes(supabase, snapshotId, ci) {
  const row = await fetchSnapshotSourceMeta(supabase, snapshotId, ci);
  if (!row.storage_path) {
    throw httpError(404, 'Sin archivo fuente', 'SOURCE_FILE_MISSING');
  }
  const buffer = await downloadRejectedBcuFile(supabase, row.storage_path);
  const filename = 'bcu-source.' + BCU_SOURCE_EXT;
  return {
    buffer: buffer,
    // Force opaque type regardless of DB content_type (defense in depth).
    contentType: BCU_SOURCE_CONTENT_TYPE,
    filename: filename,
    headers: {
      'Content-Type': BCU_SOURCE_CONTENT_TYPE,
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  };
}

function buildSnapshotSourceFileUrl(ci, snapshotId) {
  return (
    '/rechazados/' +
    String(ci) +
    '/bcu-snapshots/' +
    String(snapshotId) +
    '/source-file'
  );
}

module.exports = {
  assertSnapshotId,
  fetchSnapshotSourceMeta,
  loadSnapshotSourceFileBytes,
  buildSnapshotSourceFileUrl,
};
