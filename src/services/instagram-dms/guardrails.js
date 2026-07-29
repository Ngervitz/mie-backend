const supabase = require('../../clients/supabase');

/**
 * Evaluate outbound text against active guardrails.
 * Severity precedence: blocked > confirmation > warning.
 */
async function evaluateGuardrails(messageText) {
  const text = String(messageText || '');
  const textLower = text.toLowerCase();

  const { data, error } = await supabase
    .from('social_message_guardrails')
    .select('*')
    .eq('is_active', true);

  if (error) {
    throw new Error(`guardrails load failed: ${error.message}`);
  }

  const matches = [];
  for (const rule of data || []) {
    const phrase = String(rule.phrase_or_pattern || '');
    if (!phrase) continue;
    let hit = false;
    if (rule.match_type === 'exact') {
      hit = textLower === phrase.toLowerCase();
    } else if (rule.match_type === 'contains') {
      hit = textLower.includes(phrase.toLowerCase());
    }
    if (hit) {
      matches.push({
        id: rule.id,
        phrase_or_pattern: rule.phrase_or_pattern,
        match_type: rule.match_type,
        severity: rule.severity,
        replacement_text: rule.replacement_text,
        explanation: rule.explanation,
      });
    }
  }

  const blocked = matches.filter((m) => m.severity === 'blocked');
  const confirmation = matches.filter((m) => m.severity === 'confirmation');
  const warning = matches.filter((m) => m.severity === 'warning');

  let highestSeverity = null;
  if (blocked.length) highestSeverity = 'blocked';
  else if (confirmation.length) highestSeverity = 'confirmation';
  else if (warning.length) highestSeverity = 'warning';

  return {
    highestSeverity,
    matches,
    blocked,
    confirmation,
    warning,
  };
}

module.exports = { evaluateGuardrails };
