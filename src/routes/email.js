/**
 * Email campaign routes (Resend / LogEmailProvider).
 * Isolated from SMS/Notifyme — never imports sms.js or notifyme-client.
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { validateRule } = require('../services/email-campaigns/rule-engine');
const {
  materializeCampaign,
  processQueue,
} = require('../services/email-campaigns/processor');

const router = express.Router();

/**
 * POST /email/segments
 * Body: { name: string, rules: array }
 */
router.post('/segments', async (req, res) => {
  const name = req.body && req.body.name;
  const rules = req.body && req.body.rules;

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }

  try {
    validateRule(rules);
  } catch (err) {
    return res.status(400).json({
      error: err && err.message ? err.message : 'Invalid rules',
    });
  }

  try {
    const { data, error } = await supabase
      .from('email_segments')
      .insert({
        name: name.trim(),
        rules,
      })
      .select('*')
      .single();

    if (error) {
      logger.error('POST /email/segments insert failed', {
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ segment: data });
  } catch (err) {
    logger.error('POST /email/segments unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

/**
 * GET /email/segments
 */
router.get('/segments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_segments')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('GET /email/segments failed', { error: error.message });
      return res.status(500).json({ error: error.message });
    }

    return res.json({ segments: data || [] });
  } catch (err) {
    logger.error('GET /email/segments unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

/**
 * POST /email/campaigns
 * Body: { name, subject, body_html, segment_id, scheduled_at? }
 */
router.post('/campaigns', async (req, res) => {
  const name = req.body && req.body.name;
  const subject = req.body && req.body.subject;
  const bodyHtml = req.body && req.body.body_html;
  const segmentId = req.body && req.body.segment_id;
  const scheduledAt =
    req.body && req.body.scheduled_at != null
      ? req.body.scheduled_at
      : null;

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }
  if (typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'subject must be a non-empty string' });
  }
  if (typeof bodyHtml !== 'string' || !bodyHtml.trim()) {
    return res.status(400).json({ error: 'body_html must be a non-empty string' });
  }
  if (segmentId == null || segmentId === '') {
    return res.status(400).json({ error: 'segment_id is required' });
  }

  try {
    const { data: segment, error: segErr } = await supabase
      .from('email_segments')
      .select('*')
      .eq('id', segmentId)
      .maybeSingle();

    if (segErr) {
      logger.error('POST /email/campaigns segment lookup failed', {
        segmentId,
        error: segErr.message,
      });
      return res.status(500).json({ error: segErr.message });
    }
    if (!segment) {
      return res.status(400).json({ error: `segment_id not found: ${segmentId}` });
    }

    const insertRow = {
      name: name.trim(),
      subject: subject.trim(),
      body_html: bodyHtml,
      segment_id: segment.id,
      segment_rules_snapshot: segment.rules,
      recipient_count: 0,
      status: 'draft',
    };
    if (scheduledAt != null && scheduledAt !== '') {
      insertRow.scheduled_at = scheduledAt;
    }

    const { data: campaign, error: campErr } = await supabase
      .from('email_campaigns')
      .insert(insertRow)
      .select('*')
      .single();

    if (campErr) {
      logger.error('POST /email/campaigns insert failed', {
        error: campErr.message,
      });
      return res.status(500).json({ error: campErr.message });
    }

    return res.status(201).json({ campaign });
  } catch (err) {
    logger.error('POST /email/campaigns unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

/**
 * GET /email/campaigns
 * Must be registered before /campaigns/:id.
 */
router.get('/campaigns', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('GET /email/campaigns failed', { error: error.message });
      return res.status(500).json({ error: error.message });
    }

    return res.json({ campaigns: data || [] });
  } catch (err) {
    logger.error('GET /email/campaigns unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

/**
 * POST /email/process-queue
 * Must be registered before /campaigns/:id so "process-queue" is not an id.
 */
router.post('/process-queue', async (req, res) => {
  try {
    const result = await processQueue();
    return res.status(200).json(result);
  } catch (err) {
    logger.error('POST /email/process-queue failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

/**
 * GET /email/campaigns/:id
 */
router.get('/campaigns/:id', async (req, res) => {
  const campaignId = req.params.id;
  try {
    const { data: campaign, error: campErr } = await supabase
      .from('email_campaigns')
      .select('*')
      .eq('id', campaignId)
      .maybeSingle();

    if (campErr) {
      logger.error('GET /email/campaigns/:id failed', {
        campaignId,
        error: campErr.message,
      });
      return res.status(500).json({ error: campErr.message });
    }
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { data: recipients, error: recErr } = await supabase
      .from('email_campaign_recipients')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: true });

    if (recErr) {
      logger.error('GET /email/campaigns/:id recipients failed', {
        campaignId,
        error: recErr.message,
      });
      return res.status(500).json({ error: recErr.message });
    }

    return res.json({
      campaign,
      recipients: recipients || [],
    });
  } catch (err) {
    logger.error('GET /email/campaigns/:id unexpected', {
      campaignId,
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

/**
 * POST /email/campaigns/:id/materialize
 */
router.post('/campaigns/:id/materialize', async (req, res) => {
  const campaignId = req.params.id;

  try {
    const { data: campaign, error: campErr } = await supabase
      .from('email_campaigns')
      .select('id')
      .eq('id', campaignId)
      .maybeSingle();

    if (campErr) {
      logger.error('POST /email/campaigns/:id/materialize lookup failed', {
        campaignId,
        error: campErr.message,
      });
      return res.status(500).json({ error: campErr.message });
    }
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const result = await materializeCampaign(campaignId);
    return res.status(200).json(result);
  } catch (err) {
    const message = err && err.message ? err.message : 'Materialize failed';
    logger.error('POST /email/campaigns/:id/materialize failed', {
      campaignId,
      error: message,
    });
    return res.status(400).json({ error: message });
  }
});

module.exports = router;
