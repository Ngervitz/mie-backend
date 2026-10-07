'use strict';

/**
 * Pure ELM UI helpers (browser + Node unit tests). No DOM / no fetch.
 * Renders the ELM cell computed server-side (src/services/elm/listView.js).
 * GRANTED CDV and GRANTED ELM are separate sources and are never merged here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ElmUiHelpers = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var SEND_PENDING_HINT = 'Integración ELM pendiente de habilitación';
  var CDV_GRANTED_LABEL = 'GRANTED CDV';
  var ELM_GRANTED_LABEL = 'Otorgado';

  function esc(raw) {
    return String(raw == null ? '' : raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cellLabel(cell) {
    if (!cell) return '—';
    if (cell.granted_elm === true) return ELM_GRANTED_LABEL;
    return cell.label ? String(cell.label) : '—';
  }

  /**
   * "Enviar a ELM" is always rendered disabled and without data-action (no handler) until
   * the ELM transport is enabled.
   * @param {object|null|undefined} cell
   * @returns {string}
   */
  function elmCellHtml(cell) {
    if (!cell) return '<span class="preaprobados-elm is-unavailable">—</span>';
    var action = cell.action || {};
    if (action.show === true) {
      return (
        '<button type="button" class="btn preaprobados-cell-btn preaprobados-elm-send" disabled aria-disabled="true" title="' +
        esc(action.hint || SEND_PENDING_HINT) +
        '">Enviar a ELM</button>'
      );
    }
    var kind = /^[a-z0-9_]+$/.test(String(cell.kind || '')) ? String(cell.kind) : 'unknown';
    var title = '';
    if (cell.granted_elm === true && cell.provider_status) {
      title = ' title="' + esc('Estado ELM: ' + cell.provider_status) + '"';
    } else if (kind === 'not_sendable' && action.reason) {
      title = ' title="' + esc(action.reason) + '"';
    }
    return (
      '<span class="preaprobados-elm is-' +
      kind +
      (cell.granted_elm === true ? ' is-granted' : '') +
      '"' +
      title +
      '>' +
      esc(cellLabel(cell)) +
      '</span>'
    );
  }

  return {
    SEND_PENDING_HINT: SEND_PENDING_HINT,
    CDV_GRANTED_LABEL: CDV_GRANTED_LABEL,
    ELM_GRANTED_LABEL: ELM_GRANTED_LABEL,
    cellLabel: cellLabel,
    elmCellHtml: elmCellHtml,
  };
});
