'use strict';

/**
 * Entity mention detection for Assist memory recall.
 * Normalize only for matching. Persist / tool args always use the real
 * monitored_entities.name (original casing and diacritics).
 */

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary match on already-normalized ASCII-ish strings.
 * Avoids JS \\b Unicode pitfalls by stripping diacritics first.
 * @param {string} message
 * @param {string[]} entityNames real names from monitored_entities
 * @returns {string[]} real names that matched (original spelling)
 */
function matchKnownEntities(message, entityNames) {
  const msgNorm = normalizeForMatch(message);
  if (!msgNorm) return [];
  const seen = new Set();
  const matched = [];
  const names = Array.isArray(entityNames) ? entityNames : [];
  for (const raw of names) {
    const real = raw != null ? String(raw).trim() : '';
    if (!real || seen.has(real)) continue;
    const norm = normalizeForMatch(real);
    if (!norm) continue;
    const re = new RegExp(
      '(^|[^a-z0-9])' + escapeRegex(norm) + '([^a-z0-9]|$)',
    );
    if (re.test(msgNorm)) {
      seen.add(real);
      matched.push(real);
    }
  }
  return matched;
}

/**
 * Whether `name` (real entity name) appears in `text` with the same matcher.
 * @param {string} text
 * @param {string} realName
 */
function nameAppearsInText(text, realName) {
  return matchKnownEntities(text, [realName]).length > 0;
}

module.exports = {
  normalizeForMatch,
  matchKnownEntities,
  nameAppearsInText,
};
