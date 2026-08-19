/**
 * Notifyme (T2voice) SOAP client for autonomous SMS campaigns.
 *
 * Unique ID rule: sms_messages.unique_id is a Postgres bigint identity.
 * Keep it as a decimal string everywhere (DB → memory → SOAP → API).
 * NEVER use Number() / parseInt() on unique_id.
 *
 * deliverMessages returns void. A transport timeout after the request left
 * the client is ambiguous — the SMS may or may not have been accepted.
 * Do NOT auto-retry deliverMessages (duplicate SMS risk).
 */

const soap = require('soap');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const NOTIFYME_WSDL_URL =
  'https://notifyme.t2voice.com/t2engine-t2notify/NotifymeSmsWsBean?wsdl';
const NOTIFYME_SOAP_ENDPOINT =
  'https://notifyme.t2voice.com/t2engine-t2notify/NotifymeSmsWsBean';

const DELIVER_CHUNK_SIZE = 2000;
const POLL_CHUNK_SIZE = 500;

// Connection / request timeouts supported by the `soap` package.
const SOAP_WSDL_TIMEOUT_MS = 30000;
const SOAP_REQUEST_TIMEOUT_MS = 60000;

/**
 * Provider-documented raw status values that mean "delivered / billable".
 * Null until Notifyme status catalogue is confirmed — cost metrics then
 * return messages_delivered / estimated_cost as null rather than guessing.
 * @type {Set<string>|null}
 */
const DELIVERED_STATUS_VALUES = null;

let cachedClientPromise = null;

class NotifymeError extends Error {
  constructor(message, { kind = 'soap', status = 502, code = null, detail = null } = {}) {
    super(message);
    this.name = 'NotifymeError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function requireCredentials() {
  const username = process.env.NOTIFYME_USERNAME;
  const password = process.env.NOTIFYME_PASSWORD;
  if (!username || !password) {
    throw new NotifymeError(
      'NOTIFYME_USERNAME and NOTIFYME_PASSWORD must be configured',
      { kind: 'config', status: 500 },
    );
  }
  return { username, password };
}

function assertUniqueIdString(value, context) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new NotifymeError(
      `unique_id must remain a decimal string (${context})`,
      { kind: 'internal', status: 500 },
    );
  }
  return value;
}

/**
 * Normalize SOAP `return` which may be undefined, a single object, or an array.
 */
function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueIdFromSoap(value) {
  if (value == null) return null;
  // SOAP may return long as string or number; coerce to decimal string without
  // going through Number() for large values — String(number) can lose precision
  // for integers outside Number.MAX_SAFE_INTEGER. Prefer existing string form.
  if (typeof value === 'string') {
    return assertUniqueIdString(value.trim(), 'soap response');
  }
  if (typeof value === 'bigint') {
    return value.toString(10);
  }
  // Defensive: if soap already parsed as Number within safe integer range,
  // stringify; otherwise reject rather than silently corrupt.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  throw new NotifymeError(
    'SOAP uniqueId could not be preserved as a decimal string',
    { kind: 'soap', status: 502 },
  );
}

async function createSoapClient() {
  const client = await soap.createClientAsync(NOTIFYME_WSDL_URL, {
    wsdl_options: { timeout: SOAP_WSDL_TIMEOUT_MS },
  });

  // Force HTTPS endpoint when WSDL <soap:address> resolves to http://...
  let resolvedLocation = null;
  try {
    resolvedLocation =
      client.wsdl &&
      client.wsdl.services &&
      client.wsdl.services.NotifymeSmsWsBeanService &&
      client.wsdl.services.NotifymeSmsWsBeanService.ports &&
      client.wsdl.services.NotifymeSmsWsBeanService.ports.NotifymeSmsWsBeanPort &&
      client.wsdl.services.NotifymeSmsWsBeanService.ports.NotifymeSmsWsBeanPort
        .location;
  } catch (ignore) {
    resolvedLocation = null;
  }

  if (resolvedLocation && resolvedLocation !== NOTIFYME_SOAP_ENDPOINT) {
    client.setEndpoint(NOTIFYME_SOAP_ENDPOINT);
    logger.warn('Notifyme SOAP endpoint overridden to HTTPS', {
      wsdlLocation: resolvedLocation,
      forcedEndpoint: NOTIFYME_SOAP_ENDPOINT,
    });
  }

  // Request-level timeout for SOAP HTTP calls (node-soap / request options).
  if (typeof client.setSecurity !== 'function') {
    // no-op — credentials are passed per-operation args, not WS-Security
  }
  client.request = client.request || undefined;
  if (client.wsdl && client.wsdl.options) {
    client.wsdl.options.timeout = SOAP_REQUEST_TIMEOUT_MS;
  }

  return client;
}

