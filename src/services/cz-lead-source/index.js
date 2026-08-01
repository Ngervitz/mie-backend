/**
 * Factory: pick CZLeadSource adapter from CZ_SOURCE_MODE.
 *   'php_api' | 'mysql' | unset/other → NotImplementedCZLeadSource
 */

const { NotImplementedCZLeadSource } = require('./not-implemented');
const { PhpApiCZLeadSource } = require('./php-api');
const { MySqlCZLeadSource } = require('./mysql');

/**
 * @returns {import('./interface').CZLeadSource}
 */
function getCZLeadSource() {
  const mode = String(process.env.CZ_SOURCE_MODE || '')
    .trim()
    .toLowerCase();

  if (mode === 'php_api') {
    return new PhpApiCZLeadSource();
  }
  if (mode === 'mysql') {
    return new MySqlCZLeadSource();
  }
  return new NotImplementedCZLeadSource();
}

module.exports = {
  getCZLeadSource,
  NotImplementedCZLeadSource,
  PhpApiCZLeadSource,
  MySqlCZLeadSource,
};
