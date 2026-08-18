'use strict';

/**
 * Janus Assist V0 — tool contract, competitor activity, engine loop.
 * Run: node scripts/test-assist.js
 */

const assert = require('assert');
const {
  isTransientError,
  withTransientRetry,
} = require('../src/assist/toolContract');
const {
  getCompetitorActivity,
  weekBounds,
  TOOL_DEFINITION,
} = require('../src/assist/tools/getCompetitorActivity');
const { runAssistTurn } = require('../src/assist/engine');

function abortErr(msg) {
  const err = new Error(msg || 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function createMockClient(handlers) {
  const calls = { monitored_entities: 0, events: 0 };
  return {
    calls,
    from(table) {
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        in() {
          return q;
        },
        gte() {
          return q;
        },
        lt() {
          return q;
        },
        order() {
          return q;
        },
        range() {
          return q;
        },
        then(resolve, reject) {
          calls[table] = (calls[table] || 0) + 1;
          try {
            const result = handlers[table](calls[table]);
            return Promise.resolve(result).then(resolve, reject);
          } catch (err) {
            return Promise.reject(err).then(resolve, reject);
          }
        },
      };
      return q;
    },
  };
}

async function testTransientHelper() {
  assert.strictEqual(isTransientError(abortErr()), true);
  assert.strictEqual(
    isTransientError(new TypeError('x.slice is not a function')),
    false,
  );
  assert.strictEqual(
    isTransientError(
      Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
    ),
    true,
  );

  let n = 0;
  const retriedOk = await withTransientRetry(async () => {
    n += 1;
    if (n === 1) throw abortErr();
    return 42;
  });
  assert.strictEqual(retriedOk.value, 42);
  assert.strictEqual(retriedOk.retried, true);
  assert.strictEqual(n, 2);

  let logicN = 0;
  let logicThrew = false;
  try {
    await withTransientRetry(async () => {
      logicN += 1;
      throw new TypeError('broken');
    });
  } catch (err) {
    logicThrew = err instanceof TypeError;
  }
  assert.strictEqual(logicThrew, true);
  assert.strictEqual(logicN, 1);
}

async function testActivitySuccess() {
  const now = new Date('2026-08-18T15:00:00.000Z');
  const { thisMon, priorMon } = weekBounds(now);

  const client = createMockClient({
    monitored_entities: () => ({
      data: [
        { id: 'e1', name: 'Banco A' },
        { id: 'e2', name: 'Banco B' },
      ],
      error: null,
    }),
    events: () => ({
      data: [
        {
          id: 'ev1',
          entity_id: 'e1',
          detected_at: thisMon,
          event_type: 'new_ad',
        },
        {
          id: 'ev2',
          entity_id: 'e1',
          detected_at: thisMon,
          event_type: 'new_ad',
        },
        {
          id: 'ev3',
          entity_id: 'e2',
          detected_at: priorMon,
          event_type: 'new_ad',
        },
      ],
      error: null,
    }),
  });

  const result = await getCompetitorActivity({}, { supabase: client, now });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.meta.source_table, 'events');
  assert.ok(result.meta.checked_at);
  const a = result.data.find((r) => r.name === 'Banco A');
  const b = result.data.find((r) => r.name === 'Banco B');
  assert.strictEqual(a.new_ads_this_week, 2);
  assert.strictEqual(a.new_ads_prior_week, 0);
  assert.strictEqual(b.new_ads_this_week, 0);
  assert.strictEqual(b.new_ads_prior_week, 1);
  assert.strictEqual(result.data[0].name, 'Banco A');
}

async function testZerosAreSuccess() {
  const now = new Date('2026-08-18T15:00:00.000Z');
  const client = createMockClient({
    monitored_entities: () => ({
      data: [{ id: 'e1', name: 'Quiet Co' }],
      error: null,
    }),
    events: () => ({ data: [], error: null }),
  });
  const result = await getCompetitorActivity({}, { supabase: client, now });
  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.data, [
    { name: 'Quiet Co', new_ads_this_week: 0, new_ads_prior_week: 0 },
  ]);
}

async function testEmptyEntities() {
  const client = createMockClient({
    monitored_entities: () => ({ data: [], error: null }),
    events: () => {
      throw new Error('events should not be queried when no entities');
    },
  });
  const result = await getCompetitorActivity({}, { supabase: client });
  assert.strictEqual(result.status, 'empty');
  assert.strictEqual(result.data, null);
  assert.strictEqual(client.calls.events, 0);
}

async function testForceToolErrorSkipsQuery() {
  const client = createMockClient({
    monitored_entities: () => {
      throw new Error('should not query when forceToolError');
    },
    events: () => {
      throw new Error('should not query when forceToolError');
    },
  });
  const result = await getCompetitorActivity(
    {},
    { supabase: client, forceToolError: true },
  );
  assert.strictEqual(result.status, 'error');
  assert.match(result.error_message, /Forced tool error/);
  assert.strictEqual(client.calls.monitored_entities, 0);
}

