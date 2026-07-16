const pdfParse = require('pdf-parse');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

/**
 * BPS payment calendar scraper (capture-only).
 *
 * Audited structure (2026-07): the official page
 * https://www.bps.gub.uy/22437/calendario-de-cobros.html contains NO dates in
 * HTML — it links to two monthly PDFs (activos / pasivos) whose URL revision
 * segment changes every month, so links must be discovered from the HTML.
 * The PDFs are layout tables; text extraction yields a stable machine-made
 * pattern: month/year header (e.g. "JULIO 2026") plus "Desde N" / "Hasta N"
 * per payment channel. We parse the conservative overall window
 * (min "Desde" .. max "Hasta") per document and keep the full extracted text
 * in raw_text for auditability. If the pattern does not match, we fail loudly
 * and insert nothing — never guessed dates.
 */

const BPS_PAGE_URL = 'https://www.bps.gub.uy/22437/calendario-de-cobros.html';
const SOURCE = 'bps_scrape';

const MONTHS_ES = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  setiembre: 9,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: 'text/html,*/*' } });
  if (!res.ok) {
    throw new Error(`BPS fetch failed (${res.status}) for ${url}`);
  }
  return res.text();
}

async function fetchPdfBuffer(url) {
  const res = await fetch(url, { headers: { Accept: 'application/pdf,*/*' } });
  if (!res.ok) {
    throw new Error(`BPS PDF fetch failed (${res.status}) for ${url}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/** Discover current activos/pasivos PDF links from the HTML page. */
function extractPdfLinks(html) {
  const links = [];
  const re = /href="([^"]*calendario-publicacion-web\.pdf)"/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    let href = match[1];
    if (href.startsWith('/')) href = 'https://www.bps.gub.uy' + href;
    if (!links.includes(href)) links.push(href);
  }

  const activos = links.find((l) => /activos/i.test(l)) || null;
  const pasivos = links.find((l) => /pasivos/i.test(l)) || null;
  return { activos, pasivos, all: links };
}

/**
 * Parse one PDF's extracted text into a conservative payment window.
 * Returns null (with reason) if the expected pattern is not present.
 */
function parseBpsPdfText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { ok: false, reason: 'empty extracted text' };
  }

  // Month/year header, e.g. "JULIO 2026".
  const monthRe = new RegExp(
    '\\b(' + Object.keys(MONTHS_ES).join('|') + ')\\s+(20\\d{2})\\b',
    'i',
  );
  const monthMatch = normalized.match(monthRe);
  if (!monthMatch) {
    return { ok: false, reason: 'month/year header not found' };
  }
  const month = MONTHS_ES[monthMatch[1].toLowerCase()];
  const year = Number(monthMatch[2]);

  const desdeValues = [...normalized.matchAll(/Desde\s+(\d{1,2})/gi)].map((m) =>
    Number(m[1]),
  );
  const hastaValues = [...normalized.matchAll(/Hasta\s+(\d{1,2})/gi)].map((m) =>
    Number(m[1]),
  );

  const maxDay = lastDayOfMonth(year, month);
  const validDesde = desdeValues.filter((d) => d >= 1 && d <= maxDay);
  const validHasta = hastaValues.filter((d) => d >= 1 && d <= maxDay);

  if (!validDesde.length || !validHasta.length) {
    return { ok: false, reason: 'Desde/Hasta day values not found' };
  }

  const fromDay = Math.min(...validDesde);
  const toDay = Math.max(...validHasta);
  if (fromDay > toDay) {
    return { ok: false, reason: `inconsistent window ${fromDay}..${toDay}` };
  }

  return {
    ok: true,
    year,
    month,
    dateStart: `${year}-${pad2(month)}-${pad2(fromDay)}`,
    dateEnd: `${year}-${pad2(month)}-${pad2(toDay)}`,
  };
}

/**
 * Scrape the current month's BPS payment calendar (activos + pasivos PDFs)
 * and upsert into economic_calendar_events. Meant to run monthly (manual
 * trigger for now); idempotent via the dedup key.
 */
async function collectBpsPaymentCalendar() {
  logger.info('BPS payment calendar scrape started', { url: BPS_PAGE_URL });

  const html = await fetchText(BPS_PAGE_URL);
  const { activos, pasivos, all } = extractPdfLinks(html);

  if (!activos && !pasivos) {
    throw new Error(
      `BPS page contained no calendar PDF links (found ${all.length} candidates)`,
    );
  }

  const docs = [
    { kind: 'activos', url: activos },
    { kind: 'pasivos', url: pasivos },
  ].filter((d) => d.url);

  const events = [];
  const failures = [];

  for (const doc of docs) {
    try {
      const buffer = await fetchPdfBuffer(doc.url);
      const parsedPdf = await pdfParse(buffer);
      const rawText = String(parsedPdf.text || '').trim();
      const window = parseBpsPdfText(rawText);

      if (!window.ok) {
        failures.push({ kind: doc.kind, url: doc.url, reason: window.reason });
        logger.error('BPS PDF parse failed — no rows inserted for this doc', {
          kind: doc.kind,
          url: doc.url,
          reason: window.reason,
        });
        continue;
      }

      events.push({
        event_type: 'bps_payment',
        title: `Pago prestaciones BPS — ${doc.kind} ${window.year}-${pad2(window.month)}`,
        date_start: window.dateStart,
        date_end: window.dateEnd,
        description:
          `Ventana global de cobro (${doc.kind}) según calendario oficial BPS; ` +
          'rango conservador min(Desde)..max(Hasta) sobre todos los canales.',
        source: SOURCE,
        raw_text: rawText.slice(0, 8000),
      });
    } catch (err) {
      failures.push({
        kind: doc.kind,
        url: doc.url,
        reason: err && err.message ? err.message : 'unknown',
      });
      logger.error('BPS PDF processing failed', {
        kind: doc.kind,
        url: doc.url,
        error: err && err.message ? err.message : 'unknown',
      });
    }
  }

  if (events.length) {
    const { error } = await supabase
      .from('economic_calendar_events')
      .upsert(events, { onConflict: 'event_type,date_start,title,source' });
    if (error) {
      throw new Error(`Failed to upsert BPS events: ${error.message}`);
    }
  }

  const summary = {
    docsFound: docs.length,
    eventsUpserted: events.length,
    failures,
    events: events.map((e) => ({
      title: e.title,
      dateStart: e.date_start,
      dateEnd: e.date_end,
    })),
  };

  logger.info('BPS payment calendar scrape finished', summary);
  return summary;
}

module.exports = {
  collectBpsPaymentCalendar,
  parseBpsPdfText,
  extractPdfLinks,
  BPS_PAGE_URL,
};
