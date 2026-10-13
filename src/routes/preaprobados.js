'use strict';

/**
 * Preaprobados CZ/CDV V1 — observation list/detail.
 * Mount: app.use('/preaprobados', requireDashboardPermission('preaprobados'), router)
 *
 *   GET /           one row per CI (preaprobadosCiGroups.js) + KPIs
 *   GET /ci/:ci     every Preaprobados solicitud of one CI, with its ELM cell
 *   GET /:czId      one solicitud (CDV result, ELM membership, history)
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  parseEstadoQuery,
  parseIsoQuery,
  parsePagination,
  buildCohortByCzId,
  assemblePreaprobadosDetail,
  fetchPreaprobadosListBundle,
  fetchPreaprobadosDetailBundle,
} = require('../lib/preaprobadosRead');
const {
  parseProveedorQuery,
  parseCombinedResultadoQuery,
  fetchElmCohortBundle,
  fetchElmCohortDetail,
} = require('../lib/preaprobadosElmCohort');
const {
  parseCiParam,
  assembleGroupedPreaprobadosList,
  refreshElmFocus,
  solicitudesOf,
} = require('../lib/preaprobadosCiGroups');
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
async function fetchElmCohortSoft(cdvCohortIds) {
  try {
    const out = await fetchElmCohortBundle(supabase, {
      elmRepository: getElmRepository(),
      cdvCohortIds: cdvCohortIds,
    });
    return Object.assign({ available: true }, out);
  } catch (err) {
    logger.warn('GET /preaprobados elm cohort unavailable', {
      error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
    });
    return {
      available: false,
      elmCohort: new Map(),
      elmSolicitudRows: [],
      elmHistoricoRows: [],
    };
  }
}

/**
 * Grouped list: CDV cohort + ELM members (unchanged rules), one group per CI, paged by CI. ELM
 * cells and send holds are attached to every solicitud of the page's groups.
 */
async function loadGroupedList(filters) {
  const bundle = await fetchPreaprobadosListBundle(supabase);
  const cdvCohortIds = new Set(
    buildCohortByCzId(bundle.estado8Rows, bundle.currentEstado8Solicitudes).keys(),
  );
  const elm = await fetchElmCohortSoft(cdvCohortIds);
  const assembled = assembleGroupedPreaprobadosList(
    Object.assign(
      {
        estado8Rows: bundle.estado8Rows,
        currentEstado8Solicitudes: bundle.currentEstado8Solicitudes,
        solicitudRows: bundle.solicitudRows,
        grantedRows: bundle.grantedRows,
        historicoRows: bundle.historicoRows,
        elmCohort: elm.elmCohort,
        elmSolicitudRows: elm.elmSolicitudRows,
        elmHistoricoRows: elm.elmHistoricoRows,
      },
      filters,
    ),
  );
  const solicitudes = solicitudesOf(assembled.rows);
  await attachElmCells(solicitudes, getElmListView(), logger, { allowSend: true });
  await attachPreaprobadosElmSendHolds(solicitudes, { supabase: supabase, logger: logger });
  refreshElmFocus(assembled.rows);
  return { assembled: assembled, elmAvailable: elm.available };
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
    const out = await loadGroupedList({
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
    const assembled = out.assembled;
    return res.json({
      ok: true,
      data: {
        grouped_by: 'ci',
        cohort: assembled.cohort,
        kpis: assembled.kpis,
        kpis_elm: assembled.kpis_elm,
        kpis_ci: assembled.kpis_ci,
        elm_available: out.elmAvailable,
        rows: assembled.rows,
        total: assembled.total,
        total_solicitudes: assembled.total_solicitudes,
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

/**
 * One CI: every Preaprobados solicitud of the CI (no period / state filters), with the ELM cell
 * of each one ("Enviar a ELM" enabled or held server-side). Same membership as the list.
 */
router.get('/ci/:ci', async function getPreaprobadosCi(req, res) {
  const ciP = parseCiParam(req.params && req.params.ci);
  if (!ciP.ok) {
    return res.status(400).json({ error: 'CI inválida' });
  }
  try {
    const out = await loadGroupedList({ ci: ciP.value, limit: 1, offset: 0 });
    const group = out.assembled.rows[0];
    if (!group) {
      return res.status(404).json({ error: 'No encontrado' });
    }
    return res.json({ ok: true, data: Object.assign({ elm_available: out.elmAvailable }, group) });
  } catch (err) {
    logger.error('GET /preaprobados/ci/:ci failed', {
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
        inCdvCohort: true,
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