function getSoapClient() {
  if (!cachedClientPromise) {
    cachedClientPromise = createSoapClient().catch((err) => {
      cachedClientPromise = null;
      throw err;
    });
  }
  return cachedClientPromise;
}

function validateMessagesInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new NotifymeError('messages must be a non-empty array', {
      kind: 'validation',
      status: 400,
    });
  }

  const normalized = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const phone = m.phone;
    const text = m.text;

    if (typeof phone !== 'string' || !phone.trim()) {
      throw new NotifymeError(`messages[${i}].phone must be a non-empty string`, {
        kind: 'validation',
        status: 400,
      });
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new NotifymeError(`messages[${i}].text must be a non-empty string`, {
        kind: 'validation',
        status: 400,
      });
    }

    let scheduledAt = null;
    if (m.scheduledAt != null && m.scheduledAt !== '') {
      const d = new Date(m.scheduledAt);
      if (Number.isNaN(d.getTime())) {
        throw new NotifymeError(`messages[${i}].scheduledAt is not a valid date`, {
          kind: 'validation',
          status: 400,
        });
      }
      scheduledAt = d.toISOString();
    }

    const optionalString = (field, value) => {
      if (value == null || value === '') return null;
      if (typeof value !== 'string') {
        throw new NotifymeError(`messages[${i}].${field} must be a string or null`, {
          kind: 'validation',
          status: 400,
        });
      }
      return value;
    };

    let contactId = null;
    if (m.contact_id != null && m.contact_id !== '') {
      if (typeof m.contact_id !== 'string') {
        throw new NotifymeError(
          `messages[${i}].contact_id must be a string or null`,
          { kind: 'validation', status: 400 },
        );
      }
      const trimmedId = m.contact_id.trim();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          trimmedId,
        )
      ) {
        throw new NotifymeError(`messages[${i}].contact_id must be a UUID`, {
          kind: 'validation',
          status: 400,
        });
      }
      contactId = trimmedId;
    }

    // Do not normalize, infer, or enrich optional identity fields.
    normalized.push({
      phone: phone.trim(),
      text,
      scheduledAt,
      contact_id: contactId,
      source_system: optionalString('source_system', m.source_system),
      source_record_id: optionalString('source_record_id', m.source_record_id),
      czuid: optionalString('czuid', m.czuid),
      submission_order: i,
    });
  }
  return normalized;
}

async function updateCampaignStatus(campaignId, status) {
  const { error } = await supabase
    .from('sms_campaigns')
    .update({ status })
    .eq('id', campaignId);
  if (error) {
    throw new NotifymeError(`Failed to update campaign status: ${error.message}`, {
      kind: 'database',
      status: 500,
    });
  }
}

function mapSoapFault(err) {
  const fault = err && (err.root || err.Fault || err.fault || err);
  const code =
    (fault && fault.detail && fault.detail.NotifymeWSException && fault.detail.NotifymeWSException.code) ||
    (fault && fault.code) ||
    (err && err.code) ||
    null;
  const message =
    (fault && fault.detail && fault.detail.NotifymeWSException && fault.detail.NotifymeWSException.message) ||
    (fault && fault.faultstring) ||
    (err && err.message) ||
    'Notifyme SOAP fault';

  const isTimeout =
    (err && err.code === 'ETIMEDOUT') ||
    (err && err.code === 'ESOCKETTIMEDOUT') ||
    /timeout/i.test(String(err && err.message ? err.message : ''));

  if (isTimeout) {
    // Ambiguous: deliverMessages is void — the provider may have accepted the batch.
    return new NotifymeError(
      'Notifyme SOAP transport timeout (delivery status ambiguous; not auto-retried)',
      { kind: 'timeout', status: 504, code: err.code || 'TIMEOUT', detail: message },
    );
  }

  return new NotifymeError(message, {
    kind: 'soap_fault',
    status: 502,
    code: code != null ? String(code) : null,
    detail: message,
  });
}

