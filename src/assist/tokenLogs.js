'use strict';

const logger = require('../lib/logger');

function getDefaultSupabase() {
  return require('../clients/supabase');
}

async function loadTurnNumber(conversationId, client) {
  const db = client || getDefaultSupabase();
  const { data, error } = await db
    .from('assist_turn_token_logs')
    .select('turn_number')
    .eq('conversation_id', conversationId)
    .order('turn_number', { ascending: false })
    .limit(1);
  if (error) {
    logger.warn('assist_turn_token_logs turn_number query failed', {
      error: error.message,
    });
    return 1;
  }
  const max =
    Array.isArray(data) && data[0] && data[0].turn_number != null
      ? Number(data[0].turn_number)
      : 0;
  return Number.isFinite(max) ? max + 1 : 1;
}

async function loadTokenTotals(conversationId, client) {
  const db = client || getDefaultSupabase();
  const { data, error } = await db
    .from('assist_turn_token_logs')
    .select('input_tokens, output_tokens')
    .eq('conversation_id', conversationId);
  if (error) {
    logger.warn('assist_turn_token_logs totals query failed', {
      error: error.message,
    });
    return { input: 0, output: 0 };
  }
  let input = 0;
  let output = 0;
  for (const row of data || []) {
    input += Number(row.input_tokens) || 0;
    output += Number(row.output_tokens) || 0;
  }
  return { input, output };
}

async function saveTokenLog(row, client) {
  const db = client || getDefaultSupabase();
  const { error } = await db.from('assist_turn_token_logs').insert({
    conversation_id: row.conversation_id,
    turn_number: row.turn_number,
    call_index: row.call_index,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    conversation_context_tokens_estimated:
      row.conversation_context_tokens_estimated,
    conversation_input_tokens_total: row.conversation_input_tokens_total,
    conversation_output_tokens_total: row.conversation_output_tokens_total,
  });
  if (error) {
    logger.warn('assist_turn_token_logs insert failed', {
      error: error.message,
    });
  }
}

module.exports = {
  loadTurnNumber,
  loadTokenTotals,
  saveTokenLog,
};
