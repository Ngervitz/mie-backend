'use strict';
const fs = require('fs');
const path = require('path');
const j = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '_tmp-pre-cutoff-s1-cohort-112.json'),
    'utf8',
  ),
);
const ids = j.cz_ids.map(Number);
const out = [
  "'use strict';",
  '',
  '/**',
  ' * Frozen pre-cutoff survey-invite catch-up cohort (authorized cz_solicitud_id).',
  ' *',
  ' * Source audit: c95ca6a6 / scripts/_tmp-pre-cutoff-s1-cohort-112.json',
  ' * captured_at: ' + j.captured_at,
  ' * cutoff: ' + j.cutoff,
  ' *',
  ' * DO NOT regenerate dynamically at runtime.',
  ' * Distinct from HISTORICAL_PILOT_CZ_IDS (legacy pilot of 10).',
  ' */',
  '',
  'const PRE_CUTOFF_CATCHUP_CZ_IDS = Object.freeze([',
  ...ids.map(function (id, i) {
    return '  ' + id + (i < ids.length - 1 ? ',' : '');
  }),
  ']);',
  '',
  'function isAuthorizedPreCutoffCatchupCzId(czId) {',
  '  const n = Number(czId);',
  '  return PRE_CUTOFF_CATCHUP_CZ_IDS.indexOf(n) !== -1;',
  '}',
  '',
  'module.exports = {',
  '  PRE_CUTOFF_CATCHUP_CZ_IDS,',
  '  isAuthorizedPreCutoffCatchupCzId,',
  '};',
  '',
].join('\n');
fs.writeFileSync(
  path.join(__dirname, '..', 'src/lib/rejectedSurveyInvitePreCutoffCatchupIds.js'),
  out,
);
console.log('wrote', ids.length);
