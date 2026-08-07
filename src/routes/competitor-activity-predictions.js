const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const router = express.Router();

/**
 * GET /competitor-activity-predictions
 * Latest predicted week only, enriched with monitored entity display data.
 */
router.get('/', async (req, res) => {
  try {
    const { data: latestRows, error: latestError } = await supabase
      .from('competitor_activity_predictions')
      .select('predicted_week_of')
      .order('predicted_week_of', { ascending: false })
      .limit(1);

    if (latestError) {
      logger.error('GET /competitor-activity-predictions latest week failed', {
        error: latestError.message,
      });
      return res.status(500).json({ error: latestError.message });
    }

    const predictedWeekOf =
      Array.isArray(latestRows) && latestRows[0]
        ? latestRows[0].predicted_week_of
        : null;

    if (!predictedWeekOf) {
      return res.status(200).json({
        predicted_week_of: null,
        features_week_of: null,
        model_version: null,
        training_rows_used: 0,
        predictions: [],
      });
    }

    const { data: latestRunRows, error: latestRunError } = await supabase
      .from('competitor_activity_predictions')
      .select('model_version, trained_at')
      .eq('predicted_week_of', predictedWeekOf)
      .order('trained_at', { ascending: false })
      .limit(1);

    if (latestRunError) {
      logger.error('GET /competitor-activity-predictions latest run failed', {
        predicted_week_of: predictedWeekOf,
        error: latestRunError.message,
      });
      return res.status(500).json({ error: latestRunError.message });
    }

    const latestModelVersion =
      Array.isArray(latestRunRows) && latestRunRows[0]
        ? latestRunRows[0].model_version
        : null;

    if (!latestModelVersion) {
      return res.status(200).json({
        predicted_week_of: predictedWeekOf,
        features_week_of: null,
        model_version: null,
        training_rows_used: 0,
        predictions: [],
      });
    }

    const { data: rows, error: rowsError } = await supabase
      .from('competitor_activity_predictions')
      .select(
        [
          'entity_id',
          'features_week_of',
          'predicted_week_of',
          'predicted_probability',
          'predicted_label',
          'historical_avg',
          'eligibility_status',
          'eligibility_reason',
          'model_version',
          'training_rows_used',
          'trained_at',
          'created_at',
          'monitored_entities ( name, website_domain )',
        ].join(', '),
      )
      .eq('predicted_week_of', predictedWeekOf)
      .eq('model_version', latestModelVersion)
      .order('predicted_probability', { ascending: false });

    if (rowsError) {
      logger.error('GET /competitor-activity-predictions rows failed', {
        predicted_week_of: predictedWeekOf,
        error: rowsError.message,
      });
      return res.status(500).json({ error: rowsError.message });
    }

    const predictions = (Array.isArray(rows) ? rows : []).map((row) => {
      const relation = Array.isArray(row.monitored_entities)
        ? row.monitored_entities[0]
        : row.monitored_entities;
      return {
        entity_id: row.entity_id,
        name: relation && relation.name ? relation.name : 'Entidad',
        website_domain:
          relation && relation.website_domain
            ? relation.website_domain
            : null,
        predicted_probability: row.predicted_probability,
        predicted_label: row.predicted_label === true,
        historical_avg: row.historical_avg,
        eligibility_status:
          row.eligibility_status == null ? null : row.eligibility_status,
        eligibility_reason:
          row.eligibility_reason == null ? null : row.eligibility_reason,
        trained_at: row.trained_at,
        created_at: row.created_at,
      };
    });

    const metadata = rows && rows[0] ? rows[0] : {};
    return res.status(200).json({
      predicted_week_of: predictedWeekOf,
      features_week_of: metadata.features_week_of || null,
      model_version: metadata.model_version || null,
      training_rows_used: Number(metadata.training_rows_used) || 0,
      predictions,
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /competitor-activity-predictions unexpected', {
      error: message,
    });
    return res.status(500).json({ error: message });
  }
});

module.exports = router;
