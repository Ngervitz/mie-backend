'use strict';

const crypto = require('crypto');
const logger = require('./logger');
const {
  generateShortCode,
  composePublicShortUrl,
  isUniqueViolation,
  appendTrackingToken,
} = require('./smsTinyUrl');

const IMPACT_INSERT_CHUNK = 500;
const CHUNK_ATTEMPTS = 5;
const TRACKING_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

class TrackingPrepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrackingPrepError';
    this.kind = 'database';
    this.status = 500;
  }
}

function isIndividualTrackingEnabled() {
  return (
    String(process.env.SMS_INDIVIDUAL_TRACKING || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function generateTrackingToken() {
  return crypto.randomBytes(16).toString('base64url');
}

function classifyInsertOutcome(error, data, expectedCount) {
  if (error) {
    if (isUniqueViolation(error)) return 'unique_conflict';
    return 'uncertain';
  }
  if (Array.isArray(data) && data.length === expectedCount) return 'ok';
  return 'uncertain';
}

function getSupabase(override) {
  if (override) return override;
  return require('../clients/supabase');
}

function buildRecipientPlans(recipients) {
  const tokens = new Set();
  const codes = new Set();
  return (recipients || []).map(function (r, index) {
    let tracking_token;
    do {
      tracking_token = generateTrackingToken();
    } while (tokens.has(tracking_token));
    tokens.add(tracking_token);

    let short_code;
    do {
      short_code = generateShortCode();
    } while (codes.has(short_code));
    codes.add(short_code);

    return {
      index: index,
      phone: r.phone,
      contact_id: r.contact_id != null ? r.contact_id : null,
      source_system: r.source_system != null ? r.source_system : null,
      source_record_id: r.source_record_id != null ? r.source_record_id : null,
      nombre: r.nombre,
      tracking_token: tracking_token,
      short_code: short_code,
      impact_id: null,
    };
  });
}

async function selectInChunks(supabase, table, column, values, selectCols) {
  const found = [];
  if (!values.length) return found;
  for (let i = 0; i < values.length; i += IMPACT_INSERT_CHUNK) {
    const slice = values.slice(i, i + IMPACT_INSERT_CHUNK);
    const { data, error } = await supabase
      .from(table)
      .select(selectCols)
      .in(column, slice);
    if (error) {
      throw new TrackingPrepError(
        'Failed to load ' + table + ': ' + error.message,
      );
    }
    for (const row of data || []) found.push(row);
  }
  return found;
}

async function selectImpactsByTokens(supabase, tokens) {
  const map = new Map();
  const rows = await selectInChunks(
    supabase,
    'marketing_impacts',
    'tracking_token',
    tokens,
    'id, tracking_token',
  );
  for (const row of rows) {
    if (row && row.tracking_token && row.id) {
      map.set(String(row.tracking_token), String(row.id));
    }
  }
  return map;
}

async function selectShortsByImpactIds(supabase, impactIds) {
  const map = new Map();
  const rows = await selectInChunks(
    supabase,
    'sms_short_links',
    'impact_id',
    impactIds,
    'impact_id, short_code',
  );
  for (const row of rows) {
    if (row && row.impact_id && row.short_code) {
      map.set(String(row.impact_id), String(row.short_code));
    }
  }
  return map;
}

async function selectShortsByCodes(supabase, codes) {
  const map = new Map();
  const rows = await selectInChunks(
    supabase,
    'sms_short_links',
    'short_code',
    codes,
    'short_code, impact_id',
  );
  for (const row of rows) {
    if (row && row.short_code) {
      map.set(
        String(row.short_code),
        row.impact_id == null ? null : String(row.impact_id),
      );
    }
  }
  return map;
}

function resolveOccupiedShortCodes(stillMissing, byCode, usedCodes) {
  for (const plan of stillMissing) {
    if (!byCode.has(plan.short_code)) continue;
    const ownerId = byCode.get(plan.short_code);
    if (ownerId === String(plan.impact_id)) continue;
    regenerateShortCode(plan, usedCodes);
  }
}

function assignImpacts(chunk, byToken) {
  for (const plan of chunk) {
    const id = byToken.get(plan.tracking_token);
    if (id) plan.impact_id = id;
  }
}

function assignShorts(chunk, byImpactId) {
  for (const plan of chunk) {
    if (!plan.impact_id) continue;
    const code = byImpactId.get(String(plan.impact_id));
    if (code) plan.short_code = code;
  }
}

function regenerateShortCode(plan, usedCodes) {
  let next;
  do {
    next = generateShortCode();
  } while (usedCodes.has(next));
  usedCodes.add(next);
  usedCodes.delete(plan.short_code);
  plan.short_code = next;
}

async function persistImpactChunk(supabase, chunk) {
  let lastMessage = 'Failed to persist marketing_impacts';
  for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt += 1) {
    try {
      const byToken = await selectImpactsByTokens(
        supabase,
        chunk.map(function (p) {
          return p.tracking_token;
        }),
      );
      assignImpacts(chunk, byToken);
      const missing = chunk.filter(function (p) {
        return !p.impact_id;
      });
      if (!missing.length) return;

      const { data, error } = await supabase
        .from('marketing_impacts')
        .insert(
          missing.map(function (p) {
            return {
              tracking_token: p.tracking_token,
              channel: 'sms',
              contact_id: p.contact_id,
            };
          }),
        )
        .select('id, tracking_token');

      const outcome = classifyInsertOutcome(error, data, missing.length);
      if (outcome === 'ok') {
        assignImpacts(chunk, new Map(
          data.map(function (row) {
            return [String(row.tracking_token), String(row.id)];
          }),
        ));
      } else if (error) {
        lastMessage =
          'Failed to insert marketing_impacts: ' +
          (error.message || outcome);
      } else {
        lastMessage =
          'marketing_impacts insert returned unexpected row count';
      }

      const after = await selectImpactsByTokens(
        supabase,
        chunk.map(function (p) {
          return p.tracking_token;
        }),
      );
      assignImpacts(chunk, after);
      if (
        chunk.every(function (p) {
          return p.impact_id;
        })
      ) {
        return;
      }
    } catch (err) {
      lastMessage = err && err.message ? err.message : lastMessage;
    }
  }
  throw new TrackingPrepError(lastMessage);
}

async function persistShortChunk(supabase, campaignId, destinationUrl, chunk, allPlans) {
  const usedCodes = new Set(
    allPlans.map(function (p) {
      return p.short_code;
    }),
  );
  let lastMessage = 'Failed to persist sms_short_links';
  for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt += 1) {
    try {
      const byImpact = await selectShortsByImpactIds(
        supabase,
        chunk
          .filter(function (p) {
            return p.impact_id;
          })
          .map(function (p) {
            return p.impact_id;
          }),
      );
      assignShorts(chunk, byImpact);
      const missing = chunk.filter(function (p) {
        return p.impact_id && !byImpact.has(String(p.impact_id));
      });
      if (!missing.length) return;

      const { data, error } = await supabase
        .from('sms_short_links')
        .insert(
          missing.map(function (p) {
            return {
              short_code: p.short_code,
              destination_url: destinationUrl
                ? appendTrackingToken(destinationUrl, p.tracking_token)
                : null,
              campaign_id: campaignId,
              impact_id: p.impact_id,
            };
          }),
        )
        .select('short_code, impact_id');

      const outcome = classifyInsertOutcome(error, data, missing.length);
      if (outcome === 'ok') {
        assignShorts(
          chunk,
          new Map(
            data.map(function (row) {
              return [String(row.impact_id), String(row.short_code)];
            }),
          ),
        );
      } else if (error) {
        lastMessage =
          'Failed to insert sms_short_links: ' +
          (error.message || outcome);
      } else {
        lastMessage = 'sms_short_links insert returned unexpected row count';
      }

      const after = await selectShortsByImpactIds(
        supabase,
        chunk
          .filter(function (p) {
            return p.impact_id;
          })
          .map(function (p) {
            return p.impact_id;
          }),
      );
      assignShorts(chunk, after);
      const stillMissing = chunk.filter(function (p) {
        return p.impact_id && !after.has(String(p.impact_id));
      });
      if (!stillMissing.length) return;

      if (outcome === 'unique_conflict') {
        const byCode = await selectShortsByCodes(
          supabase,
          stillMissing.map(function (p) {
            return p.short_code;
          }),
        );
        resolveOccupiedShortCodes(stillMissing, byCode, usedCodes);
      }
    } catch (err) {
      lastMessage = err && err.message ? err.message : lastMessage;
    }
  }
  throw new TrackingPrepError(lastMessage);
}

async function reconcileAllImpacts(supabase, plans) {
  const byToken = await selectImpactsByTokens(
    supabase,
    plans.map(function (p) {
      return p.tracking_token;
    }),
  );
  if (byToken.size !== plans.length) {
    throw new TrackingPrepError(
      'Impact reconcile expected ' +
        plans.length +
        ' rows, found ' +
        byToken.size,
    );
  }
  for (const plan of plans) {
    const id = byToken.get(plan.tracking_token);
    if (!id) {
      throw new TrackingPrepError(
        'Impact reconcile missing tracking_token',
      );
    }
    plan.impact_id = id;
  }
}

async function reconcileAllShorts(supabase, plans) {
  const byImpact = await selectShortsByImpactIds(
    supabase,
    plans.map(function (p) {
      return p.impact_id;
    }),
  );
  if (byImpact.size !== plans.length) {
    throw new TrackingPrepError(
      'Short reconcile expected ' +
        plans.length +
        ' rows, found ' +
        byImpact.size,
    );
  }
  for (const plan of plans) {
    const code = byImpact.get(String(plan.impact_id));
    if (!code) {
      throw new TrackingPrepError('Short reconcile missing impact_id');
    }
    plan.short_code = code;
  }
}

function assertExactCounts(plans, skipShorts) {
  const n = plans.length;
  const impactIds = new Set();
  for (const plan of plans) {
    if (!plan.impact_id || !TRACKING_TOKEN_RE.test(plan.tracking_token)) {
      throw new TrackingPrepError(
        'Individual tracking did not close N impacts for N recipients',
      );
    }
    impactIds.add(String(plan.impact_id));
  }
  if (impactIds.size !== n) {
    throw new TrackingPrepError(
      'Individual tracking impact_id count does not match recipients',
    );
  }
  if (skipShorts) return;
  const codes = new Set();
  for (const plan of plans) {
    if (!plan.short_code) {
      throw new TrackingPrepError(
        'Individual tracking did not close N shorts for N recipients',
      );
    }
    codes.add(String(plan.short_code));
  }
  if (codes.size !== n) {
    throw new TrackingPrepError(
      'Individual tracking short_code count does not match recipients',
    );
  }
}

async function prepareIndividualSmsTracking(opts) {
  const recipients = opts && opts.recipients ? opts.recipients : [];
  if (!recipients.length) {
    throw new TrackingPrepError('No recipients for individual tracking');
  }
  const supabase = getSupabase(opts && opts.supabase);
  const skipShorts = Boolean(opts && opts.skipShorts);
  const plans = buildRecipientPlans(recipients);

  for (let i = 0; i < plans.length; i += IMPACT_INSERT_CHUNK) {
    await persistImpactChunk(
      supabase,
      plans.slice(i, i + IMPACT_INSERT_CHUNK),
    );
  }
  await reconcileAllImpacts(supabase, plans);

  if (!skipShorts) {
    const destinationUrl = opts && opts.destinationUrl;
    const campaignId = opts && opts.campaignId;
    if (!destinationUrl || !campaignId) {
      throw new TrackingPrepError(
        'destinationUrl and campaignId required to create per-impact shorts',
      );
    }
    for (let i = 0; i < plans.length; i += IMPACT_INSERT_CHUNK) {
      await persistShortChunk(
        supabase,
        campaignId,
        destinationUrl,
        plans.slice(i, i + IMPACT_INSERT_CHUNK),
        plans,
      );
    }
    await reconcileAllShorts(supabase, plans);
  }

  assertExactCounts(plans, skipShorts);
  return plans;
}

async function markCampaignPrepError(campaignId, supabaseOverride) {
  const id = String(campaignId || '').trim();
  if (!id) return;
  try {
    const supabase = getSupabase(supabaseOverride);
    const { error } = await supabase
      .from('sms_campaigns')
      .update({ status: 'error' })
      .eq('id', id);
    if (error) {
      logger.error('Failed to mark campaign error after tracking prep failure', {
        campaign_id: id,
        error: error.message,
      });
    }
  } catch (err) {
    logger.error('Failed to mark campaign error after tracking prep failure', {
      campaign_id: id,
      error: err && err.message ? err.message : 'unknown',
    });
  }
}

module.exports = {
  IMPACT_INSERT_CHUNK,
  CHUNK_ATTEMPTS,
  TRACKING_TOKEN_RE,
  TrackingPrepError,
  isIndividualTrackingEnabled,
  generateTrackingToken,
  classifyInsertOutcome,
  buildRecipientPlans,
  prepareIndividualSmsTracking,
  markCampaignPrepError,
  composePublicShortUrl,
};
