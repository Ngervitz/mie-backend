'use strict';

/**
 * Preaprobados CZ/CDV V1 — observation list/detail.
 * Mount: app.use('/preaprobados', requireDashboardPermission('preaprobados'), router)
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  parseEstadoQuery,
  parseIsoQuery,
  parsePagination,
  assemblePreaprobadosDetail,
  fetchPreaprobadosListBundle,
  fetchPreaprobadosDetailBundle,
} = require('../lib/preaprobadosRead');
const {
  parseProveedorQuery,
  parseCombinedResultadoQuery,
  assembleCombinedPreaprobadosList,
  fetchElmCohortBundle,
  fetchElmCohortDetail,
} = require('../lib/preaprobadosElmCohort');
const { attachPreaprobadosElmSendHolds } = require('../lib/preaprobadosElmSend');
const { createPreaprobadosElmRouter } = require('./preaprobadosElm');
const { createElmOpsRouter } = require('./elmOps');
const { createElmRepository } = require('../services/elm/repository');
const { createElmListView, attachElmCells } = require('../services/elm/listView');

const router = express.Router();

let elmRepository = null;
function getElmRepository() {
  if (!elmRepository) elmRepository = createElmRepository(supabase);
  return elmRepository;
}

let elmOrchestrator = null;
function getElmOrchestrator() {
  if (!elmOrchestrator) {
    elmOrchestrator = require('../services/elm/orchestrator').createElmOrchestrator({
      repository: getElmRepository(),
    });
  }
  return elmOrchestrator;
}

let elmListView = null;
function getElmListView() {
  if (!elmListView) {
    elmListView = createElmListView({
      repository: getElmRepository(),
      sendReadiness: function () {
        return getElmOrchestrator().getSendReadiness();
      },
    });
  }
  return elmListView;
}

/** ELM cohort never breaks the CDV list: on any error the list is CDV only. */
async function fetchElmCohortSoft() {
  try {
    const out = await fetchElmCohortBundle(supabase, { elmRepository: getElmRepository() });
    return Object.assign({ available: true }, out);
  } catch (err) {
    logger.warn('GET /preaprobados elm cohort unavailable', {
      error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
    });
    return {
      available: false,
      elmCohort: new Map(),
      elmManual: new Map(),
      elmSolicitudRows: [],
      elmHistoricoRows: [],
    };
  }
}

router.use('/elm-ops', createElmOpsRouter());
router.use(
  createPreaprobadosElmRouter({
    getOrchestrator: getElmOrchestrator,
    getListView: getElmListView,
    supabase: supabase,
  }),
);

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
  const resultadoP = parseCombinedResultadoQuery(req.query && req.query.resultado);
  if (!resultadoP.ok) {
    return res.status(400).json({ error: 'resultado inválido' });
  }
  const proveedorP = parseProveedorQuery(req.query && req.query.proveedor);
  if (!proveedorP.ok) {
    return res.status(400).json({ error: 'proveedor inválido' });
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
    const elm = await fetchElmCohortSoft();
    const assembled = assembleCombinedPreaprobadosList({
      estado8Rows: bundle.estado8Rows,
      currentEstado8Solicitudes: bundle.currentEstado8Solicitudes,
      solicitudRows: bundle.solicitudRows,
      grantedRows: bundle.grantedRows,
      historicoRows: bundle.historicoRows,
      elmCohort: elm.elmCohort,
      elmManual: elm.elmManual,
      elmSolicitudRows: elm.elmSolicitudRows,
      elmHistoricoRows: elm.elmHistoricoRows,
      from: fromP.value,
      to: toP.value,
      estado: estadoP.value,
      resultadoCdv: resultadoP.cdv,
      resultadoElm: resultadoP.elm,
      proveedor: proveedorP.value,
      q: q,
      limit: pageP.limit,
      offset: pageP.offset,
    });
    await attachElmCells(assembled.rows, getElmListView(), logger, { allowSend: true });
    await attachPreaprobadosElmSendHolds(assembled.rows, { supabase: supabase, logger: logger });
    return res.json({
      ok: true,
      data: {
        cohort: assembled.cohort,
        kpis: assembled.kpis,
        kpis_elm: assembled.kpis_elm,
        elm_available: elm.available,
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
      if (bundle.reason === 'not_in_cohort' || bundle.reason === 'not_found') {
        let elmDetail = null;
        try {
          elmDetail = await fetchElmCohortDetail(supabase, Number(czRaw), {
            elmRepository: getElmRepository(),
          });
        } catch (err) {
          logger.warn('GET /preaprobados/:czId elm detail unavailable', {
            error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
          });
        }
        if (elmDetail) return res.json({ ok: true, data: elmDetail });
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
    detail.proveedor = 'cdv';
    detail.elm_member = null;
    try {
      const elmDetail = await fetchElmCohortDetail(supabase, bundle.czId, {
        elmRepository: getElmRepository(),
      });
      if (elmDetail) {
        detail.proveedor = 'cdv_elm';
        detail.elm_member = elmDetail.elm_member;
      }
    } catch (err) {
      logger.warn('GET /preaprobados/:czId elm membership unavailable', {
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
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
