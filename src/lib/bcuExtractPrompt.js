'use strict';

/**
 * System + user prompts for bcu_v1 vision extract (ported from Stage 0 spike).
 * LLM extracts observed facts only — no ops/retry/Mi Deuda/FX/canonicalization.
 */

const BCU_V1_SYSTEM_PROMPT = [
  'Extract ONLY visible facts from a Uruguayan BCU credit report screenshot.',
  'Return JSON matching the schema. extraction_contract_version must be bcu_v1.',
  '',
  'Rules:',
  '- null means the rubro/value is not shown or not readable. 0 means an explicit zero is visible.',
  '- Do NOT convert missing rubros into 0.',
  '- Do NOT sum MN+ME. Do NOT convert currencies. Do NOT infer FX.',
  '- Do NOT normalize institution names (keep institution_name_raw exactly as printed).',
  '- Do NOT clean or shorten document_ci_raw; copy the visible text as-is.',
  '- Do NOT invent arrastre, origin institution, Retry eligibility, or causal links.',
  '- Do NOT adjust summary numbers to match institutional detail (or vice versa).',
  '- Read currency_view_selected from the document UI/control if visible; else UNKNOWN.',
  '- period should be YYYYMM if that period label is visible; else null.',
  '- category is CALIF (1C,2A,2B,3,4,5) or null if illegible.',
  '- summary is the top summary block, independent of the detail table.',
  '- Put illegible field paths in review.illegible_fields; concrete issues in review.warnings.',
].join('\n');

const BCU_V1_USER_TEXT =
  'Extract the BCU report facts from this image into the bcu_v1 schema.';

module.exports = {
  BCU_V1_SYSTEM_PROMPT,
  BCU_V1_USER_TEXT,
};
