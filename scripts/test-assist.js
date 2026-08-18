'use strict';

/**
 * Janus Assist V0 — tool contract, competitor activity, engine loop,
 * budgets, entity match, memory protocol.
 * Run: node scripts/test-assist.js
 */

const assert = require('assert');
const {
  isTransientError,
  withTransientRetry,
  success,
} = require('../src/assist/toolContract');
const {
  getCompetitorActivity,
  weekBounds,
  applyActivityPayload,
  UNFILTERED_TOP_N,
  TOOL_DEFINITION,
} = require('../src/assist/tools/getCompetitorActivity');
const {
  runAssistTurn,
  resolveConversationId,
  cacheKey,
} = require('../src/assist/engine');
const {
  AssistExecutionBudget,
  estimateContextTokens,
  wouldExceedContextBudget,
} = require('../src/assist/budget');
const {
  matchKnownEntities,
  normalizeForMatch,
  nameAppearsInText,
} = require('../src/assist/entityMatch');
const {
  historicalArgsForTool,
  entityNamesForIndex,
} = require('../src/assist/memories');

function isolatedEngineOpts(extra) {
  return Object.assign(
    {
      loadActiveCompetitorNames: async () => [],
      loadMemoriesForEntities: async () => [],
      saveMemoryRecord: async () => 'mem-test',
      saveTokenLog: async () => {},
      loadTurnNumber: async () => 1,
      loadTokenTotals: async () => ({ input: 0, output: 0 }),
    },
    extra || {},
  );
}

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
        limit() {
          return q;
        },
        insert() {
          return q;
        },
        single() {
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
    ...isolatedEngineOpts(),
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
    ...isolatedEngineOpts(),
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

function activityRow(name, thisWeek, priorWeek) {
  return {
    name,
    new_ads_this_week: thisWeek,
    new_ads_prior_week: priorWeek,
  };
}

async function testBudgetConstantsAndEstimator() {
  assert.strictEqual(AssistExecutionBudget.max_tool_rounds, 4);
  assert.strictEqual(AssistExecutionBudget.max_tool_executions, 6);
  assert.strictEqual(AssistExecutionBudget.max_context_tokens, 40000);
  assert.strictEqual(AssistExecutionBudget.reserved_final_response_tokens, 4000);

  const payload = {
    system: 'abc',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [{ name: 'get_competitor_activity' }],
  };
  const json = JSON.stringify({
    system: payload.system,
    messages: payload.messages,
    tools: payload.tools,
  });
  const expected = Math.ceil(Buffer.byteLength(json, 'utf8') / 4);
  assert.strictEqual(estimateContextTokens(payload), expected);
  assert.ok(estimateContextTokens({ ...payload, tools: [] }) < expected);

  const over = wouldExceedContextBudget(payload, {
    max_context_tokens: expected + 10,
    reserved_final_response_tokens: 20,
  });
  assert.strictEqual(over.exceed, true);
  assert.strictEqual(over.used, expected);
}

async function testCacheKeyNoSemanticNormalize() {
  assert.strictEqual(
    cacheKey('get_competitor_activity', {}),
    cacheKey('get_competitor_activity', {}),
  );
  assert.notStrictEqual(
    cacheKey('t', { a: 1, b: 2 }),
    cacheKey('t', { b: 2, a: 1 }),
  );
}

async function testActivityEntityFilterAndTruncation() {
  const rows = [];
  for (let i = 0; i < 35; i += 1) {
    rows.push(activityRow(`Comp ${String(i).padStart(2, '0')}`, 35 - i, 0));
  }
  const unfiltered = applyActivityPayload(rows, {});
  assert.strictEqual(unfiltered.truncated, true);
  assert.strictEqual(unfiltered.total_available, 35);
  assert.strictEqual(unfiltered.rows.length, UNFILTERED_TOP_N);
  assert.strictEqual(unfiltered.rows[0].name, 'Comp 00');
  assert.strictEqual(unfiltered.rows[29].name, 'Comp 29');
  assert.ok(!unfiltered.rows.find((r) => r.name === 'Comp 34'));

  const filtered = applyActivityPayload(rows, { entity: 'Comp 34' });
  assert.strictEqual(filtered.truncated, false);
  assert.strictEqual(filtered.rows.length, 1);
  assert.strictEqual(filtered.rows[0].name, 'Comp 34');

  const miss = applyActivityPayload(rows, { entity: 'No Existe' });
  assert.deepStrictEqual(miss.rows, []);
  assert.strictEqual(miss.truncated, false);

  const sameDelta = applyActivityPayload(
    [
      activityRow('Zeta', 2, 0),
      activityRow('Alfa', 5, 3),
      activityRow('Beta', 9, 7),
    ],
    {},
  );
  assert.deepStrictEqual(
    sameDelta.rows.map((r) => r.name),
    ['Beta', 'Alfa', 'Zeta'],
  );
}

async function testActivityFilterMissIsSuccessNotEmpty() {
  const now = new Date('2026-08-18T15:00:00.000Z');
  const client = createMockClient({
    monitored_entities: () => ({
      data: [{ id: 'e1', name: 'Quiet Co' }],
      error: null,
    }),
    events: () => ({ data: [], error: null }),
  });
  const result = await getCompetitorActivity(
    { entity: 'Pass Card' },
    { supabase: client, now },
  );
  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.data, []);
  assert.strictEqual(result.meta.truncated, undefined);

  const truncated = await getCompetitorActivity(
    {},
    {
      supabase: createMockClient({
        monitored_entities: () => ({
          data: Array.from({ length: 31 }, (_, i) => ({
            id: `e${i}`,
            name: `N${String(i).padStart(2, '0')}`,
          })),
          error: null,
        }),
        events: () => ({ data: [], error: null }),
      }),
      now,
    },
  );
  assert.strictEqual(truncated.status, 'success');
  assert.strictEqual(truncated.data.length, 30);
  assert.strictEqual(truncated.meta.truncated, true);
  assert.strictEqual(truncated.meta.total_available, 31);
}