/**
 * Insert all campaign messages in one multi-row insert, then return rows
 * sorted by submission_order (never trust insert-return array order alone).
 */
async function insertCampaignMessages(campaignId, normalizedMessages) {
  const rows = normalizedMessages.map((m) => ({
    campaign_id: campaignId,
    submission_order: m.submission_order,
    phone: m.phone,
    text: m.text,
    scheduled_at: m.scheduledAt,
    status: 'pending',
    contact_id: m.contact_id,
    source_system: m.source_system,
    source_record_id: m.source_record_id,
    czuid: m.czuid,
  }));

  const { data, error } = await supabase
    .from('sms_messages')
    .insert(rows)
    .select(
      'unique_id, campaign_id, submission_order, phone, text, scheduled_at, status, contact_id, source_system, source_record_id, czuid',
    );

  if (error) {
    throw new NotifymeError(`Failed to insert sms_messages: ${error.message}`, {
      kind: 'database',
      status: 500,
    });
  }
  if (!data || data.length !== rows.length) {
    throw new NotifymeError('Insert returned unexpected row count', {
      kind: 'database',
      status: 500,
    });
  }

  const withIds = data.map((row) => ({
    ...row,
    unique_id: assertUniqueIdString(String(row.unique_id), 'insert returning'),
  }));

  withIds.sort((a, b) => a.submission_order - b.submission_order);
  return withIds;
}

function buildDataSmsPayload(rows) {
  return rows.map((row) => {
    const msg = {
      phone: row.phone,
      text: row.text,
      // Keep uniqueId as decimal string for xs:long serialization without JS Number.
      uniqueId: assertUniqueIdString(String(row.unique_id), 'soap payload'),
    };
    if (row.scheduled_at) {
      msg.schedule = new Date(row.scheduled_at).toISOString();
    }
    return msg;
  });
}

