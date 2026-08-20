'use strict';

/**
 * Public SMS short-link redirect. Must be mounted BEFORE requireAuth.
 * GET /s/:short_code → 302 to destination_url, or 404.
 */

const express = require('express');
const logger = require('../lib/logger');

const router = express.Router();
const SHORT_CODE_RE = /^[A-Za-z0-9]{4,12}$/;

router.get('/s/:short_code', async (req, res) => {
  const code = String((req.params && req.params.short_code) || '').trim();
  if (!SHORT_CODE_RE.test(code)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  try {
    const supabase = require('../clients/supabase');
    const { data, error } = await supabase
      .from('sms_short_links')
      .select('destination_url')
      .eq('short_code', code)
      .maybeSingle();
    const dest =
      data && data.destination_url != null
        ? String(data.destination_url).trim()
        : '';
    if (error || !dest) {
      return res.status(404).type('text/plain').send('Not found');
    }
    res.set('Cache-Control', 'private, no-store');
    res.redirect(302, dest);
    supabase
      .rpc('sms_short_link_record_click', { p_short_code: code })
      .then(function (rpcRes) {
        if (rpcRes && rpcRes.error) {
          logger.warn('SMS short link click increment failed', {
            kind: 'shortener_error',
            provider: 'mie',
          });
        }
      })
      .catch(function () {
        logger.warn('SMS short link click increment failed', {
          kind: 'shortener_error',
          provider: 'mie',
        });
      });
    return undefined;
  } catch (_err) {
    return res.status(404).type('text/plain').send('Not found');
  }
});

module.exports = router;
