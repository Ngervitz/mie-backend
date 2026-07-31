/**
 * BCU usura rate history (manual updates).
 * GET  /api/bcu-usura-rate/current
 * POST /api/bcu-usura-rate  { rate_percent, effective_from, source_note? }
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const router = express.Router();

router.get('/current', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bcu_usura_rate_history')
      .select('id, rate_percent, effective_from, effective_to, source_note, created_at')
      .is('effective_to', null)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error('GET /api/bcu-usura-rate/current failed', {
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'No current BCU usura rate registered' });
    }

    return res.json({ rate: data });
  } catch (err) {
    logger.error('GET /api/bcu-usura-rate/current unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

router.post('/', async (req, res) => {
  const ratePercent = req.body && req.body.rate_percent != null
    ? Number(req.body.rate_percent)
    : NaN;
  const effectiveFrom =
    req.body && typeof req.body.effective_from === 'string'
      ? req.body.effective_from.trim()
      : '';
  const sourceNote =
    req.body && typeof req.body.source_note === 'string'
      ? req.body.source_note.trim()
      : null;

  if (!Number.isFinite(ratePercent)) {
    return res.status(400).json({ error: 'rate_percent must be a number' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return res.status(400).json({ error: 'effective_from must be YYYY-MM-DD' });
  }

  try {
    const { data, error } = await supabase.rpc('insert_bcu_usura_rate', {
      p_rate_percent: ratePercent,
      p_effective_from: effectiveFrom,
      p_source_note: sourceNote,
    });

    if (error) {
      const msg = error.message || 'insert_bcu_usura_rate failed';
      const isValidation = /strictly greater|required/i.test(msg);
      logger.error('POST /api/bcu-usura-rate failed', { error: msg });
      return res.status(isValidation ? 400 : 500).json({ error: msg });
    }

    // rpc may return object or array depending on SETOF vs single composite
    const rate = Array.isArray(data) ? data[0] : data;
    logger.info('BCU usura rate inserted', {
      ratePercent,
      effectiveFrom,
    });
    return res.status(201).json({ ok: true, rate });
  } catch (err) {
    logger.error('POST /api/bcu-usura-rate unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

module.exports = router;
