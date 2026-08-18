'use strict';

const logger = require('../lib/logger');
const { nameAppearsInText } = require('./entityMatch');

const MAX_MEMORIES_PER_ENTITY = 3;
const MAX_MEMORIES_PER_TURN = 6;

function getDefaultSupabase() {
  return require('../clients/supabase');
}

async function loadActiveCompetitorNames(client) {
  const db = client || getDefaultSupabase();
  const { data, error } = await db
    .from('monitored_entities')
    .select('name')
    .eq('is_self', false)
    .eq('active', true);
  if (error) {
    throw new Error(error.message || 'failed to load competitor names');
  }
  const names = [];
  const seen = new Set();
  for (const row of data || []) {
    const name = row && row.name != null ? String(row.name).trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Latest memories indexed by the given real entity names.
 * 3 per entity, then global cap 6 by created_at DESC.
 * @returns {Promise<Array<{ memory: object, entityName: string }>>}
 */
async function loadMemoriesForEntities(entityNames, client) {
  const names = Array.isArray(entityNames)
    ? entityNames.filter((n) => n && String(n).trim())
    : [];
  if (!names.length) return [];
  const db = client || getDefaultSupabase();

  const { data: indexRows, error: indexErr } = await db
    .from('assist_memory_entities')
    .select('memory_id, entity_name')
    .in('entity_name', names);
  if (indexErr) {
    throw new Error(indexErr.message || 'failed to load memory index');
  }
  const ids = [
    ...new Set(
      (indexRows || [])
        .map((r) => r && r.memory_id)
        .filter(Boolean)
        .map(String),
    ),
  ];
  if (!ids.length) return [];

  const { data: memRows, error: memErr } = await db
    .from('assist_memories')
    .select('id, conversation_id, conclusion, created_at, evidence')
    .in('id', ids)
    .order('created_at', { ascending: false });
  if (memErr) {
    throw new Error(memErr.message || 'failed to load memories');
  }

  const byId = new Map();
  for (const row of memRows || []) {
    if (row && row.id) byId.set(String(row.id), row);
  }

  const perEntity = new Map();
  for (const name of names) {
    const forName = (indexRows || [])
      .filter((r) => r && r.entity_name === name && r.memory_id)
      .map((r) => byId.get(String(r.memory_id)))
      .filter(Boolean)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, MAX_MEMORIES_PER_ENTITY);
    perEntity.set(name, forName);
  }

  /** @type {Array<{ memory: object, entityName: string }>} */
  const pairs = [];
  const seenMem = new Set();
  const all = [];
  for (const [entityName, list] of perEntity.entries()) {
    for (const memory of list) {
      all.push({ memory, entityName, created_at: memory.created_at });
    }
  }
  all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const item of all) {
    const mid = String(item.memory.id);
    if (seenMem.has(mid)) continue;
    seenMem.add(mid);
    pairs.push({ memory: item.memory, entityName: item.entityName });
    if (pairs.length >= MAX_MEMORIES_PER_TURN) break;
  }
  return pairs;
}

function historicalArgsForTool(memory, toolName) {
  const evidence = memory && Array.isArray(memory.evidence) ? memory.evidence : [];
  const hit = evidence.find(
    (e) => e && e.tool_name === toolName && e.tool_args && typeof e.tool_args === 'object',
  );
  if (hit && hit.tool_args && !Array.isArray(hit.tool_args)) {
    return { ...hit.tool_args };
  }
  const any = evidence.find((e) => e && e.tool_name === toolName);
  if (any && any.tool_args && typeof any.tool_args === 'object' && !Array.isArray(any.tool_args)) {
    return { ...any.tool_args };
  }
  return {};
}

function entityNamesForIndex(conclusion, successEnvelopes) {
  const names = new Set();
  const mentioned = [];
  for (const env of successEnvelopes) {
    const rows = env && Array.isArray(env.data) ? env.data : [];
    for (const row of rows) {
      const name = row && row.name != null ? String(row.name) : '';
      if (name) mentioned.push(name);
    }
  }
  for (const name of mentioned) {
    if (nameAppearsInText(conclusion, name)) names.add(name);
  }
  if (names.size === 0) {
    for (const env of successEnvelopes) {
      const rows = env && Array.isArray(env.data) ? env.data : [];
      for (const row of rows) {
        const name = row && row.name != null ? String(row.name) : '';
        if (!name) continue;
        const delta = Math.abs(
          Number(row.new_ads_this_week || 0) - Number(row.new_ads_prior_week || 0),
        );
        if (delta > 0) names.add(name);
      }
    }
  }
  return [...names];
}

async function saveMemoryRecord(
  { conversationId, conclusion, evidence, entityNames },
  client,
) {
  const db = client || getDefaultSupabase();
  const { data, error } = await db
    .from('assist_memories')
    .insert({
      conversation_id: conversationId,
      conclusion,
      evidence,
    })
    .select('id')
    .single();
  if (error) {
    throw new Error(error.message || 'failed to insert assist_memories');
  }
  const memoryId = data && data.id;
  const names = Array.isArray(entityNames)
    ? [...new Set(entityNames.filter(Boolean).map((n) => String(n)))]
    : [];
  if (memoryId && names.length) {
    const { error: idxErr } = await db.from('assist_memory_entities').insert(
      names.map((entity_name) => ({ memory_id: memoryId, entity_name })),
    );
    if (idxErr) {
      logger.warn('assist_memory_entities insert failed', {
        error: idxErr.message,
      });
    }
  }
  return memoryId;
}

module.exports = {
  MAX_MEMORIES_PER_ENTITY,
  MAX_MEMORIES_PER_TURN,
  loadActiveCompetitorNames,
  loadMemoriesForEntities,
  historicalArgsForTool,
  entityNamesForIndex,
  saveMemoryRecord,
};
