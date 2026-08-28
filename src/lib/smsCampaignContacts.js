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

function getSupabase(override) {
  if (override) return override;
  return require('../clients/supabase');
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
async function loadContactsByPhones(phones, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
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

async function countEligibleContacts(sourceSystem, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase.rpc('sms_eligible_contacts_count', {
    p_source_system: sourceSystem,
  });
  if (error) {
    throw new Error(`sms_eligible_contacts_count failed: ${error.message}`);
  }
  const n = data == null ? 0 : Number(data);
  return Number.isFinite(n) ? n : 0;
}

async function listEligibleContacts(sourceSystem, limit, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase.rpc('sms_eligible_contacts', {
    p_source_system: sourceSystem,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`sms_eligible_contacts failed: ${error.message}`);
  }
  return Array.isArray(data) ? data : [];
}

async function countEligibleContactsForSeries(
  sourceSystem,
  seriesId,
  supabaseOverride,
) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase.rpc(
    'sms_eligible_contacts_for_series_count',
    {
      p_source_system: sourceSystem,
      p_campaign_series_id: seriesId,
    },
  );
  if (error) {
    throw new Error(
      `sms_eligible_contacts_for_series_count failed: ${error.message}`,
    );
  }
  const n = data == null ? 0 : Number(data);
  return Number.isFinite(n) ? n : 0;
}

async function countProtectedClickedForSeries(
  sourceSystem,
  seriesId,
  supabaseOverride,
) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase.rpc(
    'sms_series_protected_clicked_count',
    {
      p_source_system: sourceSystem,
      p_campaign_series_id: seriesId,
    },
  );
  if (error) {
    throw new Error(
      `sms_series_protected_clicked_count failed: ${error.message}`,
    );
  }
  const n = data == null ? 0 : Number(data);
  return Number.isFinite(n) ? n : 0;
}

async function listEligibleContactsForSeries(
  sourceSystem,
  seriesId,
  limit,
  supabaseOverride,
) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase.rpc(
    'sms_eligible_contacts_for_series',
    {
      p_source_system: sourceSystem,
      p_campaign_series_id: seriesId,
      p_limit: limit,
    },
  );
  if (error) {
    throw new Error(
      `sms_eligible_contacts_for_series failed: ${error.message}`,
    );
  }
  return Array.isArray(data) ? data : [];
}

async function classifyPhonesForSeries(seriesId, phones, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase.rpc(
    'sms_classify_phones_for_series',
    {
      p_campaign_series_id: seriesId,
      p_phones: phones,
    },
  );
  if (error) {
    throw new Error(
      `sms_classify_phones_for_series failed: ${error.message}`,
    );
  }
  return Array.isArray(data) ? data : [];
}

async function resolveEligibleCount(opts) {
  const sourceSystem = opts && opts.sourceSystem;
  const seriesId = opts && opts.seriesId;
  const individualTracking = Boolean(opts && opts.individualTracking);
  const supabaseOverride = opts && opts.supabase;
  if (individualTracking) {
    if (!seriesId) {
      return {
        ok: false,
        status: 400,
        body: require('./smsCampaignSeries').seriesRequiredBody(),
      };
    }
    const [count, protectedClickedCount] = await Promise.all([
      countEligibleContactsForSeries(sourceSystem, seriesId, supabaseOverride),
      countProtectedClickedForSeries(sourceSystem, seriesId, supabaseOverride),
    ]);
    return {
      ok: true,
      body: {
        source_system: sourceSystem,
        count: count,
        max_limit: MAX_FROM_CONTACTS_LIMIT,
        eligibility: 'series',
        individual_tracking: true,
        campaign_series_id: seriesId,
        protected_clicked_count: protectedClickedCount,
      },
    };
  }
  const count = await countEligibleContacts(sourceSystem, supabaseOverride);
  return {
    ok: true,
    body: {
      source_system: sourceSystem,
      count: count,
      max_limit: MAX_FROM_CONTACTS_LIMIT,
      eligibility: 'legacy',
      individual_tracking: false,
    },
  };
}

/**
 * Resolve new-shape recipients. Tracking ON + series: list uses series RPC;
 * directed/paste fail-closed on clicked/excluded; paste is first-wins deduped.
 * Tracking OFF: list uses never-messaged RPC; paste keeps legacy trim (no dedup);
 * directed skips series protection.
 */
