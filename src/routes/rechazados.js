'use strict';

/**
 * Rechazados — list/detail + manual BCU snapshot write + Stage 3/4 extraction drafts.
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
  EXTRACT_IMAGE_MIME_TYPES,
  normalizeMime,
  validateRejectedBcuFile,
  validateRejectedBcuExtractFile,
} = require('../lib/rejectedBcuStorage');
const { persistRejectedBcuSnapshot } = require('../lib/rejectedBcuPersist');
const {
  createBcuExtractionDraft,
  retryBcuExtractionDraft,
} = require('../lib/rejectedBcuExtractDraft');
const { confirmBcuExtractionDraft } = require('../lib/rejectedBcuExtractConfirm');
const {
  assertDraftId,
  summarizeDraft,
  detailDraft,
  fetchLatestActiveDraft,
  fetchDraftByIdAndCi,
  assertDraftReadableStatus,
  loadDraftFileBytes,
} = require('../lib/rejectedBcuExtractRead');

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

const bcuExtractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const mime = normalizeMime(file && file.mimetype);
    if (!EXTRACT_IMAGE_MIME_TYPES.includes(mime)) {
      const err = new Error('archivo no permitido');
      err.statusCode = 400;
      return cb(err);
    }
    return cb(null, true);
  },
});

function sendWriteError(res, err) {
  const status = (err && err.statusCode) || 500;
  if (status === 409) {
    const body = {
      error: (err && err.code) || (err && err.message) || 'conflict',
      code: (err && err.code) || 'conflict',
    };
    if (err && err.data !== undefined) body.data = err.data;
    return res.status(409).json(body);
  }
  if (status === 422) {
    const body = {
      error: (err && err.message) || 'confirmación bloqueada',
      code: (err && err.code) || 'CONFIRM_BLOCKED',
    };
    if (err && err.data !== undefined) body.data = err.data;
    return res.status(422).json(body);
  }
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
      outreachRows: bundle.outreachRows,
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

router.post('/:ci/bcu-extraction-drafts', function postBcuExtractionDraft(req, res) {
  bcuExtractUpload.single('file')(req, res, async function onUpload(uploadErr) {
    if (uploadErr) {
      const isSize =
        uploadErr instanceof multer.MulterError &&
        uploadErr.code === 'LIMIT_FILE_SIZE';
      logger.warn('POST /rechazados/:ci/bcu-extraction-drafts upload rejected', {
        error: uploadErr.message,
        code: uploadErr.code || null,
      });
      if (isSize) {
        return res.status(400).json({ error: 'archivo demasiado grande' });
      }
      return res.status(400).json({
        error:
          uploadErr.statusCode === 400
            ? uploadErr.message
            : 'archivo no permitido',
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

      if (!req.file) {
        return res.status(400).json({ error: 'archivo no permitido' });
      }

      const fileMeta = validateRejectedBcuExtractFile(req.file);
      const createdBy = parseCreatedBy(req.dashboardUserId);

      const result = await createBcuExtractionDraft({
        ci: ci,
        fileMeta: fileMeta,
        created_by: createdBy,
      });

      if (req.file) req.file.buffer = null;
      return res.status(result.httpStatus).json({ ok: true, data: result.data });
    } catch (err) {
      if (req.file) req.file.buffer = null;
      const status = err && err.statusCode;
      if (status === 400 || status === 404 || status === 409) {
        return sendWriteError(res, err);
      }
      logger.error('POST /rechazados/:ci/bcu-extraction-drafts failed', {
        error: err && err.message ? err.message : 'unknown',
        code: err && err.code ? err.code : null,
      });
      return sendWriteError(res, err);
    }
  });
});

router.post(
  '/:ci/bcu-extraction-drafts/:draftId/retry',
  async function postBcuExtractionDraftRetry(req, res) {
    const ci = normalizeCi(req.params && req.params.ci);
    if (ci == null) {
      return res.status(400).json({ error: 'CI inválida' });
    }
    const draftId = req.params && req.params.draftId;
    if (
      !draftId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(draftId),
      )
    ) {
      return res.status(400).json({ error: 'draft inválido' });
    }

    try {
      const inUniverse = await fetchCiHasRejectedHistorico(supabase, ci);
      if (!inUniverse) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      const result = await retryBcuExtractionDraft({
        ci: ci,
        draftId: String(draftId),
      });

      return res.status(result.httpStatus).json({ ok: true, data: result.data });
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 400 || status === 404 || status === 409) {
        return sendWriteError(res, err);
      }
      logger.error('POST /rechazados/:ci/bcu-extraction-drafts/:draftId/retry failed', {
        error: err && err.message ? err.message : 'unknown',
        code: err && err.code ? err.code : null,
      });
      return sendWriteError(res, err);
    }
  },
);

router.post(
  '/:ci/bcu-extraction-drafts/:draftId/confirm',
  async function postBcuExtractionDraftConfirm(req, res) {
    const ci = normalizeCi(req.params && req.params.ci);
    if (ci == null) {
      return res.status(400).json({ error: 'CI inválida' });
    }
    const draftId = req.params && req.params.draftId;
    if (
      !draftId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(draftId),
      )
    ) {
      return res.status(400).json({ error: 'draft inválido' });
    }

    try {
      const inUniverse = await fetchCiHasRejectedHistorico(supabase, ci);
      if (!inUniverse) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      const result = await confirmBcuExtractionDraft({
        ci: ci,
        draftId: String(draftId),
        body: req.body || {},
        createdBy: req.dashboardUserId,
      });

      return res.status(result.httpStatus).json({ ok: true, data: result.data });
    } catch (err) {
      const status = err && err.statusCode;
      if (
        status === 400 ||
        status === 404 ||
        status === 409 ||
        status === 422
      ) {
        return sendWriteError(res, err);
      }
      logger.error(
        'POST /rechazados/:ci/bcu-extraction-drafts/:draftId/confirm failed',
        {
          error: err && err.message ? err.message : 'unknown',
          code: err && err.code ? err.code : null,
          draft_id: draftId,
        },
      );
      return sendWriteError(res, err);
    }
  },
);

router.get(
  '/:ci/bcu-extraction-drafts',
  async function getLatestBcuExtractionDraft(req, res) {
    const ci = normalizeCi(req.params && req.params.ci);
    if (ci == null) {
      return res.status(400).json({ error: 'CI inválida' });
    }

    try {
      const inUniverse = await fetchCiHasRejectedHistorico(supabase, ci);
      if (!inUniverse) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      const row = await fetchLatestActiveDraft(supabase, ci);
      const draft = summarizeDraft(row);
      return res.json({
        ok: true,
        data: {
          draft: draft,
          has_active_draft: !!draft,
        },
      });
    } catch (err) {
      logger.error('GET /rechazados/:ci/bcu-extraction-drafts failed', {
        error: err && err.message ? err.message : 'unknown',
        code: err && err.code ? err.code : null,
        cause:
          err && err.cause && err.cause.message
            ? err.cause.message
            : err && err.cause
              ? String(err.cause)
              : null,
        ci: ci,
      });
      return res.status(500).json({ error: 'Error interno' });
    }
  },
);

router.get(
  '/:ci/bcu-extraction-drafts/:draftId/file',
  async function getBcuExtractionDraftFile(req, res) {
    const ci = normalizeCi(req.params && req.params.ci);
    if (ci == null) {
      return res.status(400).json({ error: 'CI inválida' });
    }
    let draftId;
    try {
      draftId = assertDraftId(req.params && req.params.draftId);
    } catch (err) {
      return res.status(400).json({ error: 'draft inválido' });
    }

    try {
      const inUniverse = await fetchCiHasRejectedHistorico(supabase, ci);
      if (!inUniverse) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      const row = assertDraftReadableStatus(
        await fetchDraftByIdAndCi(supabase, draftId, ci),
      );
      const file = await loadDraftFileBytes(supabase, row);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader(
        'Content-Disposition',
        'inline; filename="' + file.filename + '"',
      );
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).send(file.buffer);
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 400 || status === 404) {
        return sendWriteError(res, err);
      }
      logger.error(
        'GET /rechazados/:ci/bcu-extraction-drafts/:draftId/file failed',
        {
          error: err && err.message ? err.message : 'unknown',
          code: err && err.code ? err.code : null,
        },
      );
      return res.status(500).json({ error: 'Error interno' });
    }
  },
);

router.get(
  '/:ci/bcu-extraction-drafts/:draftId',
  async function getBcuExtractionDraftDetail(req, res) {
    const ci = normalizeCi(req.params && req.params.ci);
    if (ci == null) {
      return res.status(400).json({ error: 'CI inválida' });
    }
    let draftId;
    try {
      draftId = assertDraftId(req.params && req.params.draftId);
    } catch (err) {
      return res.status(400).json({ error: 'draft inválido' });
    }

    try {
      const inUniverse = await fetchCiHasRejectedHistorico(supabase, ci);
      if (!inUniverse) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      const row = assertDraftReadableStatus(
        await fetchDraftByIdAndCi(supabase, draftId, ci),
      );
      return res.json({ ok: true, data: detailDraft(row) });
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 400 || status === 404) {
        return sendWriteError(res, err);
      }
      logger.error(
        'GET /rechazados/:ci/bcu-extraction-drafts/:draftId failed',
        {
          error: err && err.message ? err.message : 'unknown',
        },
      );
      return res.status(500).json({ error: 'Error interno' });
    }
  },
);

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