async function testTimeoutRetryThenError() {
  const client = createMockClient({
    monitored_entities: () => {
      throw abortErr('simulated timeout');
    },
    events: () => ({ data: [], error: null }),
  });
  let retried = false;
  const result = await getCompetitorActivity(
    {},
    {
      supabase: client,
      onRetry: () => {
        retried = true;
      },
    },
  );
  assert.strictEqual(result.status, 'error');
  assert.ok(result.error_message);
  assert.strictEqual(retried, true);
  assert.strictEqual(client.calls.monitored_entities, 2);
}

async function testLogicErrorNoRetry() {
  const client = createMockClient({
    monitored_entities: () => {
      throw new TypeError('x.slice is not a function');
    },
    events: () => ({ data: [], error: null }),
  });
  let retried = false;
  const result = await getCompetitorActivity(
    {},
    {
      supabase: client,
      onRetry: () => {
        retried = true;
      },
    },
  );
  assert.strictEqual(result.status, 'error');
  assert.match(result.error_message, /slice is not a function/);
  assert.strictEqual(retried, false);
  assert.strictEqual(client.calls.monitored_entities, 1);
}

async function testEngineLoopAndLog() {
  const now = new Date('2026-08-18T15:00:00.000Z');
  const client = createMockClient({
    monitored_entities: () => ({
      data: [{ id: 'e1', name: 'Quiet Co' }],
      error: null,
    }),
    events: () => ({ data: [], error: null }),
  });

  let calls = 0;
  async function createMessage({ messages, tools }) {
    calls += 1;
    assert.ok(Array.isArray(tools));
    assert.strictEqual(tools[0].name, 'get_competitor_activity');
    if (calls === 1) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_test_1',
            name: 'get_competitor_activity',
            input: {},
          },
        ],
      };
    }
    const last = messages[messages.length - 1];
    assert.strictEqual(last.role, 'user');
    const block = last.content[0];
    assert.strictEqual(block.type, 'tool_result');
    assert.strictEqual(block.tool_use_id, 'toolu_test_1');
    const envelope = JSON.parse(block.content);
    assert.strictEqual(envelope.status, 'success');
    assert.strictEqual(envelope.data[0].new_ads_this_week, 0);
    assert.strictEqual(envelope.retried, false);
    return {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'Quiet Co: 0 anuncios nuevos (dato medido, no ausencia).',
        },
      ],
    };
  }

  const result = await runAssistTurn({
    message: '¿Qué hicieron los competidores?',
    conversationHistory: [],
    createMessage,
    now,
    registry: {
      get_competitor_activity: {
        definition: TOOL_DEFINITION,
        execute: (input, deps) =>
          getCompetitorActivity(input, { ...deps, supabase: client }),
      },
    },
  });

  assert.strictEqual(calls, 2);
  assert.strictEqual(result.stopReason, 'end_turn');
  assert.match(result.reply, /Quiet Co/);
  assert.strictEqual(result.toolExecutions.length, 1);
  const log = result.toolExecutions[0];
  assert.strictEqual(log.tool_name, 'get_competitor_activity');
  assert.strictEqual(log.status, 'success');
  assert.strictEqual(log.retried, false);
  assert.strictEqual(log.error_message, null);
  assert.ok(log.started_at);
  assert.ok(log.finished_at);
}

async function testEngineContinuesAfterToolError() {
  let calls = 0;
  async function createMessage({ messages }) {
    calls += 1;
    if (calls === 1) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_err',
            name: 'get_competitor_activity',
            input: {},
          },
        ],
      };
    }
    const envelope = JSON.parse(
      messages[messages.length - 1].content[0].content,
    );
    assert.strictEqual(envelope.status, 'error');
    assert.strictEqual(envelope.retried, false);
    return {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'No pude confirmar la actividad de competidores: la consulta falló.',
        },
      ],
    };
  }

  const result = await runAssistTurn({
    message: '¿Hubo actividad?',
    createMessage,
    registry: {
      get_competitor_activity: {
        definition: {
          name: 'get_competitor_activity',
          description: 'test',
          input_schema: { type: 'object', properties: {} },
        },
        execute: async () => {
          throw abortErr('db timeout');
        },
      },
    },
  });
  assert.strictEqual(result.stopReason, 'end_turn');
  assert.strictEqual(result.toolExecutions[0].status, 'error');
  assert.match(result.reply, /No pude confirmar/);
}

(async () => {
  await testTransientHelper();
  await testActivitySuccess();
  await testZerosAreSuccess();
  await testEmptyEntities();
  await testForceToolErrorSkipsQuery();
  await testTimeoutRetryThenError();
  await testLogicErrorNoRetry();
  await testEngineLoopAndLog();
  await testEngineContinuesAfterToolError();
  console.log('OK assist unit tests');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
