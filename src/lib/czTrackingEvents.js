'use strict';

const logger = require('./logger');

const SOURCE = 'credizona';
const TRACKING_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const ALLOWED_EVENT_NAMES = Object.freeze([
  'form_step_1',
  'form_step_2',
  'form_step_3',
]);
const ALLOWED_EVENT_NAME_SET = new Set(ALLOWED_EVENT_NAMES);
const EXTERNAL_EVENT_ID_MAX = 64;

function isUniqueViolation(error) {
  if (!error) return false;
  if (String(error.code || '') === '23505') return true;
  if (Number(error.status) === 409) return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('duplicate') || msg.includes('unique');
}

function tokenSuffix(token) {
  const raw = String(token || '');
  if (raw.length < 4) return null;
  return raw.slice(-4);
}

function parseTrackingEventBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid_body', reason: 'invalid_body' };
  }

  const event_name =
    typeof body.event_name === 'string' ? body.event_name.trim() : '';
  if (!ALLOWED_EVENT_NAME_SET.has(event_name)) {
    return { error: 'invalid_event_name', reason: 'invalid_event_name' };
  }

  const occurred_at_raw =
    typeof body.occurred_at === 'string' ? body.occurred_at.trim() : '';
  const occurredMs = Date.parse(occurred_at_raw);
  if (!occurred_at_raw || !Number.isFinite(occurredMs)) {
    return { error: 'invalid_occurred_at', reason: 'invalid_occurred_at' };
  }

  const external_event_id =
    typeof body.external_event_id === 'string'
      ? body.external_event_id.trim()
      : '';
  if (
    !external_event_id ||
    external_event_id.length > EXTERNAL_EVENT_ID_MAX ||
    /[\x00-\x1f]/.test(external_event_id)
  ) {
    return {
      error: 'invalid_external_event_id',
      reason: 'invalid_external_event_id',
    };
  }

  const tracking_token =
    typeof body.tracking_token === 'string' ? body.tracking_token.trim() : '';
  if (!TRACKING_TOKEN_RE.test(tracking_token)) {
    return {
      error: 'invalid_tracking_token',
      reason: 'token_malformed',
    };
  }

  return {
    error: null,
    value: {
      tracking_token: tracking_token,
      event_name: event_name,
      occurred_at: new Date(occurredMs).toISOString(),
      external_event_id: external_event_id,
    },
  };
}

async function ingestCredizonaTrackingEvent(supabase, parsed, requestId) {
  const suffix = tokenSuffix(parsed.tracking_token);
  const baseMeta = {
    kind: 'cz_tracking_event',
    request_id: requestId,
    event_name: parsed.event_name,
    external_event_id: parsed.external_event_id,
    token_suffix: suffix,
  };

  const { data: impact, error: lookupErr } = await supabase
    .from('marketing_impacts')
    .select('id')
    .eq('tracking_token', parsed.tracking_token)
    .maybeSingle();

  if (lookupErr) {
    logger.error('CZ tracking event impact lookup failed', {
      ...baseMeta,
      reason: 'lookup_failed',
    });
    return { status: 503, error: 'unavailable', duplicate: false };
  }
  if (!impact || !impact.id) {
    logger.warn('CZ tracking event token not found', {
      ...baseMeta,
      reason: 'token_not_found',
    });
    return { status: 422, error: 'invalid_tracking_token', duplicate: false };
  }

  const row = {
    impact_id: String(impact.id),
    source: SOURCE,
    event_name: parsed.event_name,
    occurred_at: parsed.occurred_at,
    external_event_id: parsed.external_event_id,
  };

  const { error: insertErr } = await supabase
    .from('marketing_impact_events')
    .insert(row);

  if (!insertErr) {
    logger.info('CZ tracking event accepted', {
      ...baseMeta,
      reason: 'accepted',
    });
    return { status: 200, error: null, duplicate: false };
  }

  if (!isUniqueViolation(insertErr)) {
    logger.error('CZ tracking event insert failed', {
      ...baseMeta,
      reason: 'insert_failed',
    });
    return { status: 503, error: 'unavailable', duplicate: false };
  }

  const { data: existing, error: selErr } = await supabase
    .from('marketing_impact_events')
    .select('impact_id, event_name, occurred_at')
    .eq('source', SOURCE)
    .eq('external_event_id', parsed.external_event_id)
    .maybeSingle();

  if (selErr || !existing) {
    logger.error('CZ tracking event conflict lookup failed', {
      ...baseMeta,
      reason: 'lookup_failed',
    });
    return { status: 503, error: 'unavailable', duplicate: false };
  }

  const sameImpact = String(existing.impact_id) === row.impact_id;
  const sameEvent = String(existing.event_name) === row.event_name;
  if (sameImpact && sameEvent) {
    const existingOccurred =
      existing.occurred_at != null ? String(existing.occurred_at) : '';
    if (existingOccurred && existingOccurred !== row.occurred_at) {
      logger.warn('CZ tracking event occurred_at mismatch on retry', {
        ...baseMeta,
        reason: 'occurred_at_mismatch',
      });
    } else {
      logger.info('CZ tracking event duplicate', {
        ...baseMeta,
        reason: 'duplicate',
      });
    }
    return { status: 200, error: null, duplicate: true };
  }

  logger.warn('CZ tracking event external_event_id conflict', {
    ...baseMeta,
    reason: 'external_event_id_conflict',
  });
  return {
    status: 409,
    error: 'external_event_id_conflict',
    duplicate: false,
  };
}

module.exports = {
  SOURCE,
  TRACKING_TOKEN_RE,
  ALLOWED_EVENT_NAMES,
  parseTrackingEventBody,
  ingestCredizonaTrackingEvent,
  isUniqueViolation,
};
