'use strict';

/**
 * Resolve SMS destination phone for a CI from funnel solicitudes (server-side only).
 */

const { parseCi } = require('./affiliateDirectory');

function normalizeDigits(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '');
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} ci
 */
async function resolveAffiliateSmsPhone(supabase, ci) {
  const parsed = parseCi(ci);
  if (parsed == null) return null;

  const { data, error } = await supabase
    .from('cz_funnel_solicitudes')
    .select('celular, updated_at_src, synced_at, fecha_reg')
    .eq('ci', parsed)
    .order('updated_at_src', { ascending: false, nullsFirst: false })
    .limit(5);

  if (error) throw error;
  const rows = data || [];
  let best = null;
  let bestTs = -1;
  rows.forEach(function (row) {
    const digits = normalizeDigits(row.celular);
    if (digits.length < 8) return;
    const ts = Math.max(
      Date.parse(String(row.updated_at_src || '')) || 0,
      Date.parse(String(row.synced_at || '')) || 0,
      Date.parse(String(row.fecha_reg || '')) || 0,
    );
    if (!best || ts >= bestTs) {
      best = digits;
      bestTs = ts;
    }
  });
  return best;
}

module.exports = {
  normalizeDigits,
  resolveAffiliateSmsPhone,
};
