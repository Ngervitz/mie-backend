'use strict';

/**
 * Admin directory for affiliates. Mounted at /affiliates for the cz-funnel
 * section. Does not evaluate attribution and does not pay prizes.
 *
 *   GET  /affiliates
 *   GET  /affiliates/summary
 *   POST /affiliates
 *   GET  /affiliates/pending-attributions
 *   GET  /affiliates/:id
 *   GET  /affiliates/:id/clicks
 *   GET  /affiliates/:id/solicitudes
 */

const express = require('express');
const logger = require('../lib/logger');
const supabase = require('../clients/supabase');
const {
  schemaMissing,
  createAffiliate,
  listAffiliatesWithRowStats,
  aggregateAffiliateDashboardSummary,
  getAffiliate,
  listClicks,
  countClicksWithoutAttribution,
  solicitudesForAffiliate,
} = require('../lib/affiliateDirectoryRead');

const router = express.Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The cron key is accepted by the global gate and by the section middleware.
// This directory is not a job: a request without a dashboard user stops here.
router.use(function requireAffiliateOperator(req, res, next) {
  if (!req.dashboardUserId) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  return next();
});

function fail(res, status, error) {
  return res.status(status).json({ ok: false, error: error });
}

function sendError(res, err, label) {
  if (schemaMissing(err)) {
    return fail(res, 503, 'affiliates_identity_not_ready');
  }
  logger.error(label, {
    error: err && err.message ? err.message : 'unknown',
  });
  return fail(res, 500, 'Error interno');
}

function parseId(raw) {
  const id = raw == null ? '' : String(raw).trim();
  if (!UUID_RE.test(id)) return null;
  return id;
}

router.get('/', async function list(req, res) {
  try {
    const affiliates = await listAffiliatesWithRowStats(supabase);
    return res.json({ ok: true, data: { affiliates: affiliates } });
  } catch (err) {
    return sendError(res, err, 'GET /affiliates failed');
  }
});

router.post('/', async function create(req, res) {
  try {
    const result = await createAffiliate(
      supabase,
      req.body || {},
      new Date().toISOString(),
    );
    if (!result.ok) return fail(res, result.status, result.error);
    return res.status(201).json({ ok: true, data: result.affiliate });
  } catch (err) {
    return sendError(res, err, 'POST /affiliates failed');
  }
});

router.get('/pending-attributions', async function pending(req, res) {
  try {
    const data = await countClicksWithoutAttribution(supabase);
    return res.json({ ok: true, data: data });
  } catch (err) {
    return sendError(res, err, 'GET /affiliates/pending-attributions failed');
  }
});

router.get('/summary', async function summary(req, res) {
  try {
    const data = await aggregateAffiliateDashboardSummary(supabase);
    return res.json({ ok: true, data: data });
  } catch (err) {
    return sendError(res, err, 'GET /affiliates/summary failed');
  }
});

router.post('/sms-pilot10/prepare', async function pilot10Prepare(req, res) {
  try {
    const {
      prepareAffiliateInviteSmsPilot10Batch,
      isPilot10SendAuthorized,
    } = require('../lib/affiliateInviteSmsPilot10Orchestration');
    const dryRun = req.body && req.body.dry_run === false ? false : true;
    if (!dryRun && !isPilot10SendAuthorized({ dryRun: false })) {
      return fail(res, 403, 'pilot10_send_not_authorized');
    }
    const batch = await prepareAffiliateInviteSmsPilot10Batch(supabase, new Date(), {
      dryRun: dryRun || !isPilot10SendAuthorized({ dryRun: false }),
    });
    return res.json({ ok: batch.ok, data: batch });
  } catch (err) {
    return sendError(res, err, 'POST /affiliates/sms-pilot10/prepare failed');
  }
});

router.post('/sms-pilot10/dispatch', async function pilot10Dispatch(req, res) {
  try {
    const { dispatchAffiliateInviteSmsPilot10 } = require('../lib/affiliateInviteSmsPilot10Dispatch');
    const forceDry = !(req.body && req.body.send === true);
    const out = await dispatchAffiliateInviteSmsPilot10(supabase, {
      dryRun: forceDry,
    });
    if (!out.ok) {
      return res.status(out.errorReason === 'pilot10_pre_send_gates_failed' ? 412 : 400).json({
        ok: false,
        error: out.errorReason || 'dispatch_failed',
        data: out,
      });
    }
    return res.json({ ok: true, data: out });
  } catch (err) {
    return sendError(res, err, 'POST /affiliates/sms-pilot10/dispatch failed');
  }
});

router.get('/:id', async function detail(req, res) {
  const id = parseId(req.params && req.params.id);
  if (!id) return fail(res, 400, 'Identificador inválido');
  try {
    const affiliate = await getAffiliate(supabase, id);
    if (!affiliate) return fail(res, 404, 'No encontrado');
    return res.json({ ok: true, data: affiliate });
  } catch (err) {
    return sendError(res, err, 'GET /affiliates/:id failed');
  }
});

router.get('/:id/clicks', async function clicks(req, res) {
  const id = parseId(req.params && req.params.id);
  if (!id) return fail(res, 400, 'Identificador inválido');
  try {
    const affiliate = await getAffiliate(supabase, id);
    if (!affiliate) return fail(res, 404, 'No encontrado');
    const data = await listClicks(supabase, id);
    return res.json({ ok: true, data: data });
  } catch (err) {
    return sendError(res, err, 'GET /affiliates/:id/clicks failed');
  }
});

router.get('/:id/solicitudes', async function solicitudes(req, res) {
  const id = parseId(req.params && req.params.id);
  if (!id) return fail(res, 400, 'Identificador inválido');
  try {
    const affiliate = await getAffiliate(supabase, id);
    if (!affiliate) return fail(res, 404, 'No encontrado');
    const data = await solicitudesForAffiliate(supabase, id);
    return res.json({ ok: true, data: data });
  } catch (err) {
    return sendError(res, err, 'GET /affiliates/:id/solicitudes failed');
  }
});

module.exports = router;
