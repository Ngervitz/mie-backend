'use strict';

/**
 * Register elm_callback_invite intent. POST-only write path.
 */

const {
  PURPOSE,
  EVENT_NAME,
  EVENT_SOURCE,
  TRACKING_TOKEN_RE,
  callbackEventExternalId,
} = require('./elmCallbackInvite');

function isUniqueViolation(err) {
  if (!err) return false;
  const code = err.code != null ? String(err.code) : '';
  const msg = err.message != null ? String(err.message) : '';
  return code === '23505' || /duplicate|unique/i.test(msg);
}

async function lookupCallbackImpact(supabase, tokenRaw) {
  const token = String(tokenRaw || '').trim();
  if (!TRACKING_TOKEN_RE.test(token)) {
    return { ok: false, reason: 'invalid_token' };
  }
  const { data: impact, error: impactErr } = await supabase
    .from('marketing_impacts')
    .select('id, tracking_token, channel')
    .eq('tracking_token', token)
    .maybeSingle();
  if (impactErr) {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!impact || String(impact.channel || '') !== 'email') {
    return { ok: false, reason: 'not_found' };
  }
  const { data: recipient, error: recErr } = await supabase
    .from('email_campaign_recipients')
    .select('id, purpose, cz_solicitud_id, ci, marketing_impact_id, email')
    .eq('marketing_impact_id', impact.id)
    .maybeSingle();
  if (recErr) {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!recipient || String(recipient.purpose || '').trim() !== PURPOSE) {
    return { ok: false, reason: 'wrong_purpose' };
  }
  return { ok: true, impact: impact, recipient: recipient };
}

async function findCallbackConfirmed(supabase, impactId) {
  const { data, error } = await supabase
    .from('marketing_impact_events')
    .select('id, impact_id, event_name, external_event_id, occurred_at')
    .eq('source', EVENT_SOURCE)
    .eq('external_event_id', callbackEventExternalId(impactId))
    .maybeSingle();
  if (error) {
    throw new Error('callback event lookup failed: ' + error.message);
  }
  return data || null;
}

async function confirmElmCallback(supabase, tokenRaw) {
  const looked = await lookupCallbackImpact(supabase, tokenRaw);
  if (!looked.ok) return looked;

  const impactId = String(looked.impact.id);
  const existing = await findCallbackConfirmed(supabase, impactId);
  if (existing) {
    return {
      ok: true,
      created: false,
      already: true,
      impact_id: impactId,
      cz_solicitud_id: looked.recipient.cz_solicitud_id,
      ci: looked.recipient.ci,
    };
  }

  const { error } = await supabase.from('marketing_impact_events').insert({
    impact_id: impactId,
    source: EVENT_SOURCE,
    event_name: EVENT_NAME,
    occurred_at: new Date().toISOString(),
    external_event_id: callbackEventExternalId(impactId),
  });
  if (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: true,
        created: false,
        already: true,
        impact_id: impactId,
        cz_solicitud_id: looked.recipient.cz_solicitud_id,
        ci: looked.recipient.ci,
      };
    }
    throw new Error('callback event insert failed: ' + error.message);
  }
  return {
    ok: true,
    created: true,
    already: false,
    impact_id: impactId,
    cz_solicitud_id: looked.recipient.cz_solicitud_id,
    ci: looked.recipient.ci,
  };
}

module.exports = {
  lookupCallbackImpact,
  findCallbackConfirmed,
  confirmElmCallback,
  isUniqueViolation,
};
