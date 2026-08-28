/**
 * Autonomous SMS campaign routes (Notifyme / T2voice).
 * Isolated from Credizona CRM — never joins or queries CRM tables.
 */

const { randomUUID } = require('crypto');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  sendBatch,
  pollStatus,
  pollResponses,
  loadActiveCostConfig,
  jsonSafe,
  NotifymeError,
  assertUniqueIdString,
} = require('../services/notifyme-client');
const {
  SMS_MAX_MESSAGE_CHARS,
  applyNombrePlaceholder,
  messageBodyHasHttpUrl,
  parseSourceSystem,
  resolveEligibleCount,
  resolveNewShapeDestinations,
  classifyPhonesForSeries,
  normalizeDirectedPhones,
} = require('../lib/smsCampaignContacts');
const {
  parseCampaignSeriesId,
  parseSeriesName,
  seriesRequiredBody,
  seriesNotFoundBody,
  partitionPhoneClassifications,
  loadCampaignSeriesById,
  listCampaignSeries,
  createCampaignSeries,
} = require('../lib/smsCampaignSeries');
const {
  PREVIEW_UTM_CAMPAIGN_UUID,
  looksLikeHttpUrl,
  composeFinalUrl,
  composePublicShortUrl,
  shortenWithTinyUrl,
  attachShortLinkCampaignId,
  getOrCreatePreviewShortUrl,
} = require('../lib/smsTinyUrl');
const {
  isIndividualTrackingEnabled,
  prepareIndividualSmsTracking,
  markCampaignPrepError,
  TrackingPrepError,
} = require('../lib/smsMarketingImpacts');

const router = express.Router();

const SMS_CAMPAIGN_SELECT =
  'id, name, created_at, total_messages, status, destination_url, utm_campaign_value, short_url, campaign_series_id';

/**
 * Empirically confirmed Notifyme raw delivered statuses (case-sensitive).
 * Extend this array as additional delivered values are observed in real polls.
 */
const DELIVERED_STATUS_VALUES = ['DELIVERED'];
const deliveredStatusSet = new Set(DELIVERED_STATUS_VALUES);

const MAX_WAVE_INTERVAL_SECONDS = 86400;

function parseWaveSize(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

function parseIntervalSeconds(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(n) || n < 0 || n > MAX_WAVE_INTERVAL_SECONDS) {
    return undefined;
  }
  return n;
}

function applyWaveScheduledAt(messages, waveSize, intervalSeconds) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  if (waveSize == null || intervalSeconds < 1) return messages;
  if (messages.length <= waveSize) return messages;
  const t0 = Date.now();
  return messages.map(function (m, i) {
    const wave = Math.floor(i / waveSize);
    return Object.assign({}, m, {
      scheduledAt: new Date(t0 + wave * intervalSeconds * 1000).toISOString(),
    });
  });
}

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
    contact_id: row.contact_id != null ? row.contact_id : null,
    czuid: row.czuid,
    created_at: row.created_at,
  };
}