async function deliverChunk(client, credentials, chunkRows, meta) {
  const payload = {
    username: credentials.username,
    password: credentials.password,
    messages: buildDataSmsPayload(chunkRows),
  };

  logger.info('Notifyme deliverMessages', {
    operation: 'deliverMessages',
    campaignId: meta.campaignId,
    chunkIndex: meta.chunkIndex,
    chunkSize: chunkRows.length,
  });

  try {
    // void response — success means no fault thrown.
    // Timeout after send is ambiguous; callers must NOT auto-retry.
    await client.deliverMessagesAsync(payload, {
      timeout: SOAP_REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    throw mapSoapFault(err);
  }
}

/**
 * Send a campaign batch via Notifyme.
 * @param {string} campaignId
 * @param {Array<object>} messages
 */
async function sendBatch(campaignId, messages) {
  if (!campaignId || typeof campaignId !== 'string') {
    throw new NotifymeError('campaignId is required', { kind: 'validation', status: 400 });
  }

  const normalized = validateMessagesInput(messages);
  const credentials = requireCredentials();
  const inserted = await insertCampaignMessages(campaignId, normalized);

  const totalChunks = Math.ceil(inserted.length / DELIVER_CHUNK_SIZE) || 0;
  let chunksSucceeded = 0;
  let failedChunkIndex = null;
  let failureError = null;

  await updateCampaignStatus(campaignId, 'sending');

  const client = await getSoapClient();

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * DELIVER_CHUNK_SIZE;
    const chunkRows = inserted.slice(start, start + DELIVER_CHUNK_SIZE);
    try {
      await deliverChunk(client, credentials, chunkRows, { campaignId, chunkIndex });
      chunksSucceeded += 1;
    } catch (err) {
      failedChunkIndex = chunkIndex;
      failureError = err;
      // Stop after first failed chunk — do not attempt further chunks.
      break;
    }
  }

  const messagesInSuccessfulChunks =
    failedChunkIndex == null
      ? inserted.length
      : Math.min(inserted.length, chunksSucceeded * DELIVER_CHUNK_SIZE);
  const messagesNotAttempted =
    failedChunkIndex == null
      ? 0
      : Math.max(0, inserted.length - (failedChunkIndex + 1) * DELIVER_CHUNK_SIZE);

  let finalStatus = 'sent';
  if (failedChunkIndex != null) {
    finalStatus = chunksSucceeded === 0 ? 'error' : 'partial_error';
  }
  await updateCampaignStatus(campaignId, finalStatus);

  // Successful deliverMessages leaves rows as 'pending' until getMessagesStatus confirms.
  const summary = {
    campaignId,
    status: finalStatus,
    total_messages: inserted.length,
    total_chunks: totalChunks,
    chunks_attempted: failedChunkIndex == null ? totalChunks : failedChunkIndex + 1,
    chunks_succeeded: chunksSucceeded,
    failed_chunk_index: failedChunkIndex,
    messages_in_successful_chunks: messagesInSuccessfulChunks,
    messages_not_attempted: messagesNotAttempted,
    messages_submitted_estimate: messagesInSuccessfulChunks,
  };

  if (failureError) {
    logger.error('Notifyme sendBatch incomplete', {
      campaignId,
      status: finalStatus,
      chunksSucceeded,
      failedChunkIndex,
      error: failureError.message,
      code: failureError.code || null,
    });
    const wrapped = failureError instanceof NotifymeError
      ? failureError
      : mapSoapFault(failureError);
    wrapped.summary = summary;
    throw wrapped;
  }

  logger.info('Notifyme sendBatch complete', {
    campaignId,
    status: finalStatus,
    total_chunks: totalChunks,
    chunks_succeeded: chunksSucceeded,
  });

  return summary;
}

async function pollStatus(uniqueIds) {
  if (!Array.isArray(uniqueIds) || uniqueIds.length === 0) {
    throw new NotifymeError('uniqueIds must be a non-empty array of decimal strings', {
      kind: 'validation',
      status: 400,
    });
  }

  const ids = uniqueIds.map((id, i) =>
    assertUniqueIdString(String(id), `pollStatus[${i}]`),
  );
  const credentials = requireCredentials();
  const client = await getSoapClient();

  let returnedCount = 0;
  let updatedCount = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < ids.length; i += POLL_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + POLL_CHUNK_SIZE);
    let result;
    try {
      logger.info('Notifyme getMessagesStatus', {
        operation: 'getMessagesStatus',
        chunkSize: chunk.length,
      });
      // Pass decimal strings — do not coerce to Number.
      const [response] = await client.getMessagesStatusAsync(
        {
          username: credentials.username,
          password: credentials.password,
          messageIds: chunk,
        },
        { timeout: SOAP_REQUEST_TIMEOUT_MS },
      );
      result = response;
    } catch (err) {
      throw mapSoapFault(err);
    }

    const items = asArray(result && result.return);
    returnedCount += items.length;

    for (const item of items) {
      let uid;
      try {
        uid = uniqueIdFromSoap(item.uniqueId);
      } catch (e) {
        logger.warn('Skipping status row with unusable uniqueId', {
          error: e.message,
        });
        continue;
      }

      const patch = {
        // Store raw provider reason unmodified (null stays null).
        fail_reason: item.reason == null ? null : String(item.reason),
        last_polled_at: nowIso,
      };
      if (item.status != null) {
        // Store raw provider status unmodified — no invented mappings.
        patch.status = String(item.status);
      }
      // Do not clear existing delivered_at unless Notifyme returns a replacement.
      if (item.delivered != null && item.delivered !== '') {
        const d = new Date(item.delivered);
        if (!Number.isNaN(d.getTime())) {
          patch.delivered_at = d.toISOString();
        }
      }

      const { data, error } = await supabase
        .from('sms_messages')
        .update(patch)
        .eq('unique_id', uid)
        .select('unique_id');

      if (error) {
        throw new NotifymeError(`Failed to update status for unique_id: ${error.message}`, {
          kind: 'database',
          status: 500,
        });
      }
      if (data && data.length) updatedCount += data.length;
    }
  }

  return {
    requested: ids.length,
    returned: returnedCount,
    updated: updatedCount,
  };
}

