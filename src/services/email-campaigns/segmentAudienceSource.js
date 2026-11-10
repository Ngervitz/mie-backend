'use strict';

/**
 * Audience source for SEGMENT_DRIVEN materialize (declared in segment rules).
 */

const AUDIENCE_SOURCES = Object.freeze({
  ENCUESTAS_SYNCED: 'cz_encuestas_synced',
  FUNNEL_SOLICITUDES: 'cz_funnel_solicitudes',
});

const SOURCE_RULE = Object.freeze({
  field: 'attributes.audience_source',
  operator: '=',
});

/**
 * @param {unknown} rules
 * @returns {string}
 */
function resolveSegmentAudienceSource(rules) {
  if (!Array.isArray(rules)) return AUDIENCE_SOURCES.ENCUESTAS_SYNCED;
  for (let i = 0; i < rules.length; i += 1) {
    const cond = rules[i];
    if (!cond || typeof cond !== 'object') continue;
    if (
      String(cond.field) === SOURCE_RULE.field &&
      String(cond.operator) === SOURCE_RULE.operator &&
      String(cond.value) === AUDIENCE_SOURCES.FUNNEL_SOLICITUDES
    ) {
      return AUDIENCE_SOURCES.FUNNEL_SOLICITUDES;
    }
  }
  return AUDIENCE_SOURCES.ENCUESTAS_SYNCED;
}

module.exports = {
  AUDIENCE_SOURCES,
  resolveSegmentAudienceSource,
};