async function loadCampaignMessages(campaignId) {
  const { data, error } = await supabase
    .from('sms_messages')
    .select(
      'unique_id, campaign_id, submission_order, phone, text, scheduled_at, status, delivered_at, fail_reason, response_text, response_received_at, last_polled_at, source_system, source_record_id, contact_id, czuid, created_at',
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

/**
 * Aggregate message stats using local DELIVERED_STATUS_VALUES mapping.
 * Mirrors notifyme-client aggregateMessageStats but with configured delivered set.
 */
function aggregateMessageStats(rows) {
  const status_counts = {};
  let delivered = null;
  let failed = null;
  let pending = 0;
  let responded = 0;

  for (const row of rows || []) {
    const st = row.status == null ? 'pending' : String(row.status);
    status_counts[st] = (status_counts[st] || 0) + 1;
    if (st === 'pending') pending += 1;
    if (
      row.response_received_at != null ||
      (row.response_text != null && row.response_text !== '')
    ) {
      responded += 1;
    }
  }

  if (deliveredStatusSet.size > 0) {
    delivered = 0;
    for (const [st, n] of Object.entries(status_counts)) {
      if (deliveredStatusSet.has(st)) delivered += n;
    }
  }

  return {
    total: (rows || []).length,
    delivered,
    failed,
    pending,
    responded,
    status_counts,
  };
}

function buildCostMetrics({ totalMessages, statusCounts, costConfig }) {
  const messages_sent = totalMessages;
  let messages_delivered = null;
  let estimated_cost = null;
  let cost_per_sms_with_vat = null;

  if (costConfig) {
    const ex = Number(costConfig.cost_per_sms_ex_vat);
    const vat = Number(costConfig.vat_rate);
    if (Number.isFinite(ex) && Number.isFinite(vat)) {
      cost_per_sms_with_vat = ex * (1 + vat);
    }
  }

  if (deliveredStatusSet.size > 0) {
    messages_delivered = 0;
    for (const [status, count] of Object.entries(statusCounts || {})) {
      if (deliveredStatusSet.has(status)) {
        messages_delivered += count;
      }
    }
    if (cost_per_sms_with_vat != null) {
      estimated_cost = cost_per_sms_with_vat * messages_delivered;
    }
  }

  return {
    messages_sent,
    messages_delivered,
    cost_per_sms_ex_vat: costConfig ? Number(costConfig.cost_per_sms_ex_vat) : null,
    vat_rate: costConfig ? Number(costConfig.vat_rate) : null,
    cost_per_sms_with_vat,
    estimated_cost,
    delivered_status_mapping_configured: deliveredStatusSet.size > 0,
  };
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
    destination_url:
      campaign.destination_url != null ? campaign.destination_url : null,
    utm_campaign_value:
      campaign.utm_campaign_value != null ? campaign.utm_campaign_value : null,
    short_url: campaign.short_url != null ? campaign.short_url : null,
    campaign_series_id:
      campaign.campaign_series_id != null ? campaign.campaign_series_id : null,
    aggregates,
    cost,
  };
}

function buildGa4DataClient() {
  const rawJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is not configured');
  }
  let credentials;
  try {
    credentials = JSON.parse(rawJson);
  } catch (err) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is missing client_email/private_key');
  }
  credentials.private_key = String(credentials.private_key).replace(/\\n/g, '\n');
  return new BetaAnalyticsDataClient({ credentials });
}

function getGa4PropertyId() {
  const id = String(process.env.GA4_PROPERTY_ID || '').trim();
  if (!id) {
    throw new Error('GA4_PROPERTY_ID is not configured');
  }
  return id;
}

/**
 * GET /sms/contacts/eligible?source_system=&campaign_series_id=
 * Count of contacts matching the same eligibility used by POST from_contacts.
 * Tracking ON requires campaign_series_id (series RPC). Tracking OFF ignores series.
 */
router.get('/contacts/eligible', async (req, res) => {
  const sourceSystem = parseSourceSystem(req.query && req.query.source_system);
  if (!sourceSystem) {
    return res.status(400).json({ error: 'source_system is required' });
  }
  try {
    const individualTracking = isIndividualTrackingEnabled();
    let seriesId = null;
    if (individualTracking) {
      const parsed = parseCampaignSeriesId(
        req.query && req.query.campaign_series_id,
      );
      if (parsed.error) {
        return res.status(400).json({ error: parsed.error, kind: 'validation' });
      }
      if (!parsed.id) {
        return res.status(400).json(jsonSafe(seriesRequiredBody()));
      }
      const series = await loadCampaignSeriesById(parsed.id);
      if (!series) {
        return res.status(400).json(jsonSafe(seriesNotFoundBody()));
      }
      seriesId = parsed.id;
    }
    const result = await resolveEligibleCount({
      sourceSystem: sourceSystem,
      seriesId: seriesId,
      individualTracking: individualTracking,
    });
    if (!result.ok) {
      return res.status(result.status).json(jsonSafe(result.body));
    }
    return res.json(jsonSafe(result.body));
  } catch (err) {
    logger.error('GET /sms/contacts/eligible failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Failed to count eligible contacts' });
  }
});

