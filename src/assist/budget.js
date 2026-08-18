'use strict';

/**
 * Product budgets for one Assist turn (not a monetary cap).
 * Token estimate is chars/4 of the JSON payload (system+messages+tools)
 * plus reserved_final_response_tokens — not a tokenizer.
 */
const AssistExecutionBudget = Object.freeze({
  max_tool_rounds: 4,
  max_tool_executions: 6,
  max_context_tokens: 40000,
  reserved_final_response_tokens: 4000,
});

/** Above product caps; loop must not run forever if counters fail. */
const RUNAWAY_GUARD_MAX_CLAUDE_CALLS = 16;

/**
 * @param {{ system?: string, messages?: object[], tools?: object[] }} parts
 * @returns {number}
 */
function estimateContextTokens(parts) {
  const payload = JSON.stringify({
    system: parts && parts.system ? parts.system : '',
    messages: parts && parts.messages ? parts.messages : [],
    tools: parts && Array.isArray(parts.tools) ? parts.tools : [],
  });
  return Math.ceil(Buffer.byteLength(payload, 'utf8') / 4);
}

function wouldExceedContextBudget(parts, budget) {
  const b = budget || AssistExecutionBudget;
  const used = estimateContextTokens(parts);
  return {
    used,
    exceed: used + b.reserved_final_response_tokens > b.max_context_tokens,
  };
}

module.exports = {
  AssistExecutionBudget,
  RUNAWAY_GUARD_MAX_CLAUDE_CALLS,
  estimateContextTokens,
  wouldExceedContextBudget,
};
