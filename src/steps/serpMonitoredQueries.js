'use strict';

const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { normalizeSearchTerm } = require('./collectGoogleSerpImports');

/** Provenance for Keywords queued from the SERP catalog into Pendientes. */
const SERP_MONITORED_TERM_SOURCE_SEED = 'serp_monitored_term';

function isUniqueViolation(error) {
  if (!error) return false;
  if (String(error.code || '') === '23505') return true;
  return /duplicate|unique/i.test(String(error.message || ''));
}

function mapExistingTermOutcome(row) {
  const decision = row && row.decision != null ? String(row.decision) : '';
  const sourceSeed =
    row && row.source_seed != null ? String(row.source_seed) : null;
  if (decision === 'pending') {
    return {
      outcome: 'already_pending',
      term: row.term,
      termId: row.id,
      decision: 'pending',
      sourceSeed,
    };
  }
  return {
    outcome: 'already_processed',
    term: row.term,
    termId: row.id,
    decision,
    sourceSeed,
  };
}

function mapQueryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    queryText: row.query_text,
    queryTextNormalized: row.query_text_normalized,
    active: row.active !== false,
    notes: row.notes != null ? row.notes : null,
    createdAt: row.created_at,
  };
}

async function listSerpMonitoredQueries() {
  const { data, error } = await supabase
    .from('serp_monitored_queries')
    .select('id, query_text, query_text_normalized, active, notes, created_at')
    .order('active', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to list serp_monitored_queries: ${error.message}`);
  }

  return { queries: (data || []).map(mapQueryRow) };
}

/** Active catalog rows only (Serper sync job). */
async function listActiveSerpMonitoredQueries() {
  const { data, error } = await supabase
    .from('serp_monitored_queries')
    .select('id, query_text, query_text_normalized, active, notes, created_at')
    .eq('active', true)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(
      `Failed to list active serp_monitored_queries: ${error.message}`,
    );
  }

  return { queries: (data || []).map(mapQueryRow) };
}

async function createSerpMonitoredQuery({ queryText, notes } = {}) {
  const raw = queryText != null ? String(queryText).trim() : '';
  if (!raw) {
    const err = new Error('queryText es requerido');
    err.statusCode = 400;
    err.code = 'QUERY_TEXT_REQUIRED';
    throw err;
  }

  const normalized = normalizeSearchTerm(raw);
  if (!normalized) {
    const err = new Error('queryText inválido después de normalizar');
    err.statusCode = 400;
    err.code = 'QUERY_TEXT_INVALID';
    throw err;
  }

  const notesVal =
    notes != null && String(notes).trim() ? String(notes).trim() : null;

  const { data, error } = await supabase
    .from('serp_monitored_queries')
    .insert({
      query_text: raw,
      query_text_normalized: normalized,
      active: true,
      notes: notesVal,
    })
    .select('id, query_text, query_text_normalized, active, notes, created_at')
    .single();

  if (error) {
    if (/duplicate|unique/i.test(error.message || '')) {
      const err = new Error(
        'Ya existe una query con el mismo texto normalizado (sin tildes / espacios colapsados).',
      );
      err.statusCode = 409;
      err.code = 'QUERY_DUPLICATE';
      throw err;
    }
    throw new Error(`Failed to insert serp_monitored_queries: ${error.message}`);
  }

  logger.info('SERP monitored query created', {
    id: data.id,
    normalized: data.query_text_normalized,
  });

  return mapQueryRow(data);
}

/**
 * Partial update: only fields present in patch (active and/or notes).
 */
async function patchSerpMonitoredQuery(id, patch = {}) {
  const rowId = id != null ? String(id).trim() : '';
  if (!rowId) {
    const err = new Error('id es requerido');
    err.statusCode = 400;
    err.code = 'ID_REQUIRED';
    throw err;
  }

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'active')) {
    if (typeof patch.active !== 'boolean') {
      const err = new Error('active debe ser boolean');
      err.statusCode = 400;
      err.code = 'INVALID_ACTIVE';
      throw err;
    }
    updates.active = patch.active;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    if (patch.notes == null) {
      updates.notes = null;
    } else if (typeof patch.notes === 'string') {
      updates.notes = patch.notes.trim() || null;
    } else {
      const err = new Error('notes debe ser string o null');
      err.statusCode = 400;
      err.code = 'INVALID_NOTES';
      throw err;
    }
  }

  if (!Object.keys(updates).length) {
    const err = new Error('Nada para actualizar (enviá active y/o notes)');
    err.statusCode = 400;
    err.code = 'EMPTY_PATCH';
    throw err;
  }

  const { data: existing, error: fetchError } = await supabase
    .from('serp_monitored_queries')
    .select('id')
    .eq('id', rowId)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to fetch serp_monitored_queries: ${fetchError.message}`);
  }
  if (!existing) {
    const err = new Error('Query no encontrada');
    err.statusCode = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const { data, error } = await supabase
    .from('serp_monitored_queries')
    .update(updates)
    .eq('id', rowId)
    .select('id, query_text, query_text_normalized, active, notes, created_at')
    .single();

  if (error) {
    throw new Error(`Failed to update serp_monitored_queries: ${error.message}`);
  }

  logger.info('SERP monitored query patched', {
    id: data.id,
    updates: Object.keys(updates),
  });

  return mapQueryRow(data);
}

