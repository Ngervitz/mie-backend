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
const {
  listEmailTemplates,
  createEmailTemplate,
  updateEmailTemplate,
  loadActiveTemplateForCampaign,
  campaignOwnedCopyFromTemplate,
} = require('../services/email-campaigns/templates');
const {
  EMAIL_AUDIENCE_MODES,
  resolveAudienceModeForCreate,
} = require('../services/email-campaigns/audienceMode');

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
 * Body: {
 *   name,
 *   audience_mode? | mode?,   // SEGMENT_DRIVEN | DIRECTED
 *   segment_id?,              // required for SEGMENT_DRIVEN; forbidden for DIRECTED
 *   scheduled_at?,
 *   subject?, body_html?, template_id?
 * }
 * Legacy: segment_id present + mode omitted → SEGMENT_DRIVEN (explicit app mapping).
 * template_id copies subject/body from an active template. Without it, subject and body_html are required (legacy).
 */
router.post('/campaigns', async (req, res) => {
  const name = req.body && req.body.name;
  const segmentId = req.body && req.body.segment_id;
  const scheduledAt =
    req.body && req.body.scheduled_at != null
      ? req.body.scheduled_at
      : null;
  const templateId =
    req.body && req.body.template_id != null && req.body.template_id !== ''
      ? req.body.template_id
      : null;

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }

  const modeResolved = resolveAudienceModeForCreate(req.body || {});
  if (!modeResolved.ok) {
    return res.status(400).json({ error: modeResolved.error });
  }
  const audienceMode = modeResolved.mode;

  let subject = req.body && req.body.subject;
  let bodyHtml = req.body && req.body.body_html;

  try {
    if (templateId != null) {
      const template = await loadActiveTemplateForCampaign(supabase, templateId);
      const copied = campaignOwnedCopyFromTemplate(template);
      subject = copied.subject;
      bodyHtml = copied.body_html;
    } else {
      if (typeof subject !== 'string' || !subject.trim()) {
        return res
          .status(400)
          .json({ error: 'subject must be a non-empty string' });
      }
      if (typeof bodyHtml !== 'string' || !bodyHtml.trim()) {
        return res
          .status(400)
          .json({ error: 'body_html must be a non-empty string' });
      }
    }

    const insertRow = {
      name: name.trim(),
      subject: String(subject).trim(),
      body_html: String(bodyHtml).trim(),
      audience_mode: audienceMode,
      recipient_count: 0,
      status: 'draft',
    };

    if (audienceMode === EMAIL_AUDIENCE_MODES.DIRECTED) {
      insertRow.segment_id = null;
      insertRow.segment_rules_snapshot = null;
    } else {
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
        return res
          .status(400)
          .json({ error: `segment_id not found: ${segmentId}` });
      }

      insertRow.segment_id = segment.id;
      insertRow.segment_rules_snapshot = segment.rules;
    }

    if (templateId != null) {
      insertRow.template_id = templateId;
    }
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
    const status = err && err.statusCode ? err.statusCode : 500;
    logger.error('POST /email/campaigns unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(status).json({
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

router.get('/templates', async function (req, res) {
  try {
    const templates = await listEmailTemplates(supabase);
    return res.json({ templates: templates });
  } catch (err) {
    logger.error('GET /email/templates failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

router.post('/templates', async function (req, res) {
  try {
    const template = await createEmailTemplate(supabase, req.body || {});
    return res.status(201).json({ template: template });
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 400;
    return res.status(status).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

router.patch('/templates/:id', async function (req, res) {
  try {
    const template = await updateEmailTemplate(
      supabase,
      req.params.id,
      req.body || {},
    );
    return res.json({ template: template });
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 400;
    return res.status(status).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

module.exports = router;
