/**
 * Autonomous SMS campaign routes (Notifyme / T2voice).
 * Isolated from Credizona CRM — never joins or queries CRM tables.
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  sendBatch,
  pollStatus,
  pollResponses,
  loadActiveCostConfig,
  buildCostMetrics,
  aggregateMessageStats,
  jsonSafe,
  NotifymeError,
  assertUniqueIdString,
} = require('../services/notifyme-client');

const router = express.Router();

function mapServiceError(err, res) {
  if (err instanceof NotifymeError) {
    const body = {
      error: err.message,
      kind: err.kind,
    };
    if (err.code != null) body.code = err.code;
    if (err.summary) body.summary = err.summary;
    return res.status(err.status || 500).json(jsonSafe(body));
  }
  logger.error('SMS route unexpected error', {
    error: err && err.message ? err.message : 'unknown',
  });
  return res.status(500).json({ error: 'Internal SMS service error' });
}

function mapMessageRow(row) {
  return {
    unique_id: assertUniqueIdString(String(row.unique_id), 'api response'),
    campaign_id: row.campaign_id,
    submission_order: row.submission_order,
    phone: row.phone,
    text: row.text,
    scheduled_at: row.scheduled_at,
    status: row.status,
    delivered_at: row.delivered_at,
    fail_reason: row.fail_reason,
    response_text: row.response_text,
    response_received_at: row.response_received_at,
    last_polled_at: row.last_polled_at,
    source_system: row.source_system,
    source_record_id: row.source_record_id,
    czuid: row.czuid,
    created_at: row.created_at,
  };
}

async function loadCampaignMessages(campaignId) {
  const { data, error } = await supabase
    .from('sms_messages')
    .select(
      'unique_id, campaign_id, submission_order, phone, text, scheduled_at, status, delivered_at, fail_reason, response_text, response_received_at, last_polled_at, source_system, source_record_id, czuid, created_at',
    )
    .eq('campaign_id', campaignId)
    .order('submission_order', { ascending: true });

  if (error) {
    throw new NotifymeError(`Failed to load sms_messages: ${error.message}`, {
      kind: 'database',
      status: 500,
    });
  }
  return data || [];
}

async function enrichCampaign(campaign, messageRows, costConfig) {
  const aggregates = aggregateMessageStats(messageRows);
  const cost = buildCostMetrics({
    totalMessages: campaign.total_messages,
    statusCounts: aggregates.status_counts,
    costConfig,
  });
  return {
    id: campaign.id,
    name: campaign.name,
    created_at: campaign.created_at,
    total_messages: campaign.total_messages,
    status: campaign.status,
    aggregates,
    cost,
  };
}

/**
 * POST /sms/campaigns
 * Body: { name, messages: [{ phone, text, scheduledAt?, source_system?, source_record_id?, czuid? }] }
 */
router.post('/campaigns', async (req, res) => {
  const name = req.body && req.body.name;
  const messages = req.body && req.body.messages;

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }

  let campaign;
  try {
    const { data, error } = await supabase
      .from('sms_campaigns')
      .insert({
        name: name.trim(),
        total_messages: messages.length,
        status: 'sending',
      })
      .select('id, name, created_at, total_messages, status')
      .limit(1);

    if (error || !data || !data[0]) {
      throw new NotifymeError(
        `Failed to create campaign: ${error ? error.message : 'no row returned'}`,
        { kind: 'database', status: 500 },
      );
    }
    campaign = data[0];
  } catch (err) {
    return mapServiceError(err, res);
  }

  try {
    const summary = await sendBatch(campaign.id, messages);
    return res.status(201).json(
      jsonSafe({
        campaign: {
          id: campaign.id,
          name: campaign.name,
          created_at: campaign.created_at,
          total_messages: campaign.total_messages,
          status: summary.status,
        },
        summary,
      }),
    );
  } catch (err) {
    // Campaign + message rows preserved for auditability.
    if (err instanceof NotifymeError && err.summary) {
      return res.status(err.status === 400 ? 400 : 502).json(
        jsonSafe({
          campaign: {
            id: campaign.id,
            name: campaign.name,
            created_at: campaign.created_at,
            total_messages: campaign.total_messages,
            status: err.summary.status,
          },
          error: err.message,
          kind: err.kind,
          code: err.code || null,
          summary: err.summary,
        }),
      );
    }
    return mapServiceError(err, res);
  }
});