/**
 * POST /sms/contacts/classify-for-series
 * Fail-closed preview for directed/paste phones against a series.
 */
router.post('/contacts/classify-for-series', async (req, res) => {
  const parsed = parseCampaignSeriesId(
    req.body && req.body.campaign_series_id,
  );
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error, kind: 'validation' });
  }
  if (!parsed.id) {
    return res.status(400).json({
      error: 'campaign_series_id is required',
      kind: 'validation',
    });
  }
  const phonesRaw = req.body && req.body.phones;
  if (!Array.isArray(phonesRaw)) {
    return res.status(400).json({ error: 'phones must be an array' });
  }
  try {
    const series = await loadCampaignSeriesById(parsed.id);
    if (!series) {
      return res.status(400).json(jsonSafe(seriesNotFoundBody()));
    }
    const phones = normalizeDirectedPhones(phonesRaw);
    const classified = await classifyPhonesForSeries(parsed.id, phones);
    const partition = partitionPhoneClassifications(classified);
    return res.json(
      jsonSafe({
        campaign_series_id: parsed.id,
        protected_clicked: partition.protected_clicked,
        excluded_from_campaigns: partition.excluded_from_campaigns,
        ok: partition.ok,
      }),
    );
  } catch (err) {
    logger.error('POST /sms/contacts/classify-for-series failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Failed to classify phones' });
  }
});

/**
 * GET /sms/campaign-series
 */
router.get('/campaign-series', async (req, res) => {
  try {
    const series = await listCampaignSeries();
    return res.json(
      jsonSafe({
        series: series,
        individual_tracking: isIndividualTrackingEnabled(),
      }),
    );
  } catch (err) {
    logger.error('GET /sms/campaign-series failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Failed to list campaign series' });
  }
});

/**
 * POST /sms/campaign-series
 */
router.post('/campaign-series', async (req, res) => {
  const name = parseSeriesName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({
      error: 'name must be a non-empty string',
      kind: 'validation',
    });
  }
  try {
    const row = await createCampaignSeries(name);
    return res.status(201).json(jsonSafe(row));
  } catch (err) {
    logger.error('POST /sms/campaign-series failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Failed to create campaign series' });
  }
});

/**
 * POST /sms/preview-short-url
 * Shorten destination_url with a fixed preview UTM UUID. Does not create a campaign
 * and does not affect real send links. Same destination reuses the in-process cache.
 */
router.post('/preview-short-url', async (req, res) => {
  const destinationUrlRaw = req.body && req.body.destination_url;
  if (!looksLikeHttpUrl(destinationUrlRaw)) {
    return res.status(400).json({
      error: 'destination_url must be an http(s) URL',
    });
  }
  const destinationUrl = String(destinationUrlRaw).trim();
  try {
    const result = await getOrCreatePreviewShortUrl(destinationUrl);
    return res.json(
      jsonSafe({
        destination_url: destinationUrl,
        utm_campaign_value: PREVIEW_UTM_CAMPAIGN_UUID,
        preview_url: result.previewUrl,
        short_url: result.shortUrl,
        cached: result.cached,
        reason: result.shortUrl ? null : result.reason,
      }),
    );
  } catch (err) {
    logger.error('POST /sms/preview-short-url failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Failed to preview short URL' });
  }
});

/**
 * POST /sms/campaigns
 * Legacy: { name, messages: [{ phone, text, ... }] }
 * Paste:  { name, destination_url, message_body, phones: ["..."] }
 * List:   { name, destination_url, message_body, from_contacts: { source_system, limit } }
 * Direct: { name, destination_url, message_body, from_contacts: { phones: ["..."] } }
 */
