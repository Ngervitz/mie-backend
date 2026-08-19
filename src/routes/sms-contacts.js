/**
 * SMS contacts import from Credizona (IT CSV sync).
 * Does NOT write to Credizona CRM. Isolated from Notifyme campaign send paths.
 */

const express = require('express');
const multer = require('multer');
const { parse: parseCsvSync } = require('csv-parse/sync');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const router = express.Router();

const BATCH_SIZE = 500;
const MAX_REJECTED_SAMPLES = 50;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const WEBHOOK_TIMEOUT_MS = 15000;

const IMPORT_API_KEY = process.env.SMS_CONTACTS_IMPORT_API_KEY;
const ALERT_WEBHOOK_URL = process.env.MAKE_CONTACTS_ALERT_WEBHOOK_URL;

if (!IMPORT_API_KEY) {
  logger.error(
    'SMS_CONTACTS_IMPORT_API_KEY is not set — POST /sms/contacts/import will reject all requests',
  );
}

if (!ALERT_WEBHOOK_URL) {
  logger.warn(
    'MAKE_CONTACTS_ALERT_WEBHOOK_URL is not set — contact import alerts will be skipped',
  );
}

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const name = String(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const okExt = name.endsWith('.csv') || name.endsWith('.txt');
    const okMime =
      !mime ||
      mime === 'text/csv' ||
      mime === 'text/plain' ||
      mime === 'application/csv' ||
      mime === 'application/vnd.ms-excel' ||
      mime === 'application/octet-stream';
    if (okExt || okMime) return cb(null, true);
    const err = new Error('Only CSV files are accepted');
    err.statusCode = 400;
    return cb(err);
  },
});