/**
 * Insert the catalog query_text into confirmed_search_terms as pending.
 * Never updates an existing row. UNIQUE races (23505) re-read the row and
 * map to already_pending / already_processed.
 */
async function queueSerpQueryForLanding(id) {
  const rowId = id != null ? String(id).trim() : '';
  if (!rowId) {
    const err = new Error('id es requerido');
    err.statusCode = 400;
    err.code = 'ID_REQUIRED';
    throw err;
  }

  const { data: query, error: fetchError } = await supabase
    .from('serp_monitored_queries')
    .select('id, query_text')
    .eq('id', rowId)
    .maybeSingle();

  if (fetchError) {
    throw new Error(
      `Failed to fetch serp_monitored_queries: ${fetchError.message}`,
    );
  }
  if (!query) {
    const err = new Error('Query no encontrada');
    err.statusCode = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const term = query.query_text != null ? String(query.query_text).trim() : '';
  if (!term) {
    const err = new Error('query_text inválido');
    err.statusCode = 400;
    err.code = 'QUERY_TEXT_INVALID';
    throw err;
  }

  const { data: existing, error: existingErr } = await supabase
    .from('confirmed_search_terms')
    .select('id, term, decision, source_seed')
    .eq('term', term)
    .maybeSingle();

  if (existingErr) {
    throw new Error(
      `Failed to check confirmed_search_terms: ${existingErr.message}`,
    );
  }
  if (existing) {
    return mapExistingTermOutcome(existing);
  }

  const { data: inserted, error: insErr } = await supabase
    .from('confirmed_search_terms')
    .insert({
      term,
      term_type: 'generic',
      decision: 'pending',
      source_seed: SERP_MONITORED_TERM_SOURCE_SEED,
      discovered_score: null,
      entity_id: null,
    })
    .select('id, term, decision, source_seed')
    .single();

  if (insErr) {
    if (isUniqueViolation(insErr)) {
      const { data: raced, error: racedErr } = await supabase
        .from('confirmed_search_terms')
        .select('id, term, decision, source_seed')
        .eq('term', term)
        .maybeSingle();
      if (racedErr) {
        throw new Error(
          `Failed to re-read confirmed_search_terms after unique conflict: ${racedErr.message}`,
        );
      }
      if (raced) {
        return mapExistingTermOutcome(raced);
      }
      const raceErr = new Error(
        'El término ya existe en Términos descubiertos',
      );
      raceErr.statusCode = 409;
      raceErr.code = 'TERM_DUPLICATE';
      throw raceErr;
    }
    throw new Error(
      `Failed to insert confirmed_search_terms: ${insErr.message}`,
    );
  }

  logger.info('SERP query queued for landing', {
    queryId: rowId,
    termId: inserted.id,
    term,
  });

  return {
    outcome: 'created',
    term: inserted.term,
    termId: inserted.id,
    decision: inserted.decision,
    sourceSeed: inserted.source_seed,
  };
}

module.exports = {
  SERP_MONITORED_TERM_SOURCE_SEED,
  listSerpMonitoredQueries,
  listActiveSerpMonitoredQueries,
  createSerpMonitoredQuery,
  patchSerpMonitoredQuery,
  queueSerpQueryForLanding,
  mapQueryRow,
};
