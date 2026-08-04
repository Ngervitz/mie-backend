/**
 * Deterministic mention detection for AI Visibility (no I/O, no LLM).
 * entity_id values are UUID strings (monitored_entities.id).
 */

/**
 * @typedef {object} EntityInput
 * @property {string} id
 * @property {string} name
 * @property {string[]|unknown} [aliases]
 *
 * @typedef {object} MentionHit
 * @property {string} entity_id
 * @property {string} name
 * @property {string} matched_text
 * @property {number} first_index
 */

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForMatching(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Build accent-stripped view + map from normalized index → original index.
 * @param {string} original
 * @returns {{ normalized: string, indexMap: number[] }}
 */
function buildNormalizedView(original) {
  let normalized = '';
  /** @type {number[]} */
  const indexMap = [];
  for (let i = 0; i < original.length; ) {
    const cp = original.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const adv = ch.length;
    const nfd = ch.normalize('NFD');
    for (let j = 0; j < nfd.length; j += 1) {
      const c = nfd[j];
      if (c >= '\u0300' && c <= '\u036f') continue;
      indexMap.push(i);
      normalized += c;
    }
    i += adv;
  }
  return { normalized, indexMap };
}

/**
 * Earliest Unicode-aware whole-token match (no \b).
 * Accent-insensitive: compare on NFD-stripped strings; report indices
 * into the original text.
 * @param {string} text
 * @param {string} term
 * @returns {{ matched_text: string, first_index: number }|null}
 */
function findEarliestMatch(text, term) {
  if (typeof term !== 'string') return null;
  const trimmed = term.trim();
  if (!trimmed) return null;

  const view = buildNormalizedView(text);
  const normTerm = normalizeForMatching(trimmed);
  if (!normTerm) return null;

  let re;
  try {
    re = new RegExp(
      `(?<!\\p{L}|\\p{N})${escapeRegExp(normTerm)}(?!\\p{L}|\\p{N})`,
      'ui',
    );
  } catch {
    return null;
  }

  const match = re.exec(view.normalized);
  if (!match) return null;

  const startOrig = view.indexMap[match.index];
  const endNorm = match.index + match[0].length;
  const endOrig =
    endNorm < view.indexMap.length ? view.indexMap[endNorm] : text.length;

  return {
    matched_text: text.slice(startOrig, endOrig),
    first_index: startOrig,
  };
}

/**
 * @param {unknown} aliases
 * @returns {string[]}
 */
function normalizeAliases(aliases) {
  if (!Array.isArray(aliases)) return [];
  const out = [];
  for (const item of aliases) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
  }
  return out;
}

/**
 * @param {unknown} text
 * @param {EntityInput[]} entities
 * @returns {MentionHit[]}
 */
function detectMentions(text, entities) {
  if (typeof text !== 'string' || !text) return [];
  if (!Array.isArray(entities) || entities.length === 0) return [];

  /** @type {MentionHit[]} */
  const hits = [];

  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') continue;
    const entityId = entity.id != null ? String(entity.id).trim() : '';
    const name = typeof entity.name === 'string' ? entity.name.trim() : '';
    if (!entityId || !name) continue;

    const terms = [name, ...normalizeAliases(entity.aliases)];
    let best = null;
    for (const term of terms) {
      const found = findEarliestMatch(text, term);
      if (!found) continue;
      if (!best || found.first_index < best.first_index) {
        best = found;
      }
    }
    if (best) {
      hits.push({
        entity_id: entityId,
        name,
        matched_text: best.matched_text,
        first_index: best.first_index,
      });
    }
  }

  hits.sort((a, b) => {
    if (a.first_index !== b.first_index) return a.first_index - b.first_index;
    return a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0;
  });

  return hits;
}

/**
 * Credizona brand detection (independent of competitor list).
 * @param {unknown} text
 * @returns {boolean}
 */
function detectCredizona(text) {
  if (typeof text !== 'string' || !text) return false;
  const terms = ['Credizona', 'Credi Zona'];
  for (const term of terms) {
    if (findEarliestMatch(text, term)) return true;
  }
  return false;
}

module.exports = {
  detectMentions,
  detectCredizona,
  findEarliestMatch,
};
