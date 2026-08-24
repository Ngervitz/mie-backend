'use strict';

/**
 * Public SMS short-link redirect. Must be mounted BEFORE requireAuth.
 * GET /s/:short_code → 302 to destination_url, or 404.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../lib/logger');
const { appendTrackingToken } = require('../lib/smsTinyUrl');

const router = express.Router();
const SHORT_CODE_RE = /^[A-Za-z0-9]{4,12}$/;
const TRACKING_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const IMPACT_LOOKUP_TIMEOUT_MS = 500;

function withBudget(promise, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      const err = new Error('impact lookup timed out');
      err.code = 'IMPACT_LOOKUP_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  promise.catch(function () {});
  return Promise.race([promise, timeoutPromise]).finally(function () {
    if (timer) clearTimeout(timer);
  });
}

function recordHistoricalClick(supabase, code) {
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
}

function recordImpactClick(supabase, impactId) {
  supabase
    .from('marketing_impact_events')
    .insert({
      impact_id: impactId,
      source: 'janus',
      event_name: 'click',
      occurred_at: new Date().toISOString(),
      external_event_id: crypto.randomUUID(),
    })
    .then(function (insertRes) {
      if (insertRes && insertRes.error) {
        logger.warn('SMS impact click event insert failed', {
          kind: 'short_redirect_error',
          reason: 'click_event_insert_failed',
        });
      }
    })
    .catch(function () {
      logger.warn('SMS impact click event insert failed', {
        kind: 'short_redirect_error',
        reason: 'click_event_insert_failed',
      });
    });
}

router.get('/s/:short_code', async (req, res) => {
  const code = String((req.params && req.params.short_code) || '').trim();
  if (!SHORT_CODE_RE.test(code)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  try {
    const supabase = require('../clients/supabase');
    const { data, error } = await supabase
      .from('sms_short_links')
      .select('destination_url, impact_id')
      .eq('short_code', code)
      .maybeSingle();
    const dest =
      data && data.destination_url != null
        ? String(data.destination_url).trim()
        : '';
    if (error || !dest) {
      return res.status(404).type('text/plain').send('Not found');
    }

    const impactId =
      data.impact_id != null && String(data.impact_id).trim()
        ? String(data.impact_id).trim()
        : '';

    let location = dest;
    let individual = false;

    if (impactId) {
      try {
        const impactRes = await withBudget(
          supabase
            .from('marketing_impacts')
            .select('tracking_token')
            .eq('id', impactId)
            .maybeSingle(),
          IMPACT_LOOKUP_TIMEOUT_MS,
        );
        const token =
          impactRes &&
          impactRes.data &&
          impactRes.data.tracking_token != null
            ? String(impactRes.data.tracking_token).trim()
            : '';
        if (impactRes.error) {
          logger.error('SMS short link impact lookup failed', {
            kind: 'short_redirect_error',
            reason: 'impact_lookup_failed',
          });
        } else if (!impactRes.data) {
          logger.error('SMS short link impact missing', {
            kind: 'short_redirect_error',
            reason: 'impact_not_found',
          });
        } else if (!TRACKING_TOKEN_RE.test(token)) {
          logger.error('SMS short link tracking_token invalid', {
            kind: 'short_redirect_error',
            reason: 'invalid_tracking_token',
          });
        } else {
          try {
            location = appendTrackingToken(dest, token);
            individual = true;
          } catch (_err) {
            logger.error('SMS short link jt append failed', {
              kind: 'short_redirect_error',
              reason: 'invalid_destination_url',
            });
          }
        }
      } catch (err) {
        logger.error('SMS short link impact lookup failed', {
          kind: 'short_redirect_error',
          reason:
            err && err.code === 'IMPACT_LOOKUP_TIMEOUT'
              ? 'impact_lookup_timeout'
              : 'impact_lookup_failed',
        });
      }
    }

    res.set('Cache-Control', 'private, no-store');
    res.redirect(302, location);
    if (individual) {
      recordImpactClick(supabase, impactId);
    } else if (!impactId) {
      recordHistoricalClick(supabase, code);
    }
    return undefined;
  } catch (_err) {
    return res.status(404).type('text/plain').send('Not found');
  }
});

module.exports = router;