async function testEntityWordBoundaryAndAccents() {
  const known = ['ASI', 'OCA', 'ANDA', 'Prex', 'Pass Card', 'Pago Después'];
  assert.deepStrictEqual(matchKnownEntities('casi nadie movió nada', known), []);
  assert.deepStrictEqual(matchKnownEntities('poca actividad hoy', known), []);
  assert.deepStrictEqual(matchKnownEntities('mandar datos', known), []);
  assert.deepStrictEqual(
    matchKnownEntities('qué hizo ASI esta semana', known),
    ['ASI'],
  );
  assert.deepStrictEqual(
    matchKnownEntities('Pass Card vs el resto', known),
    ['Pass Card'],
  );
  assert.deepStrictEqual(
    matchKnownEntities('pago despues subió anuncios', known),
    ['Pago Después'],
  );
  assert.strictEqual(normalizeForMatch('Pago Después'), 'pago despues');
  assert.strictEqual(nameAppearsInText('pago despues hoy', 'Pago Después'), true);
}

async function testHistoricalArgsEntityWins() {
  const memory = {
    evidence: [
      {
        tool_name: 'get_competitor_activity',
        tool_args: { entity: 'WRONG', window: 'w1' },
      },
    ],
  };
  const hist = historicalArgsForTool(memory, 'get_competitor_activity');
  assert.deepStrictEqual(hist, { entity: 'WRONG', window: 'w1' });
  const forced = { ...hist, entity: 'Pass Card' };
  assert.deepStrictEqual(forced, { entity: 'Pass Card', window: 'w1' });
}

async function testIndexUsesRealNamesNotNormalized() {
  const conclusion = 'pago despues subió y pass card bajó';
  const envelopes = [
    success(
      [
        activityRow('Pago Después', 4, 1),
        activityRow('Pass Card', 0, 2),
      ],
      'events',
    ),
  ];
  const names = entityNamesForIndex(conclusion, envelopes);
  assert.ok(names.includes('Pago Después'));
  assert.ok(names.includes('Pass Card'));
  assert.ok(!names.includes('pago despues'));
}

async function testConversationIdEchoOrGenerate() {
  const given = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.strictEqual(resolveConversationId(given), given);
  const gen = resolveConversationId(null);
  assert.match(
    gen,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
}

function stubActivityExecute(calls) {
  return {
    definition: TOOL_DEFINITION,
    execute: async (input) => {
      calls.push(JSON.parse(JSON.stringify(input || {})));
      return success(
        [activityRow('Pass Card', 3, 1)],
        'events',
      );
    },
  };
}

async function testEngineDedupeDoesNotReexecute() {
  const executeCalls = [];
  let calls = 0;
  async function createMessage({ maxTokens }) {
    calls += 1;
    assert.strictEqual(maxTokens, 4000);
    if (calls === 1) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'u1',
            name: 'get_competitor_activity',
            input: {},
          },
        ],
      };
    }
    if (calls === 2) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'u2',
            name: 'get_competitor_activity',
            input: {},
          },
        ],
      };
    }
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Pass Card: 3 (dato medido).' }],
    };
  }

  const result = await runAssistTurn({
    ...isolatedEngineOpts(),
    message: 'actividad',
    createMessage,
    registry: { get_competitor_activity: stubActivityExecute(executeCalls) },
  });
  assert.strictEqual(executeCalls.length, 1);
  assert.strictEqual(result.toolExecutionsUsed, 1);
  assert.strictEqual(result.toolRoundsUsed, 2);
  assert.strictEqual(result.toolExecutions.filter((e) => !e.from_cache).length, 1);
}

