'use strict';

/**
 * Rechazados V0 — list/detail + manual BCU snapshot write.
 * Mount: app.use('/rechazados', requireDashboardPermission('rechazados'), router)
 */

const express = require('express');
const multer = require('multer');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { normalizeCi } = require('../lib/rejectedOps');
const {
  parseStatusQuery,
  assembleRejectedList,
  assembleRejectedDetail,
  fetchRejectedListBundle,
  fetchRejectedDetailBundle,
  fetchCiHasRejectedHistorico,
} = require('../lib/rejectedOpsRead');
const { parseSnapshotPayload, parseCreatedBy } = require('../lib/rejectedBcuValidate');
const {
  MAX_FILE_BYTES,
  ALLOWED_MIME_TYPES,
  normalizeMime,
  validateRejectedBcuFile,
} = require('../lib/rejectedBcuStorage');
const { persistRejectedBcuSnapshot } = require('../lib/rejectedBcuPersist');

const router = express.Router();

const bcuUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const mime = normalizeMime(file && file.mimetype);
    if (!ALLOWED_MIME_TYPES.includes(mime)) {
      const err = new Error('archivo no permitido');
      err.statusCode = 400;
      return cb(err);
    }
    return cb(null, true);
  },
});

function sendWriteError(res, err) {
  const status = (err && err.statusCode) || 500;
  const message =
    status === 400 || status === 404
      ? err.message
      : 'Error interno';
  return res.status(status).json({ error: message });
}

router.get('/', async function getRechazadosList(req, res) {
  const parsed = parseStatusQuery(req.query && req.query.status);
  if (!parsed.ok) {
    return res.status(400).json({ error: 'status inválido' });
  }

  try {
    const bundle = await fetchRejectedListBundle(supabase);
    const rows = assembleRejectedList({
      estadoRows: bundle.estadoRows,
      solicitudRows: bundle.solicitudRows,
      encuestaRows: bundle.encuestaRows,
      snapshotRows: bundle.snapshotRows,
      institutionRows: bundle.institutionRows,
      status: parsed.status,
    });
    return res.json({ ok: true, data: { rows: rows } });
  } catch (err) {
    logger.error('GET /rechazados failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

router.post('/:ci/bcu-snapshots', function postBcuSnapshot(req, res) {
  bcuUpload.single('file')(req, res, async function onUpload(uploadErr) {
    if (uploadErr) {
      const isSize =
        uploadErr instanceof multer.MulterError &&
        uploadErr.code === 'LIMIT_FILE_SIZE';
      logger.warn('POST /rechazados/:ci/bcu-snapshots upload rejected', {
        error: uploadErr.message,
        code: uploadErr.code || null,
      });
      if (isSize) {
        return res.status(400).json({ error: 'archivo demasiado grande' });
      }
      return res.status(400).json({
        error: uploadErr.statusCode === 400 ? uploadErr.message : 'archivo no permitido',
      });
    }

    const ci = normalizeCi(req.params && req.params.ci);
    if (ci == null) {
      return res.status(400).json({ error: 'CI inválida' });
    }

    try {
      const inUniverse = await fetchCiHasRejectedHistorico(supabase, ci);
      if (!inUniverse) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      const parsed = parseSnapshotPayload(req.body || {});
      const fileMeta = validateRejectedBcuFile(req.file || null);
      const createdBy = parseCreatedBy(req.dashboardUserId);

      const data = await persistRejectedBcuSnapshot({
        ci: ci,
        period_label: parsed.period_label,
        consulted_on: parsed.consulted_on,
        institutions: parsed.institutions,
        created_by: createdBy,
        fileMeta: fileMeta,
      });

      if (req.file) req.file.buffer = null;
      return res.status(201).json({ ok: true, data: data });
    } catch (err) {
      if (req.file) req.file.buffer = null;
      const status = err && err.statusCode;
      if (status === 400 || status === 404) {
        return sendWriteError(res, err);
      }
      logger.error('POST /rechazados/:ci/bcu-snapshots failed', {
        error: err && err.message ? err.message : 'unknown',
      });
      return sendWriteError(res, err);
    }
  });
});

router.get('/:ci', async function getRechazadosDetail(req, res) {
  const ci = normalizeCi(req.params && req.params.ci);
  if (ci == null) {
    return res.status(400).json({ error: 'CI inválida' });
  }

  try {
    const bundle = await fetchRejectedDetailBundle(supabase, ci);
    const detail = assembleRejectedDetail(bundle);
    if (!detail) {
      return res.status(404).json({ error: 'No encontrado' });
    }
    return res.json({ ok: true, data: detail });
  } catch (err) {
    logger.error('GET /rechazados/:ci failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

module.exports = router;
