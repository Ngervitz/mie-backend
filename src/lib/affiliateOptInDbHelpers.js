'use strict';

const { parseCi } = require('./affiliateDirectory');

function schemaMissing(err) {
  const code = err && err.code != null ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : '';
  return code === '42703' || code === '42P01' || /does not exist/i.test(msg);
}

async function ciExistsInFunnel(supabase, ci) {
  const { data, error } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id')
    .eq('ci', ci)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

module.exports = {
  schemaMissing,
  ciExistsInFunnel,
  parseCi,
};