async function pollResponses(uniqueIds) {
  if (!Array.isArray(uniqueIds) || uniqueIds.length === 0) {
    throw new NotifymeError('uniqueIds must be a non-empty array of decimal strings', {
      kind: 'validation',
      status: 400,
    });
  }

  const ids = uniqueIds.map((id, i) =>
    assertUniqueIdString(String(id), `pollResponses[${i}]`),
  );
  const credentials = requireCredentials();
  const client = await getSoapClient();

  let returnedCount = 0;
  let updatedCount = 0;

  for (let i = 0; i < ids.length; i += POLL_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + POLL_CHUNK_SIZE);
    let result;
    try {
      logger.info('Notifyme getMessagesResponse', {
        operation: 'getMessagesResponse',
        chunkSize: chunk.length,
      });
      // Exact WSDL / client method: getMessagesResponse (not getMessagesResponses).
      const [response] = await client.getMessagesResponseAsync(
        {
          username: credentials.username,
          password: credentials.password,
          messageIds: chunk,
        },
        { timeout: SOAP_REQUEST_TIMEOUT_MS },
      );
      result = response;
    } catch (err) {
      throw mapSoapFault(err);
    }

    const items = asArray(result && result.return);
    returnedCount += items.length;

    for (const item of items) {
      let uid;
      try {
        uid = uniqueIdFromSoap(item.uniqueId);
      } catch (e) {
        logger.warn('Skipping response row with unusable uniqueId', {
          error: e.message,
        });
        continue;
      }

      const responseText =
        item.text == null || item.text === '' ? null : String(item.text);
      // Preserve existing response — do not overwrite with null/empty.
      if (responseText == null) {
        continue;
      }

      const patch = {
        response_text: responseText,
      };
      if (item.received != null && item.received !== '') {
        const d = new Date(item.received);
        if (!Number.isNaN(d.getTime())) {
          patch.response_received_at = d.toISOString();
        }
      } else {
        patch.response_received_at = new Date().toISOString();
      }

      const { data, error } = await supabase
        .from('sms_messages')
        .update(patch)
        .eq('unique_id', uid)
        .select('unique_id');

      if (error) {
        throw new NotifymeError(`Failed to update response for unique_id: ${error.message}`, {
          kind: 'database',
          status: 500,
        });
      }
      if (data && data.length) updatedCount += data.length;
    }
  }

  return {
    requested: ids.length,
    returned: returnedCount,
    updated: updatedCount,
  };
}

/**
 * Load Copanel cost config effective on/before today (UTC date).
 */
async function loadActiveCostConfig() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('sms_cost_config')
    .select('id, effective_from, cost_per_sms_ex_vat, vat_rate')
    .lte('effective_from', today)
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

  if (DELIVERED_STATUS_VALUES && DELIVERED_STATUS_VALUES.size > 0) {
    messages_delivered = 0;
    for (const [status, count] of Object.entries(statusCounts || {})) {
      if (DELIVERED_STATUS_VALUES.has(status)) {
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
    delivered_status_mapping_configured: Boolean(
      DELIVERED_STATUS_VALUES && DELIVERED_STATUS_VALUES.size > 0,
    ),
  };
}

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
    if (row.response_received_at != null || (row.response_text != null && row.response_text !== '')) {
      responded += 1;
    }
  }

  // Only alias delivered/failed when an explicit mapping is configured.
  if (DELIVERED_STATUS_VALUES && DELIVERED_STATUS_VALUES.size > 0) {
    delivered = 0;
    for (const [st, n] of Object.entries(status_counts)) {
      if (DELIVERED_STATUS_VALUES.has(st)) delivered += n;
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

/**
 * Safety net for Express JSON: native BigInt is not JSON-serializable.
 * Primary rule is never creating BigInt for unique_id; this is defensive only.
 */
function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
  );
}

module.exports = {
  sendBatch,
  pollStatus,
  pollResponses,
  loadActiveCostConfig,
  buildCostMetrics,
  aggregateMessageStats,
  jsonSafe,
  NotifymeError,
  DELIVER_CHUNK_SIZE,
  POLL_CHUNK_SIZE,
  DELIVERED_STATUS_VALUES,
  NOTIFYME_WSDL_URL,
  NOTIFYME_SOAP_ENDPOINT,
  getSoapClient,
  assertUniqueIdString,
};