router.post('/campaigns', async (req, res) => {
  const name = req.body && req.body.name;
  const legacyMessages = req.body && req.body.messages;
  const phones = req.body && req.body.phones;
  const messageBody = req.body && req.body.message_body;
  const destinationUrlRaw = req.body && req.body.destination_url;

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }

  const waveSize = parseWaveSize(req.body && req.body.wave_size);
  if (waveSize === undefined) {
    return res.status(400).json({
      error: 'wave_size must be an integer ≥ 1, or omitted',
    });
  }
  const intervalSeconds = parseIntervalSeconds(
    req.body && req.body.interval_seconds,
  );
  if (intervalSeconds === undefined) {
    return res.status(400).json({
      error: 'interval_seconds must be an integer from 0 to 86400',
    });
  }
  if (intervalSeconds > 0 && waveSize == null) {
    return res.status(400).json({
      error: 'SMS por tanda es obligatorio si el intervalo es mayor a 0',
    });
  }

  const fromContactsRaw = req.body && req.body.from_contacts;
  const useFromContacts =
    fromContactsRaw != null &&
    typeof fromContactsRaw === 'object' &&
    !Array.isArray(fromContactsRaw);

  const useNewShape =
    Array.isArray(phones) ||
    messageBody != null ||
    destinationUrlRaw != null ||
    useFromContacts;

  // Prefer legacy when a non-empty messages array is provided (backward compatible).
  const useLegacy =
    Array.isArray(legacyMessages) && legacyMessages.length > 0;

  if (!useLegacy && !useNewShape) {
    return res.status(400).json({
      error:
        'Provide messages[], { destination_url, message_body, phones[] }, or from_contacts',
    });
  }

  let campaign;
  let messages;
  let finalUrl = null;
  let storedDestinationUrl = null;
  let utmCampaignValue = null;
  let shortUrl = null;
  let individualTracking = false;

  try {
    if (useLegacy) {
      messages = legacyMessages;
      const { data, error } = await supabase
        .from('sms_campaigns')
        .insert({
          name: name.trim(),
          total_messages: messages.length,
          status: 'sending',
        })
        .select(
          SMS_CAMPAIGN_SELECT,
        )
        .limit(1);

      if (error || !data || !data[0]) {
        throw new NotifymeError(
          `Failed to create campaign: ${error ? error.message : 'no row returned'}`,
          { kind: 'database', status: 500 },
        );
      }
      campaign = data[0];
    } else {
      if (
        useFromContacts &&
        Array.isArray(phones) &&
        phones.length > 0
      ) {
        return res.status(400).json({
          error: 'from_contacts cannot be combined with phones[]',
        });
      }
      if (!looksLikeHttpUrl(destinationUrlRaw)) {
        return res.status(400).json({
          error: 'destination_url must be a valid http(s) URL',
        });
      }
      if (typeof messageBody !== 'string' || !messageBody.trim()) {
        return res.status(400).json({
          error: 'message_body must be a non-empty string',
        });
      }

      individualTracking = isIndividualTrackingEnabled();
      let seriesId = null;
      if (individualTracking) {
        const parsedSeries = parseCampaignSeriesId(
          req.body && req.body.campaign_series_id,
        );
        if (parsedSeries.error) {
          return res.status(400).json({
            error: parsedSeries.error,
            kind: 'validation',
          });
        }
        if (!parsedSeries.id) {
          return res.status(400).json(jsonSafe(seriesRequiredBody()));
        }
        let seriesRow;
        try {
          seriesRow = await loadCampaignSeriesById(parsedSeries.id);
        } catch (seriesErr) {
          throw new NotifymeError(
            seriesErr && seriesErr.message
              ? seriesErr.message
              : 'campaign series lookup failed',
            { kind: 'database', status: 500 },
          );
        }
        if (!seriesRow) {
          return res.status(400).json(jsonSafe(seriesNotFoundBody()));
        }
        seriesId = parsedSeries.id;
      }

      let normalizedPhones = null;
      let selectedContacts = null;
      let resolved;
      try {
        resolved = await resolveNewShapeDestinations({
          useFromContacts: useFromContacts,
          fromContactsRaw: fromContactsRaw,
          phones: phones,
          individualTracking: individualTracking,
          seriesId: seriesId,
        });
      } catch (resolveErr) {
        throw new NotifymeError(
          resolveErr && resolveErr.message
            ? resolveErr.message
            : 'eligible contacts query failed',
          { kind: 'database', status: 500 },
        );
      }
      if (!resolved.ok) {
        return res.status(resolved.status).json(jsonSafe(resolved.body));
      }
      selectedContacts = resolved.selectedContacts;
      normalizedPhones = resolved.normalizedPhones;

      // Generate UUID first so UTM and DB row share the same id in one insert.
      const campaignId = randomUUID();
      storedDestinationUrl = String(destinationUrlRaw).trim();
      utmCampaignValue = campaignId;

      const skipAutoLink = messageBodyHasHttpUrl(messageBody);

      function mapContactRecordId(c) {
        return c.source_record_id == null || c.source_record_id === ''
          ? null
          : String(c.source_record_id);
      }

      if (individualTracking) {
        if (!skipAutoLink) {
          finalUrl = composeFinalUrl(storedDestinationUrl, campaignId);
        }
        shortUrl = null;
        const recipientCount = selectedContacts
          ? selectedContacts.length
          : normalizedPhones.length;
        const { data, error } = await supabase
          .from('sms_campaigns')
          .insert({
            id: campaignId,
            name: name.trim(),
            total_messages: recipientCount,
            status: 'sending',
            destination_url: storedDestinationUrl,
            utm_campaign_value: utmCampaignValue,
            short_url: null,
            campaign_series_id: seriesId,
          })
          .select(
            SMS_CAMPAIGN_SELECT,
          )
          .limit(1);

        if (error || !data || !data[0]) {
          throw new NotifymeError(
            `Failed to create campaign: ${error ? error.message : 'no row returned'}`,
            { kind: 'database', status: 500 },
          );
        }
        campaign = data[0];

        const recipients = selectedContacts
          ? selectedContacts.map((c) => ({
              phone: String(c.phone).trim(),
              contact_id: c.id,
              source_system:
                c.source_system == null ? null : String(c.source_system),
              source_record_id: mapContactRecordId(c),
              nombre: c.nombre,
            }))
          : normalizedPhones.map((phone) => ({
              phone: phone,
              contact_id: null,
            }));

        let trackingPlans;
        try {
          trackingPlans = await prepareIndividualSmsTracking({
            campaignId: campaignId,
            recipients: recipients,
            destinationUrl: skipAutoLink ? null : finalUrl,
            skipShorts: skipAutoLink,
          });
        } catch (prepErr) {
          await markCampaignPrepError(campaignId);
          const message =
            prepErr && prepErr.message
              ? String(prepErr.message)
              : 'Individual tracking prep failed';
          return res.status(500).json(
            jsonSafe({
              error: message,
              kind:
                prepErr instanceof TrackingPrepError ||
                prepErr instanceof NotifymeError
                  ? prepErr.kind
                  : 'database',
              campaign: {
                id: campaign.id,
                name: campaign.name,
                created_at: campaign.created_at,
                total_messages: campaign.total_messages,
                status: 'error',
                destination_url: storedDestinationUrl,
                utm_campaign_value: utmCampaignValue,
                short_url: null,
                campaign_series_id:
                  campaign.campaign_series_id != null
                    ? campaign.campaign_series_id
                    : null,
              },
              individual_tracking: true,
            }),
          );
        }

        if (selectedContacts) {
          messages = selectedContacts.map((c, i) => {
            const plan = trackingPlans[i];
            const link = skipAutoLink
              ? ''
              : composePublicShortUrl(plan.short_code);
            const bodyWithName = applyNombrePlaceholder(messageBody, c.nombre, {
              link: link,
              maxChars: SMS_MAX_MESSAGE_CHARS,
            });
            return {
              phone: String(c.phone).trim(),
              text: skipAutoLink ? bodyWithName : `${bodyWithName} ${link}`,
              contact_id: c.id,
              source_system:
                c.source_system == null ? null : String(c.source_system),
              source_record_id: mapContactRecordId(c),
              marketing_impact_id: plan.impact_id,
            };
          });
        } else {
          messages = normalizedPhones.map((phone, i) => {
            const plan = trackingPlans[i];
            const link = skipAutoLink
              ? ''
              : composePublicShortUrl(plan.short_code);
            return {
              phone: phone,
              text: skipAutoLink
                ? String(messageBody)
                : `${messageBody} ${link}`,
              marketing_impact_id: plan.impact_id,
            };
          });
        }
      } else {
        let linkForMessage = '';
        if (!skipAutoLink) {
          finalUrl = composeFinalUrl(storedDestinationUrl, campaignId);

          // Real send: always shorten this campaign's final URL. Do not reuse preview shorts.
          const shortened = await shortenWithTinyUrl(finalUrl);
          if (shortened.shortUrl) {
            shortUrl = shortened.shortUrl;
          } else {
            shortUrl = null;
            logger.warn('SMS shortener fallback; using final_url', {
              kind: shortened.kind || 'shortener_error',
              campaign_id: campaignId,
            });
          }
          linkForMessage = shortUrl || finalUrl;
        }

        if (selectedContacts) {
          messages = selectedContacts.map((c) => {
            const bodyWithName = applyNombrePlaceholder(messageBody, c.nombre, {
              link: skipAutoLink ? '' : linkForMessage,
              maxChars: SMS_MAX_MESSAGE_CHARS,
            });
            return {
              phone: String(c.phone).trim(),
              text: skipAutoLink
                ? bodyWithName
                : `${bodyWithName} ${linkForMessage}`,
              contact_id: c.id,
              source_system:
                c.source_system == null ? null : String(c.source_system),
              source_record_id: mapContactRecordId(c),
            };
          });
        } else {
          const composedText = skipAutoLink
            ? String(messageBody)
            : `${messageBody} ${linkForMessage}`;
          messages = normalizedPhones.map((phone) => ({
            phone,
            text: composedText,
          }));
        }

        const { data, error } = await supabase
          .from('sms_campaigns')
          .insert({
            id: campaignId,
            name: name.trim(),
            total_messages: messages.length,
            status: 'sending',
            destination_url: storedDestinationUrl,
            utm_campaign_value: utmCampaignValue,
            short_url: shortUrl,
          })
          .select(
            SMS_CAMPAIGN_SELECT,
          )
          .limit(1);

        if (error || !data || !data[0]) {
          throw new NotifymeError(
            `Failed to create campaign: ${error ? error.message : 'no row returned'}`,
            { kind: 'database', status: 500 },
          );
        }
        campaign = data[0];
        if (shortUrl && finalUrl) {
          await attachShortLinkCampaignId(finalUrl, campaignId);
        }
      }
    }
  } catch (err) {
    if (!(err instanceof NotifymeError) && err && err.message) {
      return res.status(400).json({ error: err.message });
    }
    return mapServiceError(err, res);
  }

  try {
    if (individualTracking) {
      const n = Array.isArray(messages) ? messages.length : 0;
      const withImpact = (messages || []).filter(
        (m) => m && m.marketing_impact_id,
      ).length;
      if (!n || withImpact !== n) {
        await markCampaignPrepError(campaign && campaign.id);
        return res.status(500).json(
          jsonSafe({
            error:
              'Individual tracking did not close N impacts for N recipients',
            kind: 'database',
            campaign: campaign
              ? {
                  id: campaign.id,
                  name: campaign.name,
                  created_at: campaign.created_at,
                  total_messages: campaign.total_messages,
                  status: 'error',
                  destination_url:
                    campaign.destination_url != null
                      ? campaign.destination_url
                      : null,
                  utm_campaign_value:
                    campaign.utm_campaign_value != null
                      ? campaign.utm_campaign_value
                      : null,
                  short_url: null,
                  campaign_series_id:
                    campaign.campaign_series_id != null
                      ? campaign.campaign_series_id
                      : null,
                }
              : null,
            individual_tracking: true,
          }),
        );
      }
    }
    messages = applyWaveScheduledAt(messages, waveSize, intervalSeconds);
    const summary = await sendBatch(campaign.id, messages);
    const payload = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        created_at: campaign.created_at,
        total_messages: campaign.total_messages,
        status: summary.status,
        destination_url:
          campaign.destination_url != null ? campaign.destination_url : null,
        utm_campaign_value:
          campaign.utm_campaign_value != null
            ? campaign.utm_campaign_value
            : null,
        short_url: campaign.short_url != null ? campaign.short_url : null,
        campaign_series_id:
          campaign.campaign_series_id != null
            ? campaign.campaign_series_id
            : null,
      },
      summary,
    };
    if (finalUrl != null) {
      payload.final_url = finalUrl;
      payload.destination_url = storedDestinationUrl;
      payload.utm_campaign_value = utmCampaignValue;
      payload.short_url = shortUrl;
    }
    payload.individual_tracking = individualTracking;
    return res.status(201).json(jsonSafe(payload));
  } catch (err) {
    // Campaign + message rows preserved for auditability.
    if (err instanceof NotifymeError && err.summary) {
      const payload = {
        campaign: {
          id: campaign.id,
          name: campaign.name,
          created_at: campaign.created_at,
          total_messages: campaign.total_messages,
          status: err.summary.status,
          destination_url:
            campaign.destination_url != null ? campaign.destination_url : null,
          utm_campaign_value:
            campaign.utm_campaign_value != null
              ? campaign.utm_campaign_value
              : null,
          short_url: campaign.short_url != null ? campaign.short_url : null,
          campaign_series_id:
            campaign.campaign_series_id != null
              ? campaign.campaign_series_id
              : null,
        },
        error: err.message,
        kind: err.kind,
        code: err.code || null,
        summary: err.summary,
      };
      if (finalUrl != null) {
        payload.final_url = finalUrl;
        payload.destination_url = storedDestinationUrl;
        payload.utm_campaign_value = utmCampaignValue;
        payload.short_url = shortUrl;
      }
      payload.individual_tracking = individualTracking;
      return res.status(err.status === 400 ? 400 : 502).json(jsonSafe(payload));
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
      .select(
        SMS_CAMPAIGN_SELECT,
      )
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
 * Parse YYYY-MM; default to current UTC calendar month when omitted.
 * Returns null when the value is present but invalid.
 */
function parseMonthParam(raw) {
  if (raw == null || String(raw).trim() === '') {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const monthNum = Number(s.slice(5, 7));
  if (monthNum < 1 || monthNum > 12) return null;
  return s;
}

/**
 * UTC month bounds for delivered_at filtering, plus YYYY-MM-DD as-of date
 * for sms_cost_config (end of that calendar month).
 */
function monthBoundsUtc(yyyyMm) {
  const y = Number(yyyyMm.slice(0, 4));
  const m = Number(yyyyMm.slice(5, 7));
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const endExclusive = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const lastDay = new Date(Date.UTC(y, m, 0));
  return {
    startIso: start.toISOString(),
    endExclusiveIso: endExclusive.toISOString(),
    costAsOfDate: lastDay.toISOString().slice(0, 10),
    startDate: start.toISOString().slice(0, 10),
    endDate: lastDay.toISOString().slice(0, 10),
  };
}

/**
 * Cost config with latest effective_from <= asOfDate (YYYY-MM-DD).
 */
async function loadCostConfigAsOf(asOfDate) {
  const { data, error } = await supabase
    .from('sms_cost_config')
    .select('id, effective_from, cost_per_sms_ex_vat, vat_rate')
    .lte('effective_from', asOfDate)
    .order('effective_from', { ascending: false })
    .limit(1);

  if (error) {
    throw new NotifymeError(`Failed to load sms_cost_config: ${error.message}`, {
      kind: 'database',
      status: 500,
    });
  }
  return data && data[0] ? data[0] : null;
}

/**
 * GET /sms/campaigns/summary/monthly?month=YYYY-MM
 * Billing summary by delivery month (delivered_at), not campaign created_at.
 * Must be registered before /campaigns/:id so "summary" is not captured as an id.
 */
router.get('/campaigns/summary/monthly', async (req, res) => {
  const month = parseMonthParam(req.query.month);
  if (!month) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }

  try {
    const { startIso, endExclusiveIso, costAsOfDate } = monthBoundsUtc(month);

    // Same convention as per-campaign cost metrics: no delivered mapping → nulls.
    if (deliveredStatusSet.size === 0) {
      return res.json(
        jsonSafe({
          month,
          messages_delivered: null,
          estimated_cost: null,
        }),
      );
    }

    const deliveredStatuses = Array.from(deliveredStatusSet);
    const { count, error: countError } = await supabase
      .from('sms_messages')
      .select('unique_id', { count: 'exact', head: true })
      .not('delivered_at', 'is', null)
      .gte('delivered_at', startIso)
      .lt('delivered_at', endExclusiveIso)
      .in('status', deliveredStatuses);

    if (countError) {
      throw new NotifymeError(
        `Failed to count monthly delivered messages: ${countError.message}`,
        { kind: 'database', status: 500 },
      );
    }

    const messagesDelivered = count == null ? 0 : count;

    const costConfig = await loadCostConfigAsOf(costAsOfDate);
    let estimatedCost = null;
    if (costConfig) {
      const ex = Number(costConfig.cost_per_sms_ex_vat);
      const vat = Number(costConfig.vat_rate);
      if (Number.isFinite(ex) && Number.isFinite(vat)) {
        estimatedCost = ex * (1 + vat) * messagesDelivered;
      }
    }

    return res.json(
      jsonSafe({
        month,
        messages_delivered: messagesDelivered,
        estimated_cost: estimatedCost,
      }),
    );
  } catch (err) {
    return mapServiceError(err, res);
  }
});

/**
 * GET /sms/campaigns/summary/monthly/sessions?month=YYYY-MM
 * GA4 sessions attributed to sessionSource=sms + sessionMedium=sms for the month.
 * Registered before /campaigns/:id (static path).
 */
router.get('/campaigns/summary/monthly/sessions', async (req, res) => {
  const month = parseMonthParam(req.query.month);
  if (!month) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }

  const { startDate, endDate } = monthBoundsUtc(month);

  try {
    const client = buildGa4DataClient();
    const propertyId = getGa4PropertyId();
    const property = propertyId.startsWith('properties/')
      ? propertyId
      : `properties/${propertyId}`;

    const [response] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            {
              filter: {
                fieldName: 'sessionSource',
                stringFilter: {
                  matchType: 'EXACT',
                  value: 'sms',
                  caseSensitive: true,
                },
              },
            },
            {
              filter: {
                fieldName: 'sessionMedium',
                stringFilter: {
                  matchType: 'EXACT',
                  value: 'sms',
                  caseSensitive: true,
                },
              },
            },
          ],
        },
      },
    });

    let sessions = 0;
    const rows = response && response.rows ? response.rows : [];
    for (const row of rows) {
      const metricValues = row.metricValues || [];
      const raw = metricValues[0] && metricValues[0].value;
      if (raw === null || raw === undefined || raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n)) sessions += n;
    }

    return res.json(
      jsonSafe({
        month,
        sessions,
        query_status: 'success',
      }),
    );
  } catch (err) {
    const safeMessage =
      err && err.message ? String(err.message) : 'GA4 query failed';
    logger.error('SMS monthly GA4 sessions query failed', {
      month,
      error: safeMessage,
    });
    return res.json(
      jsonSafe({
        month,
        sessions: null,
        query_status: 'error',
        error: safeMessage,
      }),
    );
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
      .select(
        SMS_CAMPAIGN_SELECT,
      )
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
      .select(
        SMS_CAMPAIGN_SELECT,
      )
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
        // Include fresh message rows so the UI can re-render the per-message
        // table without relying on a possibly-cached GET.
        messages: refreshedRows.map(mapMessageRow),
        status_poll: statusSummary,
        response_poll: responseSummary,
      }),
    );
  } catch (err) {
    return mapServiceError(err, res);
  }
});

module.exports = router;
