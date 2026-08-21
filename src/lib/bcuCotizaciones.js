/**
 * Minimal BCU SOAP client (fetch + XML). Public, no auth.
 * Currency 2225 = DLS. USA BILLETE. Conversion uses TCV (sell).
 */

const BASE = 'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet';
const USD_BILLETE = 2225;
const TIMEOUT_MS = 15000;
const DEFAULT_GRUPO = 0;

function xmlText(xml, tag) {
  const re = new RegExp(
    '<(?:\\w+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>',
    'i',
  );
  const m = String(xml || '').match(re);
  return m ? String(m[1]).trim() : '';
}

function sliceDate(raw) {
  const s = String(raw || '').trim();
  return s.length >= 10 ? s.slice(0, 10) : '';
}

function parseQuoteBlock(block) {
  const date = sliceDate(xmlText(block, 'Fecha'));
  const buy = Number(xmlText(block, 'TCC'));
  const sell = Number(xmlText(block, 'TCV'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!Number.isFinite(buy) || buy <= 0) return null;
  if (!Number.isFinite(sell) || sell <= 0) return null;
  return { date: date, buy: buy, sell: sell };
}

async function soapPost(servlet, soapAction, bodyXml) {
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cot="Cotiza">' +
    '<soapenv:Header/>' +
    '<soapenv:Body>' +
    bodyXml +
    '</soapenv:Body></soapenv:Envelope>';

  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE + '/' + servlet, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: soapAction,
      },
      body: envelope,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      'BCU SOAP HTTP ' + res.status + ': ' + text.slice(0, 200),
    );
  }
  return text;
}

async function fetchUltimoCierre() {
  const xml = await soapPost(
    'awsultimocierre',
    'Cotizaaction/AWSULTIMOCIERRE.Execute',
    '<cot:wsultimocierre.Execute/>',
  );
  const date = sliceDate(xmlText(xml, 'Fecha'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('BCU ultimoCierre: missing Fecha');
  }
  return date;
}

async function fetchUsdQuotes(desde, hasta) {
  const body =
    '<cot:wsbcucotizaciones.Execute><cot:Entrada>' +
    '<cot:Moneda><cot:item>' +
    USD_BILLETE +
    '</cot:item></cot:Moneda>' +
    '<cot:FechaDesde>' +
    desde +
    '</cot:FechaDesde>' +
    '<cot:FechaHasta>' +
    hasta +
    '</cot:FechaHasta>' +
    '<cot:Grupo>' +
    DEFAULT_GRUPO +
    '</cot:Grupo>' +
    '</cot:Entrada></cot:wsbcucotizaciones.Execute>';

  const xml = await soapPost(
    'awsbcucotizaciones',
    'Cotizaaction/AWSBCUCOTIZACIONES.Execute',
    body,
  );
  const status = xmlText(xml, 'status');
  if (status === '0') {
    return [];
  }
  const blocks =
    xml.match(
      /<(?:\w+:)?datoscotizaciones\.dato\b[\s\S]*?<\/(?:\w+:)?datoscotizaciones\.dato>/gi,
    ) || [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const q = parseQuoteBlock(blocks[i]);
    if (!q || seen.has(q.date)) continue;
    seen.add(q.date);
    out.push(q);
  }
  return out;
}

module.exports = {
  USD_BILLETE,
  fetchUltimoCierre,
  fetchUsdQuotes,
};
