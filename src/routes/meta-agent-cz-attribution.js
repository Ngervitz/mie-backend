/**
 * Meta Ads — Credizona attribution aggregates (Etapa 3).
 * GET /api/meta-agent/cz-attribution?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

const express = require('express');
const logger = require('../lib/logger');
const { validateAttributionDateRange } = require('../lib/metaAgentCzAttribution');
const {
  buildCzAttributionAggregates,
} = require('../services/metaAgentCzAttributionService');

const router = express.Router();

router.get('/cz-attribution', async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  const validated = validateAttributionDateRange(from, to);
  if (!validated.ok) {
    return res.status(400).json({
      error: validated.message,
      code: validated.code,
    });
  }

  try {
    const payload = await buildCzAttributionAggregates({
      from: validated.from,
      to: validated.to,
    });
    return res.json(payload);
  } catch (err) {
    if (err && err.status === 400 && err.code) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    logger.error('GET /api/meta-agent/cz-attribution failed', {
      code: err && err.code ? err.code : 'internal',
      message: err && err.message ? String(err.message) : undefined,
    });
    return res.status(500).json({ error: 'No se pudo calcular atribución' });
  }
});

module.exports = router;
