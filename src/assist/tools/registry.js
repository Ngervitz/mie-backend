'use strict';

const {
  TOOL_DEFINITION,
  getCompetitorActivity,
} = require('./getCompetitorActivity');

/**
 * Assist tool registry. Add tools here; the engine looks up by name.
 * not_implemented must be returned by a registered tool's own code, never inferred.
 */
function buildDefaultRegistry() {
  return {
    get_competitor_activity: {
      definition: TOOL_DEFINITION,
      execute: getCompetitorActivity,
    },
  };
}

function anthropicToolDefinitions(registry) {
  return Object.values(registry).map((entry) => entry.definition);
}

module.exports = {
  buildDefaultRegistry,
  anthropicToolDefinitions,
};
