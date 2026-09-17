'use strict';

/**
 * Public email click redirect.
 * GET  /email/c/:token → record observed request + 302 to destination?jt=token
 * HEAD /email/c/:token → no event write
 *
 * Must be mounted BEFORE requireAuth. Not SMS /s/:code.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../lib/logger');
const {
  TRACKING_TOKEN_RE,
  appendJtToDestination,
} = require('../lib/emailClickTracking');

const router = express.Router();

function recordEmailClick(supabase, impactId, externalEventId) {
  try {
    supabase
      .from('marketing_impact_events')
      .insert({
        impact_id: impactId,
        source: 'janus',
        event_name: 'click',
        occurred_at: new Date().toISOString(),
        external_event_id: externalEventId,
      })
      .then(function (insertRes) {
        if (insertRes && insertRes.error) {
          logger.warn('email click event insert failed', {
            kind: 'email_click_redirect_error',
            reason: 'click_event_insert_failed',
          });
        }
      })
      .catch(function () {
        logger.warn('email click event insert failed', {
          kind: 'email_click_redirect_error',
          reason: 'click_event_insert_failed',
        });
      });
  } catch (_err) {
    logger.warn('email click event dispatch failed', {
      kind: 'email_click_redirect_error',
      reason: 'click_event_insert_failed',
    });
  }
}

async function lookupEmailImpact(supabase, token) {
  const { data, error } = await supabase
    .from('marketing_impacts')
    .select('id, tracking_token, channel, destination_url')
    .eq('tracking_token', token)
    .maybeSingle();
  if (error) {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!data) {
    return { ok: false, reason: 'not_found' };
  }
  if (String(data.channel || '') !== 'email') {
    return { ok: false, reason: 'wrong_channel' };
  }
  const dest =
    data.destination_url != null ? String(data.destination_url).trim() : '';
  if (!dest) {
    return { ok: false, reason: 'missing_destination' };
  }
  return { ok: true, impact: data, destination: dest };
}

router.head('/email/c/:token', async function (req, res) {
  const token = String((req.params && req.params.token) || '').trim();
  if (!TRACKING_TOKEN_RE.test(token)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  try {
    const supabase = require('../clients/supabase');
    const looked = await lookupEmailImpact(supabase, token);
    if (!looked.ok) {
      return res.status(404).type('text/plain').send('Not found');
    }
    // HEAD: confirm existence only — NO marketing_impact_events write.
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).end();
  } catch (_err) {
    return res.status(404).type('text/plain').send('Not found');
  }
});

router.get('/email/c/:token', async function (req, res) {
  const token = String((req.params && req.params.token) || '').trim();
  if (!TRACKING_TOKEN_RE.test(token)) {
    return res.status(404).type('text/plain').send('Not found');
  }

  const externalEventId = crypto.randomUUID();

  try {
    const supabase = require('../clients/supabase');
    const looked = await lookupEmailImpact(supabase, token);
    if (!looked.ok) {
      return res.status(404).type('text/plain').send('Not found');
    }

    let location;
    try {
      location = appendJtToDestination(looked.destination, token);
    } catch (_err) {
      logger.error('email click destination append failed', {
        kind: 'email_click_redirect_error',
        reason: 'invalid_destination_url',
      });
      return res.status(404).type('text/plain').send('Not found');
    }

    res.set('Cache-Control', 'private, no-store');
    res.redirect(302, location);
    recordEmailClick(supabase, String(looked.impact.id), externalEventId);
    return undefined;
  } catch (_err) {
    return res.status(404).type('text/plain').send('Not found');
  }
});

module.exports = router;
