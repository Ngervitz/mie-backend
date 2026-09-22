'use strict';

/**
 * Preaprobados CZ/CDV V1 — observation list/detail.
 * Mount: app.use('/preaprobados', requireDashboardPermission('preaprobados'), router)
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  parseResultadoQuery,
  parseEstadoQuery,
  parseIsoQuery,
  parsePagination,
  assemblePreaprobadosList,
  assemblePreaprobadosDetail,
  fetchPreaprobadosListBundle,
  fetchPreaprobadosDetailBundle,
} = require('../lib/preaprobadosRead');

const router = express.Router();

router.get('/', async function getPreaprobadosList(req, res) {
  const fromP = parseIsoQuery(req.query && req.query.from);
  if (!fromP.ok) {
    return res.status(400).json({ error: 'from inválido' });
  }
  const toP = parseIsoQuery(req.query && req.query.to);
  if (!toP.ok) {
    return res.status(400).json({ error: 'to inválido' });
  }
  const estadoP = parseEstadoQuery(req.query && req.query.estado);
  if (!estadoP.ok) {
    return res.status(400).json({ error: 'estado inválido' });
  }
  const resultadoP = parseResultadoQuery(req.query && req.query.resultado);
  if (!resultadoP.ok) {
    return res.status(400).json({ error: 'resultado inválido' });
  }
  const pageP = parsePagination(
    req.query && req.query.limit,
    req.query && req.query.offset,
  );
  if (!pageP.ok) {
    return res.status(400).json({ error: 'paginación inválida' });
  }

  const q =
    req.query && req.query.q != null && String(req.query.q).trim() !== ''
      ? String(req.query.q).trim()
      : null;

  try {
    const bundle = await fetchPreaprobadosListBundle(supabase);
    const assembled = assemblePreaprobadosList({
      estado8Rows: bundle.estado8Rows,
      currentEstado8Solicitudes: bundle.currentEstado8Solicitudes,
      solicitudRows: bundle.solicitudRows,
      grantedRows: bundle.grantedRows,
      historicoRows: bundle.historicoRows,
      from: fromP.value,
      to: toP.value,
      estado: estadoP.value,
      resultado: resultadoP.value,
      q: q,
      limit: pageP.limit,
      offset: pageP.offset,
    });
    return res.json({
      ok: true,
      data: {
        cohort: assembled.cohort,
        kpis: assembled.kpis,
        rows: assembled.rows,
        total: assembled.total,
        limit: assembled.limit,
        offset: assembled.offset,
      },
    });
  } catch (err) {
    logger.error('GET /preaprobados failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

router.get('/:czId', async function getPreaprobadosDetail(req, res) {
  const czRaw = req.params && req.params.czId;
  try {
    const bundle = await fetchPreaprobadosDetailBundle(supabase, czRaw);
    if (!bundle.ok) {
      if (bundle.reason === 'invalid_cz_id') {
        return res.status(400).json({ error: 'cz_id inválido' });
      }
      return res.status(404).json({ error: 'No encontrado' });
    }
    const detail = assemblePreaprobadosDetail({
      czId: bundle.czId,
      estado8Rows: bundle.estado8Rows,
      currentEstado8Solicitudes: bundle.currentEstado8Solicitudes,
      solicitud: bundle.solicitud,
      grantedRow: bundle.grantedRow,
      historicoRows: bundle.historicoRows,
    });
    if (!detail) {
      return res.status(404).json({ error: 'No encontrado' });
    }
    return res.json({ ok: true, data: detail });
  } catch (err) {
    logger.error('GET /preaprobados/:czId failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

module.exports = router;