async function resolveNewShapeDestinations(opts) {
  const seriesLib = require('./smsCampaignSeries');
  const useFromContacts = Boolean(opts && opts.useFromContacts);
  const fromContactsRaw = opts && opts.fromContactsRaw;
  const phones = opts && opts.phones;
  const individualTracking = Boolean(opts && opts.individualTracking);
  const seriesId = opts && opts.seriesId ? opts.seriesId : null;
  const supabaseOverride = opts && opts.supabase;

  if (useFromContacts) {
    if (Array.isArray(fromContactsRaw.phones)) {
      const hasAutoFields =
        parseSourceSystem(fromContactsRaw.source_system) != null ||
        (fromContactsRaw.limit != null &&
          String(fromContactsRaw.limit).trim() !== '');
      if (hasAutoFields) {
        return {
          ok: false,
          status: 400,
          body: {
            error:
              'from_contacts.phones cannot be combined with source_system or limit',
          },
        };
      }
      const directedPhones = normalizeDirectedPhones(fromContactsRaw.phones);
      if (!directedPhones.length) {
        return {
          ok: false,
          status: 400,
          body: {
            error:
              'from_contacts.phones must contain at least one non-empty value',
          },
        };
      }
      if (directedPhones.length > MAX_FROM_CONTACTS_LIMIT) {
        return {
          ok: false,
          status: 400,
          body: {
            error:
              'from_contacts.phones cannot exceed ' +
              String(MAX_FROM_CONTACTS_LIMIT) +
              ' numbers',
          },
        };
      }
      let loaded;
      try {
        loaded = await loadContactsByPhones(directedPhones, supabaseOverride);
      } catch (lookupErr) {
        throw new Error(
          lookupErr && lookupErr.message
            ? lookupErr.message
            : 'sms_contacts phone lookup failed',
        );
      }
      if (loaded.missing_phones.length) {
        return {
          ok: false,
          status: 400,
          body: {
            error: 'Unknown sms_contacts phones',
            missing_phones: loaded.missing_phones,
          },
        };
      }
      if (individualTracking) {
        const classified = await classifyPhonesForSeries(
          seriesId,
          directedPhones,
          supabaseOverride,
        );
        const partition = seriesLib.partitionPhoneClassifications(classified);
        if (seriesLib.hasFailClosedProtections(partition)) {
          return {
            ok: false,
            status: 400,
            body: seriesLib.buildFailClosedPayload(seriesId, partition),
          };
        }
      }
      return {
        ok: true,
        selectedContacts: loaded.contacts,
        normalizedPhones: null,
      };
    }

    const sourceSystem = parseSourceSystem(fromContactsRaw.source_system);
    const limit = parseLimit(fromContactsRaw.limit, MAX_FROM_CONTACTS_LIMIT);
    if (!sourceSystem) {
      return {
        ok: false,
        status: 400,
        body: { error: 'from_contacts.source_system is required' },
      };
    }
    if (limit == null) {
      return {
        ok: false,
        status: 400,
        body: {
          error:
            'from_contacts.limit must be an integer from 1 to ' +
            String(MAX_FROM_CONTACTS_LIMIT),
        },
      };
    }
    let selectedContacts;
    try {
      selectedContacts = individualTracking
        ? await listEligibleContactsForSeries(
            sourceSystem,
            seriesId,
            limit,
            supabaseOverride,
          )
        : await listEligibleContacts(sourceSystem, limit, supabaseOverride);
    } catch (listErr) {
      throw new Error(
        listErr && listErr.message
          ? listErr.message
          : 'eligible contacts query failed',
      );
    }
    if (!selectedContacts.length) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'No eligible contacts for that source_system',
          source_system: sourceSystem,
          count: 0,
        },
      };
    }
    return {
      ok: true,
      selectedContacts: selectedContacts,
      normalizedPhones: null,
    };
  }

  if (!Array.isArray(phones) || phones.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'phones must be a non-empty array' },
    };
  }
  const normalizedPhones = individualTracking
    ? normalizeDirectedPhones(phones)
    : phones
        .map((p) => (p == null ? '' : String(p).trim()))
        .filter((p) => p.length > 0);
  if (!normalizedPhones.length) {
    return {
      ok: false,
      status: 400,
      body: { error: 'phones must contain at least one non-empty value' },
    };
  }
  if (individualTracking) {
    const classified = await classifyPhonesForSeries(
      seriesId,
      normalizedPhones,
      supabaseOverride,
    );
    const partition = seriesLib.partitionPhoneClassifications(classified);
    if (seriesLib.hasFailClosedProtections(partition)) {
      return {
        ok: false,
        status: 400,
        body: seriesLib.buildFailClosedPayload(seriesId, partition),
      };
    }
  }
  return {
    ok: true,
    selectedContacts: null,
    normalizedPhones: normalizedPhones,
  };
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
  countEligibleContactsForSeries,
  countProtectedClickedForSeries,
  listEligibleContactsForSeries,
  classifyPhonesForSeries,
  resolveEligibleCount,
  resolveNewShapeDestinations,
};