/**
 * GET /sms/campaigns
 */
router.get('/campaigns', async (req, res) => {
  try {
    const { data: campaigns, error } = await supabase
      .from('sms_campaigns')
      .select('id, name, created_at, total_messages, status')
      .order('created_at', { ascending: false });

    if (error) {
      throw new NotifymeError(`Failed to list campaigns: ${error.message}`, {
        kind: 'database',
        status: 500,
      });
    }

    const costConfig = await loadActiveCostConfig();
    const enriched = [];
    for (const campaign of campaigns || []) {
      const rows = await loadCampaignMessages(campaign.id);
      enriched.push(await enrichCampaign(campaign, rows, costConfig));
    }

    return res.json(jsonSafe({ campaigns: enriched }));
  } catch (err) {
    return mapServiceError(err, res);
  }
});

/**
 * GET /sms/campaigns/:id
 */
router.get('/campaigns/:id', async (req, res) => {
  const campaignId = req.params.id;
  try {
    const { data, error } = await supabase
      .from('sms_campaigns')
      .select('id, name, created_at, total_messages, status')
      .eq('id', campaignId)
      .limit(1);

    if (error) {
      throw new NotifymeError(`Failed to load campaign: ${error.message}`, {
        kind: 'database',
        status: 500,
      });
    }
    if (!data || !data[0]) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = data[0];
    const rows = await loadCampaignMessages(campaign.id);
    const costConfig = await loadActiveCostConfig();
    const enriched = await enrichCampaign(campaign, rows, costConfig);

    return res.json(
      jsonSafe({
        campaign: enriched,
        messages: rows.map(mapMessageRow),
      }),
    );
  } catch (err) {
    return mapServiceError(err, res);
  }
});

/**
 * POST /sms/campaigns/:id/poll
 * Polls status + responses for all message IDs in the campaign.
 */
router.post('/campaigns/:id/poll', async (req, res) => {
  const campaignId = req.params.id;
  try {
    const { data, error } = await supabase
      .from('sms_campaigns')
      .select('id, name, created_at, total_messages, status')
      .eq('id', campaignId)
      .limit(1);

    if (error) {
      throw new NotifymeError(`Failed to load campaign: ${error.message}`, {
        kind: 'database',
        status: 500,
      });
    }
    if (!data || !data[0]) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = data[0];
    const rows = await loadCampaignMessages(campaign.id);
    // Keep unique_id as decimal strings — never Number/parseInt.
    const uniqueIds = rows.map((r) =>
      assertUniqueIdString(String(r.unique_id), 'poll load'),
    );

    let statusSummary = { requested: 0, returned: 0, updated: 0 };
    let responseSummary = { requested: 0, returned: 0, updated: 0 };

    if (uniqueIds.length > 0) {
      statusSummary = await pollStatus(uniqueIds);
      // Poll responses for all IDs (replies may arrive after delivery).
      responseSummary = await pollResponses(uniqueIds);
    }

    const refreshedRows = await loadCampaignMessages(campaign.id);
    const costConfig = await loadActiveCostConfig();
    const enriched = await enrichCampaign(campaign, refreshedRows, costConfig);

    return res.json(
      jsonSafe({
        campaign: enriched,
        status_poll: statusSummary,
        response_poll: responseSummary,
      }),
    );
  } catch (err) {
    return mapServiceError(err, res);
  }
});

module.exports = router;
