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
  MAX_FROM_CONTACTS_LIMIT,
  SMS_MAX_MESSAGE_CHARS,
  applyNombrePlaceholder,
  parseSourceSystem,
  parseLimit,
  normalizeDirectedPhones,
  loadContactsByPhones,
  countEligibleContacts,
  listEligibleContacts,
} = require('../lib/smsCampaignContacts');
const {
  PREVIEW_UTM_CAMPAIGN_UUID,
  looksLikeHttpUrl,
  composeFinalUrl,
  shortenWithTinyUrl,
  getOrCreatePreviewShortUrl,
} = require('../lib/smsTinyUrl');

const router = express.Router();

/**
 * Empirically confirmed Notifyme raw delivered statuses (case-sensitive).
 * Extend this array as additional delivered values are observed in real polls.
 */
const DELIVERED_STATUS_VALUES = ['DELIVERED'];
const deliveredStatusSet = new Set(DELIVERED_STATUS_VALUES);

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
 * GET /sms/contacts/eligible?source_system=
 * Count of contacts matching the same eligibility used by POST from_contacts.
 */
router.get('/contacts/eligible', async (req, res) => {
  const sourceSystem = parseSourceSystem(req.query && req.query.source_system);
  if (!sourceSystem) {
    return res.status(400).json({ error: 'source_system is required' });
  }
  try {
    const count = await countEligibleContacts(sourceSystem);
    return res.json(
      jsonSafe({
        source_system: sourceSystem,
        count,
        max_limit: MAX_FROM_CONTACTS_LIMIT,
      }),
    );
  } catch (err) {
    logger.error('GET /sms/contacts/eligible failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Failed to count eligible contacts' });
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
          'id, name, created_at, total_messages, status, destination_url, utm_campaign_value, short_url',
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

      let normalizedPhones = null;
      let selectedContacts = null;
      if (useFromContacts) {
        if (Array.isArray(fromContactsRaw.phones)) {
          const hasAutoFields =
            parseSourceSystem(fromContactsRaw.source_system) != null ||
            (fromContactsRaw.limit != null &&
              String(fromContactsRaw.limit).trim() !== '');
          if (hasAutoFields) {
            return res.status(400).json({
              error:
                'from_contacts.phones cannot be combined with source_system or limit',
            });
          }
          const directedPhones = normalizeDirectedPhones(fromContactsRaw.phones);
          if (!directedPhones.length) {
            return res.status(400).json({
              error: 'from_contacts.phones must contain at least one non-empty value',
            });
          }
          if (directedPhones.length > MAX_FROM_CONTACTS_LIMIT) {
            return res.status(400).json({
              error:
                'from_contacts.phones cannot exceed ' +
                String(MAX_FROM_CONTACTS_LIMIT) +
                ' numbers',
            });
          }
          let loaded;
          try {
            loaded = await loadContactsByPhones(directedPhones);
          } catch (lookupErr) {
            throw new NotifymeError(
              lookupErr && lookupErr.message
                ? lookupErr.message
                : 'sms_contacts phone lookup failed',
              { kind: 'database', status: 500 },
            );
          }
          if (loaded.missing_phones.length) {
            return res.status(400).json({
              error: 'Unknown sms_contacts phones',
              missing_phones: loaded.missing_phones,
            });
          }
          selectedContacts = loaded.contacts;
        } else {
          const sourceSystem = parseSourceSystem(fromContactsRaw.source_system);
          const limit = parseLimit(
            fromContactsRaw.limit,
            MAX_FROM_CONTACTS_LIMIT,
          );
          if (!sourceSystem) {
            return res.status(400).json({
              error: 'from_contacts.source_system is required',
            });
          }
          if (limit == null) {
            return res.status(400).json({
              error:
                'from_contacts.limit must be an integer from 1 to ' +
                String(MAX_FROM_CONTACTS_LIMIT),
            });
          }
          try {
            selectedContacts = await listEligibleContacts(sourceSystem, limit);
          } catch (listErr) {
            throw new NotifymeError(
              listErr && listErr.message
                ? listErr.message
                : 'eligible contacts query failed',
              { kind: 'database', status: 500 },
            );
          }
          if (!selectedContacts.length) {
            return res.status(400).json({
              error: 'No eligible contacts for that source_system',
              source_system: sourceSystem,
              count: 0,
            });
          }
        }
      } else {
        if (!Array.isArray(phones) || phones.length === 0) {
          return res.status(400).json({
            error: 'phones must be a non-empty array',
          });
        }
        normalizedPhones = phones
          .map((p) => (p == null ? '' : String(p).trim()))
          .filter((p) => p.length > 0);
        if (!normalizedPhones.length) {
          return res.status(400).json({
            error: 'phones must contain at least one non-empty value',
          });
        }
      }

      // Generate UUID first so UTM and DB row share the same id in one insert.
      const campaignId = randomUUID();
      storedDestinationUrl = String(destinationUrlRaw).trim();
      utmCampaignValue = campaignId;
      finalUrl = composeFinalUrl(storedDestinationUrl, campaignId);

      // Real send: always shorten this campaign's final URL. Do not reuse preview shorts.
      const shortened = await shortenWithTinyUrl(finalUrl);
      if (shortened.shortUrl) {
        shortUrl = shortened.shortUrl;
      } else {
        shortUrl = null;
        logger.warn('is.gd shorten failed; falling back to final_url', {
          reason: shortened.reason,
          campaign_id: campaignId,
        });
      }

      const linkForMessage = shortUrl || finalUrl;
      if (selectedContacts) {
        messages = selectedContacts.map((c) => {
          const bodyWithName = applyNombrePlaceholder(messageBody, c.nombre, {
            link: linkForMessage,
            maxChars: SMS_MAX_MESSAGE_CHARS,
          });
          const recordId =
            c.source_record_id == null || c.source_record_id === ''
              ? null
              : String(c.source_record_id);
          return {
            phone: String(c.phone).trim(),
            text: `${bodyWithName} ${linkForMessage}`,
            contact_id: c.id,
            source_system:
              c.source_system == null ? null : String(c.source_system),
            source_record_id: recordId,
          };
        });
      } else {
        const composedText = `${messageBody} ${linkForMessage}`;
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
          'id, name, created_at, total_messages, status, destination_url, utm_campaign_value, short_url',
        )
        .limit(1);

      if (error || !data || !data[0]) {
        throw new NotifymeError(
          `Failed to create campaign: ${error ? error.message : 'no row returned'}`,
          { kind: 'database', status: 500 },
        );
      }
      campaign = data[0];
    }
  } catch (err) {
    if (!(err instanceof NotifymeError) && err && err.message) {
      return res.status(400).json({ error: err.message });
    }
    return mapServiceError(err, res);
  }

  try {
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
      },
      summary,
    };
    if (finalUrl != null) {
      payload.final_url = finalUrl;
      payload.destination_url = storedDestinationUrl;
      payload.utm_campaign_value = utmCampaignValue;
      payload.short_url = shortUrl;
    }
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
        'id, name, created_at, total_messages, status, destination_url, utm_campaign_value, short_url',
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
        'id, name, created_at, total_messages, status, destination_url, utm_campaign_value, short_url',
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
        'id, name, created_at, total_messages, status, destination_url, utm_campaign_value, short_url',
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
