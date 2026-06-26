(function () {
  'use strict';

  var app = document.getElementById('app');

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Local "today" so the default matches the user's calendar day.
  function localToday() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function getDate() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('date');
    if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return raw;
    }
    return localToday();
  }

  function renderHeader(date) {
    return (
      '<header class="brief-header">' +
        '<div>' +
          '<div class="logo">Hugo</div>' +
          '<div class="product">Voice Brief</div>' +
        '</div>' +
        '<div class="meta-right">' +
          '<div class="date">' + escapeHtml(date) + '</div>' +
        '</div>' +
      '</header>'
    );
  }

  function renderNav() {
    return (
      '<section class="investigation-cta">' +
        '<a class="btn btn-secondary cta-link" href="hugo-brief.html">Ver Executive Brief →</a>' +
        '&nbsp;&nbsp;' +
        '<a class="btn btn-secondary cta-link" href="mie-dashboard.html">Ver datos operativos</a>' +
      '</section>'
    );
  }

  function renderLoading(date) {
    app.innerHTML =
      renderHeader(date) +
      '<div class="center-state">' +
        '<div class="spinner"></div>' +
        '<div class="state-text">Preparando el Voice Brief de Hugo…</div>' +
      '</div>';
  }

  function renderError(date, message) {
    app.innerHTML =
      renderHeader(date) +
      '<div class="error-card">' +
        '<h3>No se pudo cargar el Voice Brief</h3>' +
        '<p>' + escapeHtml(message) + '</p>' +
        '<button class="btn" id="retry-btn">Reintentar</button>' +
      '</div>' +
      renderNav();

    var retry = document.getElementById('retry-btn');
    if (retry) {
      retry.addEventListener('click', function () { load(date); });
    }
  }

  function renderBrief(data) {
    var cachedTag = data.cached
      ? '<span class="dq-item"><span class="dq-key">Origen</span><span class="dq-val">caché</span></span>'
      : '<span class="dq-item"><span class="dq-key">Origen</span><span class="dq-val">generado ahora</span></span>';

    var transcriptHtml;
    if (data.transcript) {
      transcriptHtml = '<p>' + escapeHtml(data.transcript) + '</p>';
    } else {
      transcriptHtml = '<p class="empty-note">Transcripción no disponible para este audio en caché.</p>';
    }

    app.innerHTML =
      renderHeader(data.date) +
      '<section class="section">' +
        '<audio controls preload="auto" style="width:100%;" src="' + escapeHtml(data.audioUrl) + '"></audio>' +
      '</section>' +
      '<section class="section">' +
        '<div class="dq-grid">' + cachedTag + '</div>' +
      '</section>' +
      '<section class="section">' +
        '<h2 class="section-title">Transcripción</h2>' +
        '<div class="card">' + transcriptHtml + '</div>' +
      '</section>' +
      renderNav();
  }

  function load(date) {
    renderLoading(date);

    fetch('/hugo/voice?date=' + encodeURIComponent(date), {
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          var msg = result.body && result.body.error
            ? result.body.error
            : 'Error inesperado al generar el audio.';
          renderError(date, msg);
          return;
        }
        renderBrief(result.body);
      })
      .catch(function () {
        renderError(date, 'No se pudo conectar con el servidor.');
      });
  }

  load(getDate());
})();
