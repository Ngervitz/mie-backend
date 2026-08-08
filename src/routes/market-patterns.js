const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const router = express.Router();

/**
 * Latest evaluation pick — mirrors mie-dashboard.js pickLatestEvaluation exactly:
 * 1) evaluated_at DESC (primary; invalid/missing → 0)
 * 2) run_version DESC (tie-break only; invalid/missing → 0)
 */
function pickLatestEvaluation(a, b) {
  const ta = Date.parse(a && a.evaluated_at) || 0;
  const tb = Date.parse(b && b.evaluated_at) || 0;
  if (tb !== ta) return tb > ta ? b : a;
  const ra = Number(a && a.run_version) || 0;
  const rb = Number(b && b.run_version) || 0;
  return rb >= ra ? b : a;
}

/**
 * GET /market-patterns
 *
 * Active signal hypotheses + latest evaluation per hypothesis (any validation_status).
 * This screen intentionally exposes insufficient_support | candidate | validated so the
 * UI can show evidence accumulating. Future decision/LLM consumers must stay validated-only.
 */
router.get('/', async (req, res) => {
  try {
    const { data: hypotheses, error: hypErr } = await supabase
      .from('signal_hypotheses')
      .select('*')
      .eq('active', true)
      .order('id', { ascending: true });

    if (hypErr) {
      logger.error('GET /market-patterns hypotheses query failed', {
        error: hypErr.message,
      });
      return res.status(500).json({ error: hypErr.message });
    }

    const list = Array.isArray(hypotheses) ? hypotheses : [];
    if (list.length === 0) {
      return res.status(200).json({ hypotheses: [] });
    }

    const ids = list.map((h) => h.id).filter((id) => id != null);
    const { data: evaluations, error: evalErr } = await supabase
      .from('signal_pattern_evaluations')
      .select('*')
      .in('hypothesis_id', ids);

    if (evalErr) {
      logger.error('GET /market-patterns evaluations query failed', {
        error: evalErr.message,
      });
      return res.status(500).json({ error: evalErr.message });
    }

    const latestByHypothesis = new Map();
    for (const row of Array.isArray(evaluations) ? evaluations : []) {
      const hid = row.hypothesis_id;
      if (hid == null) continue;
      const prev = latestByHypothesis.get(hid);
      if (!prev) {
        latestByHypothesis.set(hid, row);
      } else {
        latestByHypothesis.set(hid, pickLatestEvaluation(prev, row));
      }
    }

    const payload = list.map((h) => ({
      ...h,
      evaluation: latestByHypothesis.has(h.id)
        ? latestByHypothesis.get(h.id)
        : null,
    }));

    return res.status(200).json({ hypotheses: payload });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /market-patterns unexpected', { error: message });
    return res.status(500).json({ error: message });
  }
});

module.exports = router;