function requireImportApiKey(req, res, next) {
  const provided = req.get('x-api-key');
  if (!IMPORT_API_KEY || provided !== IMPORT_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

/**
 * Count comma vs semicolon outside quotes on the first logical line.
 * Prefer ';' only when it clearly wins (Excel ES/UY exports).
 */
function detectDelimiter(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  let firstLine = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (inQuotes && input[i + 1] === '"') {
        firstLine += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      firstLine += ch;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      break;
    }
    firstLine += ch;
  }

  let commas = 0;
  let semis = 0;
  inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') {
      if (inQuotes && firstLine[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === ',') commas += 1;
    else if (ch === ';') semis += 1;
  }

  if (semis > commas) return ';';
  return ',';
}

/**
 * Parse CSV buffer/text with csv-parse (sync).
 * Returns records as plain objects with lowercased headers, plus skipped structural errors.
 * On whole-file structural failure, throws (caller must not upsert).
 */
function parseContactsCsv(text, delimiter) {
  const skipped = [];
  const records = parseCsvSync(text, {
    bom: true,
    columns: (headers) =>
      headers.map((h) => String(h == null ? '' : h).trim().toLowerCase()),
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    skip_records_with_error: true,
    relax_quotes: false,
    raw: true,
    on_skip(err, raw) {
      skipped.push({
        raw: raw == null ? '' : String(raw),
        reason:
          err && err.message
            ? String(err.message)
            : 'csv_parse_error',
      });
    },
  });

  const rows = (records || []).map((entry, index) => {
    // raw:true → { record, raw }; defensive if shape differs
    if (entry && typeof entry === 'object' && entry.record) {
      return {
        record: entry.record,
        raw: entry.raw == null ? '' : String(entry.raw).replace(/\r?\n$/, ''),
        rowNumber: index + 2,
      };
    }
    return {
      record: entry || {},
      raw: '',
      rowNumber: index + 2,
    };
  });

  return { rows, skipped };
}

function extractCsvHeaders(text, delimiter) {
  const headerRows = parseCsvSync(text, {
    bom: true,
    to_line: 1,
    relax_column_count: true,
    delimiter,
  });
  return (headerRows[0] || []).map((h) =>
    String(h == null ? '' : h).trim().toLowerCase(),
  );
}

function isValidPhone(phone) {
  if (phone == null) return false;
  const trimmed = String(phone).trim();
  if (!trimmed) return false;
  // Require at least one digit; preserve remaining text as provided.
  return /\d/.test(trimmed);
}

function normalizeSourceRecordId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeOptionalText(value) {
  return normalizeSourceRecordId(value);
}

async function sendAlertWebhook(payload) {
  if (!ALERT_WEBHOOK_URL) {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.error('MAKE contacts alert webhook failed', {
        status: res.status,
        import_id: payload && payload.import_id ? payload.import_id : null,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('MAKE contacts alert webhook error', {
      error: err && err.message ? err.message : 'unknown',
      import_id: payload && payload.import_id ? payload.import_id : null,
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function upsertContactBatch(batch, importBatchId) {
  if (!batch.length) {
    return { inserted: 0, updated: 0 };
  }

  // Last occurrence wins within the batch (unique phone constraint).
  const byPhone = new Map();
  for (const r of batch) {
    byPhone.set(r.phone, r);
  }
  const deduped = Array.from(byPhone.values());

  const phones = deduped.map((r) => r.phone);
  const { data: existingRows, error: existingError } = await supabase
    .from('sms_contacts')
    .select('phone')
    .in('phone', phones);

  if (existingError) {
    throw new Error(`Failed to load existing contacts: ${existingError.message}`);
  }

  const existingSet = new Set(
    (existingRows || []).map((r) => String(r.phone)),
  );

  const nowIso = new Date().toISOString();

  // Split by which optional keys are present so PostgREST never fills omitted
  // source_record_id / nombre / apellido as null on conflict.
  const groups = new Map();
  for (const r of deduped) {
    const row = {
      phone: r.phone,
      source_system:
        r.source_system != null ? r.source_system : 'credizona2_datos',
      last_seen_at: nowIso,
      import_batch_id: importBatchId,
    };
    if (r.source_record_id != null) row.source_record_id = r.source_record_id;
    if (r.nombre != null) row.nombre = r.nombre;
    if (r.apellido != null) row.apellido = r.apellido;
    const key = [
      r.source_record_id != null ? 's' : '',
      r.nombre != null ? 'n' : '',
      r.apellido != null ? 'a' : '',
    ].join('');
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  async function runUpsert(rows) {
    if (!rows.length) return;
    const { error: upsertError } = await supabase.from('sms_contacts').upsert(rows, {
      onConflict: 'phone',
    });
    if (upsertError) {
      throw new Error(`Failed to upsert contacts: ${upsertError.message}`);
    }
  }

  for (const rows of groups.values()) {
    await runUpsert(rows);
  }

  let inserted = 0;
  let updated = 0;
  for (const r of deduped) {
    if (existingSet.has(r.phone)) updated += 1;
    else inserted += 1;
  }
  return { inserted, updated };
}

/**
 * POST /sms/contacts/import
 * multipart field "file" — CSV with header: phone (required);
 * optional: source_record_id, nombre, apellido, source_system.
 * Missing/blank source_system falls back to credizona2_datos.
 */
router.post(
  '/contacts/import',
  requireImportApiKey,
  (req, res, next) => {
    csvUpload.single('file')(req, res, (err) => {
      if (!err) return next();
      const status = err.statusCode || (err instanceof multer.MulterError ? 400 : 500);
      return res.status(status).json({
        error: err.message || 'Upload failed',
      });
    });
  },
  async (req, res) => {
    let importId = null;
    const filename =
      req.file && req.file.originalname ? String(req.file.originalname) : null;
    let rowsReceived = 0;
    let rowsInserted = 0;
    let rowsUpdated = 0;
    let rowsRejected = 0;
    const rejectedSamples = [];
    let fatalError = null;
    let delimiterDetected = null;

    try {
      const { data: importRow, error: importInsertError } = await supabase
        .from('sms_contact_imports')
        .insert({
          filename,
          rows_received: 0,
          rows_inserted: 0,
          rows_updated: 0,
          rows_rejected: 0,
          alert_sent: false,
        })
        .select('id')
        .single();

      if (importInsertError || !importRow) {
        throw new Error(
          importInsertError
            ? `Failed to create import record: ${importInsertError.message}`
            : 'Failed to create import record',
        );
      }
      importId = importRow.id;

      if (!req.file || !req.file.buffer) {
        fatalError = 'Missing CSV file field "file"';
      } else {
        const text = req.file.buffer.toString('utf8');
        delimiterDetected = detectDelimiter(text);

        let headers;
        try {
          headers = extractCsvHeaders(text, delimiterDetected);
        } catch (headerErr) {
          fatalError =
            headerErr && headerErr.message
              ? `CSV parse failed: ${headerErr.message}`
              : 'CSV parse failed';
          headers = null;
        }

        if (headers && !headers.includes('phone')) {
          fatalError = 'CSV header row must include a "phone" column';
        }

        if (!fatalError) {
          let parsed;
          try {
            parsed = parseContactsCsv(text, delimiterDetected);
          } catch (parseErr) {
            // Whole-file structural failure: do not upsert from an ambiguous parse.
            fatalError =
              parseErr && parseErr.message
                ? `CSV parse failed: ${parseErr.message}`
                : 'CSV parse failed';
            parsed = null;
          }

          if (parsed) {
            for (const skipped of parsed.skipped) {
              rowsReceived += 1;
              rowsRejected += 1;
              if (rejectedSamples.length < MAX_REJECTED_SAMPLES) {
                rejectedSamples.push({
                  raw: skipped.raw,
                  reason: skipped.reason,
                });
              }
            }

            const pending = [];

            for (const item of parsed.rows) {
              const record = item.record || {};
              const phoneRaw = record.phone;
              const phone = phoneRaw == null ? '' : String(phoneRaw).trim();
              const source_record_id = normalizeSourceRecordId(
                record.source_record_id,
              );
              const nombre = normalizeOptionalText(record.nombre);
              const apellido = normalizeOptionalText(record.apellido);
              const source_system = normalizeOptionalText(record.source_system);

              rowsReceived += 1;

              if (!isValidPhone(phone)) {
                rowsRejected += 1;
                if (rejectedSamples.length < MAX_REJECTED_SAMPLES) {
                  rejectedSamples.push({
                    row: item.rowNumber,
                    raw: item.raw,
                    reason: 'empty_or_invalid_phone',
                  });
                }
                continue;
              }

              pending.push({
                phone,
                source_record_id,
                nombre,
                apellido,
                source_system,
              });

              if (pending.length >= BATCH_SIZE) {
                const batch = pending.splice(0, BATCH_SIZE);
                const result = await upsertContactBatch(batch, importId);
                rowsInserted += result.inserted;
                rowsUpdated += result.updated;
              }
            }

            if (pending.length) {
              const result = await upsertContactBatch(pending, importId);
              rowsInserted += result.inserted;
              rowsUpdated += result.updated;
            }
          }
        }
      }
    } catch (err) {
      fatalError = err && err.message ? err.message : 'Import failed';
      logger.error('SMS contacts import failed', {
        error: fatalError,
        import_id: importId,
        filename,
      });
    }

    const summary = {
      import_id: importId,
      filename,
      delimiter_detected: delimiterDetected,
      rows_received: rowsReceived,
      rows_inserted: rowsInserted,
      rows_updated: rowsUpdated,
      rows_rejected: rowsRejected,
      rejected_samples: rejectedSamples,
    };
    if (fatalError) {
      summary.error = fatalError;
    }

    const shouldAlert =
      Boolean(fatalError) || rowsRejected > 0 || rowsReceived === 0;

    let alertSent = false;
    if (shouldAlert) {
      const alertPayload = {
        import_id: importId,
        filename,
        rows_received: rowsReceived,
        rows_inserted: rowsInserted,
        rows_updated: rowsUpdated,
        rows_rejected: rowsRejected,
      };
      if (fatalError) alertPayload.error = fatalError;
      alertSent = await sendAlertWebhook(alertPayload);
    }

    if (importId) {
      const { error: updateError } = await supabase
        .from('sms_contact_imports')
        .update({
          rows_received: rowsReceived,
          rows_inserted: rowsInserted,
          rows_updated: rowsUpdated,
          rows_rejected: rowsRejected,
          alert_sent: alertSent,
        })
        .eq('id', importId);

      if (updateError) {
        logger.error('Failed to update sms_contact_imports summary', {
          error: updateError.message,
          import_id: importId,
        });
      }
    }

    summary.alert_sent = alertSent;

    if (fatalError && !importId) {
      return res.status(500).json(summary);
    }
    if (fatalError) {
      // Import row exists; return 200 with error field so IT still gets counts,
      // unless nothing usable was processed and the failure is structural.
      const status =
        rowsReceived === 0 && rowsInserted === 0 && rowsUpdated === 0
          ? 400
          : 200;
      return res.status(status).json(summary);
    }

    return res.status(200).json(summary);
  },
);

/**
 * GET /sms/contacts — paginated list for internal dashboard.
 */
router.get('/contacts', async (req, res) => {
  const limitRaw = parseInt(String(req.query.limit || '50'), 10);
  const offsetRaw = parseInt(String(req.query.offset || '0'), 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 500)
    : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  try {
    const { count, error: countError } = await supabase
      .from('sms_contacts')
      .select('id', { count: 'exact', head: true });

    if (countError) {
      return res.status(500).json({ error: countError.message });
    }

    const { data, error } = await supabase
      .from('sms_contacts')
      .select(
        'id, phone, source_record_id, source_system, first_seen_at, last_seen_at, import_batch_id',
      )
      .order('last_seen_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      total: count == null ? null : count,
      limit,
      offset,
      contacts: data || [],
    });
  } catch (err) {
    logger.error('GET /sms/contacts failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Internal SMS contacts error' });
  }
});

/**
 * GET /sms/contacts/imports — import history for internal dashboard.
 */
router.get('/contacts/imports', async (req, res) => {
  const limitRaw = parseInt(String(req.query.limit || '50'), 10);
  const offsetRaw = parseInt(String(req.query.offset || '0'), 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 200)
    : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  try {
    const { count, error: countError } = await supabase
      .from('sms_contact_imports')
      .select('id', { count: 'exact', head: true });

    if (countError) {
      return res.status(500).json({ error: countError.message });
    }

    const { data, error } = await supabase
      .from('sms_contact_imports')
      .select(
        'id, imported_at, filename, rows_received, rows_inserted, rows_updated, rows_rejected, alert_sent',
      )
      .order('imported_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      total: count == null ? null : count,
      limit,
      offset,
      imports: data || [],
    });
  } catch (err) {
    logger.error('GET /sms/contacts/imports failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Internal SMS contacts imports error' });
  }
});

module.exports = router;
