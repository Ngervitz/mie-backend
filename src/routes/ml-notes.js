const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const router = express.Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function mapEntityNote(row) {
  const relation = Array.isArray(row.monitored_entities)
    ? row.monitored_entities[0]
    : row.monitored_entities;

  return {
    id: row.id,
    entity_id: row.entity_id,
    name: relation && relation.name ? relation.name : 'Entidad',
    week_of: row.week_of,
    note: row.note,
    created_at: row.created_at,
  };
}

/**
 * GET /ml-notes/run?model_version=X
 */
router.get('/run', async (req, res) => {
  const modelVersion =
    typeof req.query.model_version === 'string'
      ? req.query.model_version.trim()
      : '';

  if (!modelVersion) {
    return res.status(400).json({
      error: 'model_version es obligatorio',
    });
  }

  try {
    const { data, error } = await supabase
      .from('ml_run_notes')
      .select('id, note, created_at')
      .eq('model_version', modelVersion)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      logger.error('GET /ml-notes/run failed', {
        modelVersion,
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ notes: data || [] });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /ml-notes/run unexpected', { error: message });
    return res.status(500).json({ error: message });
  }
});

/**
 * POST /ml-notes/run
 * Body: { model_version, note }
 */
router.post('/run', async (req, res) => {
  const modelVersion =
    req.body && typeof req.body.model_version === 'string'
      ? req.body.model_version.trim()
      : '';
  const note =
    req.body && typeof req.body.note === 'string'
      ? req.body.note.trim()
      : '';

  if (!modelVersion) {
    return res.status(400).json({
      error: 'model_version debe ser un string no vacío',
    });
  }
  if (!note) {
    return res.status(400).json({
      error: 'note debe ser un string no vacío',
    });
  }
  if (note.length > 1000) {
    return res.status(400).json({
      error: 'note no puede superar los 1000 caracteres',
    });
  }

  try {
    const { data, error } = await supabase
      .from('ml_run_notes')
      .insert({
        model_version: modelVersion,
        note,
      })
      .select('id, note, created_at')
      .single();

    if (error) {
      logger.error('POST /ml-notes/run failed', {
        modelVersion,
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    logger.info('ML run note created', {
      id: data.id,
      modelVersion,
    });
    return res.status(201).json({ note: data });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('POST /ml-notes/run unexpected', { error: message });
    return res.status(500).json({ error: message });
  }
});

/**
 * GET /ml-notes/entity-week
 *
 * No filters: latest 20 notes.
 * entity_id only: latest 20 for entity.
 * week_of only: latest 20 for week.
 * Both: latest 100 for exact combination.
 */
router.get('/entity-week', async (req, res) => {
  const entityId =
    typeof req.query.entity_id === 'string'
      ? req.query.entity_id.trim()
      : '';
  const weekOf =
    typeof req.query.week_of === 'string'
      ? req.query.week_of.trim()
      : '';

  if (entityId && !UUID_RE.test(entityId)) {
    return res.status(400).json({
      error: 'entity_id debe ser un UUID válido',
    });
  }
  if (weekOf && !isValidDate(weekOf)) {
    return res.status(400).json({
      error: 'week_of debe tener formato YYYY-MM-DD válido',
    });
  }

  try {
    let query = supabase
      .from('ml_entity_week_notes')
      .select(
        'id, entity_id, week_of, note, created_at, monitored_entities ( name )',
      )
      .order('created_at', { ascending: false });

    if (entityId) query = query.eq('entity_id', entityId);
    if (weekOf) query = query.eq('week_of', weekOf);

    query = query.limit(entityId && weekOf ? 100 : 20);

    const { data, error } = await query;

    if (error) {
      logger.error('GET /ml-notes/entity-week failed', {
        entityId: entityId || null,
        weekOf: weekOf || null,
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      notes: (data || []).map(mapEntityNote),
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /ml-notes/entity-week unexpected', {
      error: message,
    });
    return res.status(500).json({ error: message });
  }
});

/**
 * POST /ml-notes/entity-week
 * Body: { entity_id, week_of, note }
 */
router.post('/entity-week', async (req, res) => {
  const entityId =
    req.body && typeof req.body.entity_id === 'string'
      ? req.body.entity_id.trim()
      : '';
  const weekOf =
    req.body && typeof req.body.week_of === 'string'
      ? req.body.week_of.trim()
      : '';
  const note =
    req.body && typeof req.body.note === 'string'
      ? req.body.note.trim()
      : '';

  if (!UUID_RE.test(entityId)) {
    return res.status(400).json({
      error: 'entity_id debe ser un UUID válido',
    });
  }
  if (!isValidDate(weekOf)) {
    return res.status(400).json({
      error: 'week_of debe tener formato YYYY-MM-DD válido',
    });
  }
  if (!note) {
    return res.status(400).json({
      error: 'note debe ser un string no vacío',
    });
  }
  if (note.length > 1000) {
    return res.status(400).json({
      error: 'note no puede superar los 1000 caracteres',
    });
  }

  try {
    const { data: entity, error: entityError } = await supabase
      .from('monitored_entities')
      .select('id, name')
      .eq('id', entityId)
      .maybeSingle();

    if (entityError) {
      logger.error('POST /ml-notes/entity-week entity lookup failed', {
        entityId,
        error: entityError.message,
      });
      return res.status(500).json({ error: entityError.message });
    }
    if (!entity) {
      return res.status(404).json({ error: 'Entidad no encontrada' });
    }

    const { data, error } = await supabase
      .from('ml_entity_week_notes')
      .insert({
        entity_id: entityId,
        week_of: weekOf,
        note,
      })
      .select('id, entity_id, week_of, note, created_at')
      .single();

    if (error) {
      logger.error('POST /ml-notes/entity-week failed', {
        entityId,
        weekOf,
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    const created = {
      id: data.id,
      entity_id: data.entity_id,
      name: entity.name,
      week_of: data.week_of,
      note: data.note,
      created_at: data.created_at,
    };

    logger.info('ML entity week note created', {
      id: data.id,
      entityId,
      weekOf,
    });
    return res.status(201).json({ note: created });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('POST /ml-notes/entity-week unexpected', {
      error: message,
    });
    return res.status(500).json({ error: message });
  }
});

module.exports = router;
