/**
 * Liquidity cycle API.
 * GET /api/liquidity-cycle/history — last 30 days + today's phase (Montevideo).
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { phaseForDayOfMonth } = require('../jobs/liquidityCycleSync');

const router = express.Router();

async function resolveMontevideoToday() {
  const { data: yesterday, error } = await supabase.rpc('montevideo_yesterday');
  if (error) {
    throw new Error(`montevideo_yesterday failed: ${error.message}`);
  }
  // today = yesterday + 1 calendar day (same zone as the RPC).
  const y = String(yesterday);
  const [yy, mm, dd] = y.split('-').map(Number);
  const dt = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yyyy = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mo}-${day}`;
}

router.get('/history', async (req, res) => {
  try {
    const today = await resolveMontevideoToday();
    const dayOfMonth = Number(today.slice(8, 10));
    const todayPhase = phaseForDayOfMonth(dayOfMonth);

    const { data, error } = await supabase
      .from('liquidity_cycle_daily_log')
      .select('log_date, cycle_phase, day_of_month, meta_spend_day')
      .order('log_date', { ascending: false })
      .limit(30);

    if (error) {
      logger.error('GET /api/liquidity-cycle/history failed', {
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      today: {
        date: today,
        dayOfMonth,
        cyclePhase: todayPhase,
      },
      history: data || [],
    });
  } catch (err) {
    logger.error('GET /api/liquidity-cycle/history unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

module.exports = router;