async function testEngineToolBudgetEmitsEventAndModelReplies() {
  const executeCalls = [];
  async function createMessage({ tools, system }) {
    if (tools && tools.length) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: `u${executeCalls.length}`,
            name: 'get_competitor_activity',
            input: { n: executeCalls.length },
          },
        ],
      };
    }
    assert.match(system, /tool_budget_exhausted/);
    return {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'Cierro por tool_budget_exhausted. No inventé el resto.',
        },
      ],
    };
  }

  const result = await runAssistTurn({
    ...isolatedEngineOpts(),
    message: 'seguí pidiendo datos',
    createMessage,
    registry: { get_competitor_activity: stubActivityExecute(executeCalls) },
  });
  assert.strictEqual(executeCalls.length, 4);
  assert.strictEqual(result.toolRoundsUsed, 4);
  assert.strictEqual(result.budgetEvents[0].type, 'tool_budget_exhausted');
  assert.match(result.reply, /tool_budget_exhausted/);
}

async function testEngineContextBudgetFallsBackWithoutClaude() {
  let claudeCalls = 0;
  async function createMessage() {
    claudeCalls += 1;
    throw new Error('should not call Claude when first request already exceeds');
  }
  const result = await runAssistTurn({
    ...isolatedEngineOpts(),
    message: 'hola',
    createMessage,
    budget: {
      max_tool_rounds: 4,
      max_tool_executions: 6,
      max_context_tokens: 20,
      reserved_final_response_tokens: 10,
    },
    registry: { get_competitor_activity: stubActivityExecute([]) },
  });
  assert.strictEqual(claudeCalls, 0);
  assert.strictEqual(result.stopReason, 'context_budget_exhausted');
  assert.strictEqual(result.budgetEvents[0].type, 'context_budget_exhausted');
  assert.match(result.reply, /presupuesto de contexto/);
}

async function testMemoryForcedUsesIndexedEntityNotSnapshotArgs() {
  const executeCalls = [];
  const captured = [];
  async function createMessage({ system, messages, tools }) {
    captured.push({ system, messages, tools: tools || [] });
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Pass Card hoy: 3 anuncios (dato medido).' }],
    };
  }

  const result = await runAssistTurn({
    ...isolatedEngineOpts({
      loadActiveCompetitorNames: async () => ['Pass Card', 'ASI'],
      loadMemoriesForEntities: async (names) => {
        assert.deepStrictEqual(names, ['Pass Card']);
        return [
          {
            entityName: 'Pass Card',
            memory: {
              id: 'm1',
              conclusion: 'Pass Card estaba fuerte',
              created_at: '2026-08-01T00:00:00.000Z',
              evidence: [
                {
                  tool_name: 'get_competitor_activity',
                  tool_args: {},
                  tool_result_snapshot: { status: 'success', data: [] },
                },
              ],
            },
          },
        ];
      },
    }),
    message: 'qué hace pass card ahora',
    createMessage,
    registry: { get_competitor_activity: stubActivityExecute(executeCalls) },
  });

  assert.deepStrictEqual(executeCalls[0], { entity: 'Pass Card' });
  assert.strictEqual(result.toolExecutionsUsed, 1);
  assert.strictEqual(result.toolRoundsUsed, 0);
  assert.strictEqual(result.toolExecutions[0].forced_by_memory, true);

  const first = captured[0];
  assert.ok(first.tools.length > 0);
  assert.match(first.system, /MEMORIA ANALÍTICA/);
  assert.match(first.system, /no un tool_result/);
  const serialized = JSON.stringify(first.messages);
  assert.ok(!serialized.includes('tool_result'));
  assert.ok(!serialized.includes('"type":"tool_use"'));
}

async function testMemoryForcedMergesHistButEntityWins() {
  const executeCalls = [];
  async function createMessage() {
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    };
  }
  await runAssistTurn({
    ...isolatedEngineOpts({
      loadActiveCompetitorNames: async () => ['Pass Card'],
      loadMemoriesForEntities: async () => [
        {
          entityName: 'Pass Card',
          memory: {
            id: 'm2',
            conclusion: 'hist',
            created_at: '2026-08-01T00:00:00.000Z',
            evidence: [
              {
                tool_name: 'get_competitor_activity',
                tool_args: { entity: 'WRONG', window: 'w1' },
              },
            ],
          },
        },
      ],
    }),
    message: 'Pass Card',
    createMessage,
    registry: { get_competitor_activity: stubActivityExecute(executeCalls) },
  });
  assert.deepStrictEqual(executeCalls[0], { entity: 'Pass Card', window: 'w1' });
}

