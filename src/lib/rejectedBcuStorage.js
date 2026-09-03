'use strict';

/**
 * Private BCU file storage. Bucket must already exist (not created at runtime).
 * Paths: {snapshot_id}/{uuid}.{ext} — never include CI.
 */

const { randomUUID } = require('crypto');
const logger = require('./logger');

const REJECTED_BCU_BUCKET = 'rejected-bcu-files';
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const MIME_TO_EXT = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
});

const ALLOWED_MIME_TYPES = Object.freeze(Object.keys(MIME_TO_EXT));

function normalizeMime(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .split(';')[0]
    .trim();
}

function detectMagicMime(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  const head4 = buffer.slice(0, 4).toString('ascii');
  if (head4 === '%PDF') return 'application/pdf';
  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function isBucketMissingError(error) {
  const msg = String((error && error.message) || '');
  const status = error && (error.statusCode || error.status);
  if (status === 404) return true;
  return /bucket not found|not found/i.test(msg);
}

function storageHttpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * @param {{ mimetype?: string, originalname?: string, size?: number, buffer?: Buffer }} file
 */
function validateRejectedBcuFile(file) {
  if (!file) return null;
  const mime = normalizeMime(file.mimetype);
  if (!ALLOWED_MIME_TYPES.includes(mime)) {
    const err = new Error('archivo no permitido');
    err.statusCode = 400;
    throw err;
  }
  if (!file.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    const err = new Error('archivo no permitido');
    err.statusCode = 400;
    throw err;
  }
  if (file.buffer.length > MAX_FILE_BYTES) {
    const err = new Error('archivo demasiado grande');
    err.statusCode = 400;
    throw err;
  }
  const magic = detectMagicMime(file.buffer);
  if (magic !== mime) {
    const err = new Error('archivo no permitido');
    err.statusCode = 400;
    throw err;
  }
  const original =
    file.originalname != null && String(file.originalname).trim()
      ? String(file.originalname).trim().slice(0, 255)
      : null;
  return {
    contentType: mime,
    ext: MIME_TO_EXT[mime],
    fileSizeBytes: file.buffer.length,
    originalFilename: original,
    buffer: file.buffer,
  };
}

function buildRejectedBcuObjectPath(snapshotId, objectId, ext) {
  return String(snapshotId) + '/' + String(objectId) + '.' + String(ext);
}

function pathContainsCi(path, ci) {
  if (ci == null) return false;
  return String(path).includes(String(ci));
}

async function uploadRejectedBcuFile(supabase, opts) {
  const objectId = opts.objectId || randomUUID();
  const storagePath = buildRejectedBcuObjectPath(
    opts.snapshotId,
    objectId,
    opts.ext,
  );
  const { error } = await supabase.storage
    .from(REJECTED_BCU_BUCKET)
    .upload(storagePath, opts.buffer, {
      contentType: opts.contentType,
      upsert: false,
    });
  if (error) {
    if (isBucketMissingError(error)) {
      logger.error('rejected BCU storage bucket missing', {
        bucket: REJECTED_BCU_BUCKET,
        error: error.message,
      });
      throw storageHttpError(
        'Almacenamiento BCU no configurado',
        500,
        'BCU_BUCKET_MISSING',
      );
    }
    logger.error('rejected BCU storage upload failed', {
      error: error.message,
    });
    throw storageHttpError('Error interno', 500, 'BCU_UPLOAD_FAILED');
  }
  return storagePath;
}

async function removeRejectedBcuFile(supabase, storagePath) {
  const { error } = await supabase.storage
    .from(REJECTED_BCU_BUCKET)
    .remove([storagePath]);
  if (error) {
    logger.error('rejected BCU storage cleanup failed', {
      storagePath: storagePath,
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  REJECTED_BCU_BUCKET,
  MAX_FILE_BYTES,
  ALLOWED_MIME_TYPES,
  MIME_TO_EXT,
  normalizeMime,
  detectMagicMime,
  validateRejectedBcuFile,
  buildRejectedBcuObjectPath,
  pathContainsCi,
  uploadRejectedBcuFile,
  removeRejectedBcuFile,
};
