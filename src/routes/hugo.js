const express = require('express');
const { runHugo } = require('../services/hugo-brain');
const { isValidDateOnly } = require('./reports');
const logger = require('../lib/logger');

const router = express.Router();

router.post('/run', async (req, res) => {
  const rawDate = req.body?.date;

  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (!isValidDateOnly(String(rawDate))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
  }

  const date = rawDate ? String(rawDate) : undefined;

  try {
    const result = await runHugo({ date });
    return res.json(result);
  } catch (err) {
    // HugoError carries a safe status + body (no secrets, no stack traces).
    if (err && typeof err.status === 'number' && err.body) {
      logger.error('Hugo run failed', { status: err.status, error: err.body.error });
      return res.status(err.status).json(err.body);
    }

    logger.error('Hugo run failed', { error: err && err.message ? err.message : 'unknown' });
    return res.status(500).json({ error: 'Failed to run Hugo' });
  }
});

module.exports = router;