async function testMemoryDedupeServesRealToolResultLater() {
  const executeCalls = [];
  let calls = 0;
  async function createMessage({ messages }) {
    calls += 1;
    if (calls === 1) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'real_use',
            name: 'get_competitor_activity',
            input: { entity: 'Pass Card' },
          },
        ],
      };
    }
    const block = messages[messages.length - 1].content[0];
    assert.strictEqual(block.type, 'tool_result');
    assert.strictEqual(block.tool_use_id, 'real_use');
    const envelope = JSON.parse(block.content);
    assert.strictEqual(envelope.status, 'success');
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Pass Card: 3.' }],
    };
  }

  const result = await runAssistTurn({
    ...isolatedEngineOpts({
      loadActiveCompetitorNames: async () => ['Pass Card'],
      loadMemoriesForEntities: async () => [
        {
          entityName: 'Pass Card',
          memory: {
            id: 'm3',
            conclusion: 'old',
            created_at: '2026-08-01T00:00:00.000Z',
            evidence: [{ tool_name: 'get_competitor_activity', tool_args: {} }],
          },
        },
      ],
    }),
    message: 'Pass Card otra vez',
    createMessage,
    registry: { get_competitor_activity: stubActivityExecute(executeCalls) },
  });
  assert.strictEqual(executeCalls.length, 1);
  assert.strictEqual(result.toolExecutionsUsed, 1);
  assert.strictEqual(result.toolRoundsUsed, 1);
}

async function testMemoryToolAbsentMarksUnverifiable() {
  const captured = [];
  async function createMessage({ system }) {
    captured.push(system);
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'sin tool' }],
    };
  }
  const result = await runAssistTurn({
    ...isolatedEngineOpts({
      loadActiveCompetitorNames: async () => ['Pass Card'],
      loadMemoriesForEntities: async () => [
        {
          entityName: 'Pass Card',
          memory: {
            id: 'm4',
            conclusion: 'old',
            created_at: '2026-08-01T00:00:00.000Z',
            evidence: [],
          },
        },
      ],
    }),
    message: 'Pass Card',
    createMessage,
    registry: {},
  });
  assert.strictEqual(result.toolExecutionsUsed, 0);
  assert.match(captured[0], /evidencia histórica sin verificación disponible hoy/);
}

async function testTokenLogsAndConversationIdOnTurn() {
  const logs = [];
  const persisted = [];
  async function createMessage() {
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hola' }],
      usage: { input_tokens: 11, output_tokens: 7 },
    };
  }
  const cid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const result = await runAssistTurn({
    ...isolatedEngineOpts({
      saveTokenLog: async (row) => {
        logs.push(row);
      },
      saveMemoryRecord: async (row) => {
        persisted.push(row);
        return 'mem';
      },
      loadTurnNumber: async () => 4,
    }),
    conversationId: cid,
    message: 'hola',
    createMessage,
    registry: {
      get_competitor_activity: stubActivityExecute([]),
    },
  });
  assert.strictEqual(result.conversationId, cid);
  assert.strictEqual(result.turnNumber, 4);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].conversation_id, cid);
  assert.strictEqual(logs[0].turn_number, 4);
  assert.strictEqual(logs[0].call_index, 0);
  assert.strictEqual(logs[0].input_tokens, 11);
  assert.strictEqual(logs[0].output_tokens, 7);
  assert.strictEqual(persisted.length, 0);
}

async function testCasiDoesNotMatchAsiInEngineRecall() {
  let loadedWith = null;
  async function createMessage() {
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'sin recall' }],
    };
  }
  await runAssistTurn({
    ...isolatedEngineOpts({
      loadActiveCompetitorNames: async () => ['ASI', 'OCA'],
      loadMemoriesForEntities: async (names) => {
        loadedWith = names;
        return [];
      },
    }),
    message: 'casi no hubo cambios',
    createMessage,
    registry: { get_competitor_activity: stubActivityExecute([]) },
  });
  assert.deepStrictEqual(loadedWith, []);
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
  await testBudgetConstantsAndEstimator();
  await testCacheKeyNoSemanticNormalize();
  await testActivityEntityFilterAndTruncation();
  await testActivityFilterMissIsSuccessNotEmpty();
  await testEntityWordBoundaryAndAccents();
  await testHistoricalArgsEntityWins();
  await testIndexUsesRealNamesNotNormalized();
  await testConversationIdEchoOrGenerate();
  await testEngineDedupeDoesNotReexecute();
  await testEngineToolBudgetEmitsEventAndModelReplies();
  await testEngineContextBudgetFallsBackWithoutClaude();
  await testMemoryForcedUsesIndexedEntityNotSnapshotArgs();
  await testMemoryForcedMergesHistButEntityWins();
  await testMemoryDedupeServesRealToolResultLater();
  await testMemoryToolAbsentMarksUnverifiable();
  await testTokenLogsAndConversationIdOnTurn();
  await testCasiDoesNotMatchAsiInEngineRecall();
  console.log('OK assist unit tests');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
