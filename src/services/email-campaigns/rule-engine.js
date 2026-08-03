/**
 * Pure segment rule engine — no I/O, no Supabase, no env.
 * All conditions are AND. No OR / groups / nested logic.
 */

const ALLOWED_FIELDS = [
  'encuesta_score',
  'marketing_consent',
  'attributes',
];

const ALLOWED_OPERATORS = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'in',
];

/**
 * @param {string} field
 * @returns {boolean}
 */
function isAllowedField(field) {
  if (typeof field !== 'string' || !field) return false;
  if (ALLOWED_FIELDS.includes(field)) return true;
  if (field.startsWith('attributes.')) {
    const key = field.slice('attributes.'.length);
    return key.length > 0 && !key.includes('.');
  }
  return false;
}

/**
 * @param {object} record
 * @param {string} field
 * @returns {unknown}
 */
function readField(record, field) {
  if (field === 'encuesta_score') return record.encuesta_score;
  if (field === 'marketing_consent') return record.marketing_consent;
  if (field === 'attributes') return record.attributes;
  if (field.startsWith('attributes.')) {
    const key = field.slice('attributes.'.length);
    const attrs =
      record && record.attributes && typeof record.attributes === 'object'
        ? record.attributes
        : null;
    if (!attrs) return undefined;
    return attrs[key];
  }
  return undefined;
}

/**
 * @param {unknown} rules
 */
function validateRule(rules) {
  if (!Array.isArray(rules)) {
    throw new Error('validateRule: rules must be an array');
  }

  for (let i = 0; i < rules.length; i += 1) {
    const cond = rules[i];
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
      throw new Error(`validateRule: condition at index ${i} must be an object`);
    }
    if (cond.field == null || cond.field === '') {
      throw new Error(`validateRule: condition at index ${i} is missing field`);
    }
    if (cond.operator == null || cond.operator === '') {
      throw new Error(`validateRule: condition at index ${i} is missing operator`);
    }
    const field = String(cond.field);
    const operator = String(cond.operator);

    if (!isAllowedField(field)) {
      throw new Error(
        `validateRule: field "${field}" is not allowed (index ${i})`,
      );
    }
    if (!ALLOWED_OPERATORS.includes(operator)) {
      throw new Error(
        `validateRule: operator "${operator}" is not allowed (index ${i})`,
      );
    }
    if (operator === 'in' && !Array.isArray(cond.value)) {
      throw new Error(
        `validateRule: operator "in" requires value to be an array (index ${i})`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(cond, 'or') ||
        Object.prototype.hasOwnProperty.call(cond, 'and') ||
        Object.prototype.hasOwnProperty.call(cond, 'groups') ||
        Object.prototype.hasOwnProperty.call(cond, 'children')) {
      throw new Error(
        `validateRule: nested/OR/group logic is not supported (index ${i})`,
      );
    }
  }
}

/**
 * Strict equality operators. Numeric comparisons require finite numbers on both sides.
 * Invalid numeric comparisons → false (no silent coercion).
 *
 * @param {unknown} left
 * @param {string} operator
 * @param {unknown} right
 * @returns {boolean}
 */
function compare(left, operator, right) {
  if (operator === '=') return left === right;
  if (operator === '!=') return left !== right;
  if (operator === 'in') {
    if (!Array.isArray(right)) return false;
    return right.includes(left);
  }

  if (
    typeof left !== 'number' ||
    typeof right !== 'number' ||
    !Number.isFinite(left) ||
    !Number.isFinite(right)
  ) {
    return false;
  }

  if (operator === '>') return left > right;
  if (operator === '>=') return left >= right;
  if (operator === '<') return left < right;
  if (operator === '<=') return left <= right;
  return false;
}

/**
 * @param {unknown} rules
 * @param {object} record
 * @returns {boolean}
 */
function evaluateRule(rules, record) {
  validateRule(rules);
  if (rules.length === 0) return true;
  if (!record || typeof record !== 'object') return false;

  for (let i = 0; i < rules.length; i += 1) {
    const cond = rules[i];
    const left = readField(record, String(cond.field));
    if (!compare(left, String(cond.operator), cond.value)) {
      return false;
    }
  }
  return true;
}

/**
 * @param {unknown} rules
 * @param {unknown} records
 * @returns {object[]}
 */
function filterBySegment(rules, records) {
  validateRule(rules);
  if (!Array.isArray(records)) {
    throw new Error('filterBySegment: records must be an array');
  }
  return records.filter((record) => evaluateRule(rules, record));
}

module.exports = {
  ALLOWED_FIELDS,
  ALLOWED_OPERATORS,
  validateRule,
  evaluateRule,
  filterBySegment,
};
