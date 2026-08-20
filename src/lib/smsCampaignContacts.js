/**
 * Shared SMS list-campaign helpers.
 * GET /sms/contacts/eligible and POST /sms/campaigns from_contacts
 * must call these — do not duplicate the eligibility RPC.
 */

const MAX_FROM_CONTACTS_LIMIT = 2000;
const NOMBRE_PLACEHOLDER = '{{nombre}}';
/** Notifyme does not deliver SMS over this many characters (no concatenation). */
const SMS_MAX_MESSAGE_CHARS = 160;

function titleCaseNombre(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLocaleLowerCase('es');
      if (!lower) return '';
      return lower.charAt(0).toLocaleUpperCase('es') + lower.slice(1);
    })
    .filter(Boolean)
    .join(' ');
}

function composeSmsText(resolvedBody, link) {
  const body = String(resolvedBody == null ? '' : resolvedBody);
  const url = String(link == null ? '' : link);
  if (!url) return body;
  if (!body) return url;
  return body + ' ' + url;
}

function messageBodyHasHttpUrl(text) {
  return /https?:\/\//i.test(String(text == null ? '' : text));
}

function countSmsChars(text) {
  return Array.from(String(text == null ? '' : text)).length;
}

function replaceNombre(messageBody, inserted) {
  const body = String(messageBody == null ? '' : messageBody);
  let out;
  if (inserted) {
    out = body.split(NOMBRE_PLACEHOLDER).join(inserted);
  } else {
    out = body.split(NOMBRE_PLACEHOLDER).join('');
    out = out.replace(/[ \t]{2,}/g, ' ');
    out = out.replace(/ +([,.;:!?])/g, '$1');
    out = out.replace(/^ +/, '');
  }
  return out.replace(/ +$/g, '').replace(/  +/g, ' ');
}

/**
 * Replace {{nombre}} with title-cased first/full name.
 * Missing name: drop placeholder and collapse leftover spaces before punctuation.
 *
 * Optional third argument `{ link, maxChars }` fits the composed SMS
 * (resolved body + space + link, same as send) into maxChars by truncating
 * the name from the end. Names of 0–1 characters are omitted.
 * Returns the resolved body only — caller still appends the link.
 */
function applyNombrePlaceholder(messageBody, nombreRaw, options) {
  const opts = options || {};
  const shouldFit = opts.link != null || opts.maxChars != null;
  const titled = titleCaseNombre(nombreRaw);
  if (!shouldFit) {
    return replaceNombre(messageBody, titled);
  }

  const link = opts.link != null ? String(opts.link) : '';
  const maxCharsRaw = opts.maxChars != null ? Number(opts.maxChars) : SMS_MAX_MESSAGE_CHARS;
  const maxChars =
    Number.isFinite(maxCharsRaw) && maxCharsRaw > 0
      ? maxCharsRaw
      : SMS_MAX_MESSAGE_CHARS;

  const titledChars = Array.from(titled);
  if (titledChars.length < 2) {
    return replaceNombre(messageBody, '');
  }

  function fits(resolvedBody) {
    return countSmsChars(composeSmsText(resolvedBody, link)) <= maxChars;
  }

  let resolved = replaceNombre(messageBody, titled);
  if (fits(resolved)) return resolved;

  for (let n = titledChars.length - 1; n >= 2; n -= 1) {
    resolved = replaceNombre(messageBody, titledChars.slice(0, n).join(''));
    if (fits(resolved)) return resolved;
  }
  return replaceNombre(messageBody, '');
}

function parseSourceSystem(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

function parseLimit(raw, fallbackMax) {
  const n = parseInt(String(raw == null ? '' : raw), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, fallbackMax);
}

/**
 * Trim, drop empties, first occurrence wins. Returns [] if every value was empty.
 * Caller must pass an array (directed mode).
 */
function normalizeDirectedPhones(raw) {
  const seen = new Set();
  const phones = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] == null ? '' : String(raw[i]).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    phones.push(t);
  }
  return phones;
}

/**
 * Exact phone match in sms_contacts. Does not apply eligibility / "never messaged".
 * Result.contacts follows `phones` order.
 */
async function loadContactsByPhones(phones) {
  const supabase = require('../clients/supabase');
  const { data, error } = await supabase
    .from('sms_contacts')
    .select('id, phone, nombre, source_system, source_record_id')
    .in('phone', phones);
  if (error) {
    throw new Error(`sms_contacts phone lookup failed: ${error.message}`);
  }
  const byPhone = new Map();
  for (const row of data || []) {
    if (row && row.phone != null) byPhone.set(String(row.phone), row);
  }
  const contacts = [];
  const missing_phones = [];
  for (let i = 0; i < phones.length; i++) {
    const phone = phones[i];
    const row = byPhone.get(phone);
    if (!row) missing_phones.push(phone);
    else contacts.push(row);
  }
  return { contacts, missing_phones };
}

async function countEligibleContacts(sourceSystem) {
  const supabase = require('../clients/supabase');
  const { data, error } = await supabase.rpc('sms_eligible_contacts_count', {
    p_source_system: sourceSystem,
  });
  if (error) {
    throw new Error(`sms_eligible_contacts_count failed: ${error.message}`);
  }
  const n = data == null ? 0 : Number(data);
  return Number.isFinite(n) ? n : 0;
}

async function listEligibleContacts(sourceSystem, limit) {
  const supabase = require('../clients/supabase');
  const { data, error } = await supabase.rpc('sms_eligible_contacts', {
    p_source_system: sourceSystem,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`sms_eligible_contacts failed: ${error.message}`);
  }
  return Array.isArray(data) ? data : [];
}

module.exports = {
  MAX_FROM_CONTACTS_LIMIT,
  NOMBRE_PLACEHOLDER,
  SMS_MAX_MESSAGE_CHARS,
  titleCaseNombre,
  applyNombrePlaceholder,
  composeSmsText,
  messageBodyHasHttpUrl,
  parseSourceSystem,
  parseLimit,
  normalizeDirectedPhones,
  loadContactsByPhones,
  countEligibleContacts,
  listEligibleContacts,
};
