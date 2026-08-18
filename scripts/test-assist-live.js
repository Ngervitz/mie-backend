'use strict';

/**
 * Live smoke: get_competitor_activity against Supabase + optional Assist turn.
 * Run: node scripts/test-assist-live.js
 *
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY only (does not boot env.js).
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const {
  getCompetitorActivity,
} = require('../src/assist/tools/getCompetitorActivity');
const { runAssistTurn } = require('../src/assist/engine');
const { resolveAssistAnthropicConfig } = require('../src/assist/anthropicClient');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key);

(async () => {
  const toolResult = await getCompetitorActivity({}, { supabase });
  console.log('--- get_competitor_activity ---');
  console.log(JSON.stringify(toolResult, null, 2));

  const cfg = resolveAssistAnthropicConfig();
  if (!cfg) {
    console.log('SKIP live Assist turn: ANTHROPIC_API_KEY not set');
    return;
  }

  const request = {
    message:
      '¿Qué competidores publicaron anuncios nuevos la última semana completa, comparado con la anterior? Si no pudiste confirmar algo, decilo.',
    conversationHistory: [],
  };
  const result = await runAssistTurn({
    ...request,
    registry: {
      get_competitor_activity: {
        definition: require('../src/assist/tools/getCompetitorActivity')
          .TOOL_DEFINITION,
        execute: (input, deps) =>
          getCompetitorActivity(input, { ...deps, supabase }),
      },
    },
  });
  const httpShape = {
    reply: result.reply,
    stopReason: result.stopReason,
    toolExecutions: result.toolExecutions,
    rounds: result.rounds,
  };
  console.log('--- POST /assist/chat equivalent (debug:true) ---');
  console.log(JSON.stringify({ request, response: httpShape }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
