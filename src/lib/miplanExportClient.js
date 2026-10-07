'use strict';

/**
 * Mi Deuda Stage 2 — HTTP client for the Mi Plan S2S opt-in export (pending/ACK delivery).
 * GET  {MIPLAN_EXPORT_BASE_URL}/internal/janus/v1/debt-optin-events?limit=   (pending events)
 * POST {MIPLAN_EXPORT_BASE_URL}/internal/janus/v1/debt-optin-events/ack      (durable-ingest ACK)
 * Authorization: Bearer MIPLAN_JANUS_EXPORT_SECRET (same dedicated secret for both). Errors carry
 * status/code only: never the secret, the URL query, or the response body.
 */

const EXPORT_PATH = '/internal/janus/v1/debt-optin-events';
const ACK_PATH = EXPORT_PATH + '/ack';
const EXPORT_CONTRACT_VERSION = 'miplan_debt_optin_export_v1';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

class MiplanUnavailableError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'MiplanUnavailableError';
    this.code = 'MIPLAN_UNAVAILABLE';
    this.status = detail && detail.status != null ? detail.status : null;
    this.retryable = !(detail && detail.retryable === false);
  }
}

/**
 * @param {{ baseUrl: string, secret: string, fetchImpl?: Function, timeoutMs?: number }} opts
 */
function createMiplanExportClient(opts) {
  const baseUrl = String((opts && opts.baseUrl) || '').replace(/\/+$/, '');
  const secret = opts && opts.secret;
  const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  if (!/^https?:\/\//.test(baseUrl) || !secret) {
    throw new MiplanUnavailableError('miplan export client not configured', { retryable: false });
  }

  async function call(label, url, init) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, Object.assign({}, init, { signal: controller.signal }));
    } catch (e) {
      clearTimeout(timer);
      const aborted = e && (e.name === 'AbortError' || controller.signal.aborted);
      throw new MiplanUnavailableError(aborted ? 'miplan ' + label + ' timeout' : 'miplan ' + label + ' network error');
    }
    try {
      if (!res.ok) {
        const status = res.status;
        throw new MiplanUnavailableError('miplan ' + label + ' http ' + status, {
          status: status,
          retryable: !(status === 400 || status === 401 || status === 403 || status === 404 || status === 422),
        });
      }
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) {
        throw new MiplanUnavailableError('miplan ' + label + ' body too large', { status: res.status, retryable: false });
      }
      try {
        return JSON.parse(text);
      } catch (_e) {
        throw new MiplanUnavailableError('miplan ' + label + ' body is not JSON', { status: res.status, retryable: false });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {{ limit: number }} args
   * @returns {Promise<object>} parsed JSON body (validated by the caller)
   */
  async function fetchPage(args) {
    const params = new URLSearchParams();
    params.set('limit', String(args.limit));
    return call('export', baseUrl + EXPORT_PATH + '?' + params.toString(), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + secret, Accept: 'application/json' },
    });
  }

  /**
   * Acknowledge events JANUS has durably ingested.
   * @param {{ event_id: string, janus_status: 'inserted'|'already_ingested' }[]} acks
   * @returns {Promise<{ acked: number, already_acked: number }>}
   */
  async function ackEvents(acks) {
    const body = await call('ack', baseUrl + ACK_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_version: EXPORT_CONTRACT_VERSION, acks: acks }),
    });
    if (!body || !Number.isInteger(body.acked) || !Number.isInteger(body.already_acked) ||
        body.acked + body.already_acked !== acks.length) {
      throw new MiplanUnavailableError('miplan ack response invalid', { retryable: false });
    }
    return body;
  }

  return { fetchPage, ackEvents };
}

module.exports = {
  EXPORT_PATH,
  ACK_PATH,
  MiplanUnavailableError,
  createMiplanExportClient,
};
