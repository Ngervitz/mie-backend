'use strict';

/**
 * Janus Assist panel — client-only conversation state (this tab).
 * Collapse keeps history. "Nueva conversación" clears it.
 * POST /assist/chat; no localStorage / sessionStorage.
 */
(function () {
  var REQUEST_TIMEOUT_MS = 90000;
  var MAX_MESSAGE_CHARS = 8000;
  var ALLOWED_TAGS = [
    'p',
    'br',
    'strong',
    'em',
    'b',
    'i',
    'ul',
    'ol',
    'li',
    'h2',
    'h3',
    'h4',
    'blockquote',
    'code',
    'pre',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'a',
  ];

  var panel = document.getElementById('assist-panel');
  var fab = document.getElementById('assist-fab');
  var thread = document.getElementById('assist-thread');
  var errorEl = document.getElementById('assist-error');
  var form = document.getElementById('assist-form');
  var input = document.getElementById('assist-input');
  var sendBtn = document.getElementById('assist-send-btn');
  var collapseBtn = document.getElementById('assist-collapse-btn');
  var newBtn = document.getElementById('assist-new-btn');
  var shell = document.querySelector('#mie-dashboard-app .app-shell');

  if (!panel || !fab || !thread || !form || !input || !sendBtn) return;

  var conversationId = null;
  var conversationHistory = [];
  var busy = false;
  var panelOpen = false;
  var hasMarket = false;

  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) {
      el.setAttribute('hidden', '');
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.removeAttribute('hidden');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function setError(message) {
    if (!errorEl) return;
    if (!message) {
      errorEl.textContent = '';
      setHidden(errorEl, true);
      return;
    }
    errorEl.textContent = message;
    setHidden(errorEl, false);
  }

  function syncComposer() {
    var hasText = String(input.value || '').trim().length > 0;
    input.disabled = busy;
    sendBtn.disabled = busy || !hasText;
    sendBtn.textContent = busy ? 'Investigando…' : 'Enviar';
  }

  function scrollThread() {
    thread.scrollTop = thread.scrollHeight;
  }

  function showEmptyState() {
    thread.innerHTML = '';
    var empty = document.createElement('p');
    empty.className = 'assist-empty';
    empty.textContent =
      'Preguntá sobre competidores y actividad de anuncios. Esta conversación vive solo en esta pestaña.';
    thread.appendChild(empty);
  }

  function wrapMarkdownTables(root) {
    var tables = root.querySelectorAll('table');
    for (var i = 0; i < tables.length; i += 1) {
      var table = tables[i];
      if (table.parentElement && table.parentElement.classList.contains('assist-md-table-wrap')) {
        continue;
      }
      var wrap = document.createElement('div');
      wrap.className = 'assist-md-table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
  }

  function renderMarkdown(text) {
    var raw = String(text || '');
    var html = raw;
    if (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function') {
      html = marked.parse(raw, {
        gfm: true,
        breaks: true,
        headerIds: false,
      });
    } else {
      var div = document.createElement('div');
      div.textContent = raw;
      html = '<p>' + div.innerHTML.replace(/\n/g, '<br>') + '</p>';
    }
    if (typeof DOMPurify !== 'undefined' && DOMPurify && typeof DOMPurify.sanitize === 'function') {
      html = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ALLOWED_TAGS,
        ALLOWED_ATTR: ['href', 'title'],
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'img', 'svg'],
      });
    }
    var box = document.createElement('div');
    box.className = 'assist-md';
    box.innerHTML = html;
    var links = box.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i += 1) {
      var href = String(links[i].getAttribute('href') || '');
      if (!/^https?:\/\//i.test(href)) {
        links[i].removeAttribute('href');
        continue;
      }
      links[i].setAttribute('target', '_blank');
      links[i].setAttribute('rel', 'noopener noreferrer');
    }
    wrapMarkdownTables(box);
    return box;
  }

  function appendUserBubble(text) {
    var empty = thread.querySelector('.assist-empty');
    if (empty) empty.remove();
    var el = document.createElement('div');
    el.className = 'assist-msg assist-msg-user';
    el.textContent = text;
    thread.appendChild(el);
    return el;
  }

  function appendAssistantBubble(text) {
    var el = document.createElement('div');
    el.className = 'assist-msg assist-msg-assistant';
    el.appendChild(renderMarkdown(text));
    thread.appendChild(el);
    return el;
  }

  function appendPending() {
    var el = document.createElement('div');
    el.className = 'assist-msg assist-msg-assistant assist-msg-pending';
    el.setAttribute('data-assist-pending', 'true');
    el.textContent = 'Investigando… esto puede tardar unos 20 segundos.';
    thread.appendChild(el);
    return el;
  }

  function openPanel() {
    panelOpen = true;
    setHidden(panel, false);
    setHidden(fab, true);
    if (shell) shell.classList.add('assist-open');
    input.focus();
  }

  function collapsePanel() {
    panelOpen = false;
    setHidden(panel, true);
    if (hasMarket) setHidden(fab, false);
    if (shell) shell.classList.remove('assist-open');
  }

  function resetConversation() {
    conversationId = null;
    conversationHistory = [];
    busy = false;
    setError('');
    showEmptyState();
    input.value = '';
    syncComposer();
  }

  function applyMarketAccess(allowed) {
    hasMarket = Boolean(allowed);
    if (!hasMarket) {
      collapsePanel();
      setHidden(fab, true);
      return;
    }
    if (!panelOpen) setHidden(fab, false);
  }

  window.__janusAssistApplyAccess = applyMarketAccess;
  window.__janusAssistDebug = {
    failNextRequest: false,
    getState: function () {
      return {
        conversationId: conversationId,
        historyLength: conversationHistory.length,
        history: conversationHistory.slice(),
        panelOpen: panelOpen,
        busy: busy,
        hasMarket: hasMarket,
      };
    },
  };

  function fetchWithTimeout(url, init, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    var opts = {};
    var key;
    for (key in init) {
      if (Object.prototype.hasOwnProperty.call(init, key)) opts[key] = init[key];
    }
    opts.signal = controller.signal;
    return fetch(url, opts).finally(function () {
      clearTimeout(timer);
    });
  }

  function sendMessage(message) {
    if (busy) return;
    var text = String(message || '').trim();
    if (!text) return;
    if (text.length > MAX_MESSAGE_CHARS) {
      setError('El mensaje supera el máximo de ' + MAX_MESSAGE_CHARS + ' caracteres.');
      return;
    }

    setError('');
    busy = true;
    syncComposer();
    var userEl = appendUserBubble(text);
    var pendingEl = appendPending();
    scrollThread();
    input.value = '';

    var body = {
      message: text,
      conversationHistory: conversationHistory.slice(),
    };
    if (conversationId) body.conversationId = conversationId;

    var url = '/assist/chat';
    if (window.__janusAssistDebug && window.__janusAssistDebug.failNextRequest) {
      window.__janusAssistDebug.failNextRequest = false;
      url = '/__assist_force_fail__';
    }

    fetchWithTimeout(
      url,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS,
    )
      .then(function (res) {
        return res.text().then(function (raw) {
          var parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (err) {
            parsed = null;
          }
          return { ok: res.ok, status: res.status, parsed: parsed };
        });
      })
      .then(function (result) {
        if (pendingEl && pendingEl.parentNode) pendingEl.remove();
        if (!result.ok || !result.parsed || typeof result.parsed.reply !== 'string') {
          if (userEl && userEl.parentNode) userEl.remove();
          input.value = text;
          var errText =
            result.parsed && result.parsed.error
              ? String(result.parsed.error)
              : 'No se pudo obtener respuesta (HTTP ' + result.status + ').';
          if (result.status === 401) errText = 'Sesión vencida. Volvé a iniciar sesión.';
          setError(errText);
          if (!thread.querySelector('.assist-msg')) showEmptyState();
          return;
        }
        conversationHistory.push({ role: 'user', content: text });
        conversationHistory.push({
          role: 'assistant',
          content: result.parsed.reply,
        });
        if (result.parsed.conversationId) {
          conversationId = String(result.parsed.conversationId);
        }
        appendAssistantBubble(result.parsed.reply);
        scrollThread();
      })
      .catch(function (err) {
        if (pendingEl && pendingEl.parentNode) pendingEl.remove();
        if (userEl && userEl.parentNode) userEl.remove();
        input.value = text;
        var aborted =
          err &&
          (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
        setError(
          aborted
            ? 'La consulta tardó demasiado (más de 90s). La conversación no se borró; podés reintentar.'
            : 'Error de red. La conversación no se borró; podés reintentar.',
        );
        if (!thread.querySelector('.assist-msg')) showEmptyState();
      })
      .then(function () {
        busy = false;
        syncComposer();
        if (panelOpen) input.focus();
      });
  }

  fab.addEventListener('click', function () {
    if (!hasMarket) return;
    openPanel();
  });

  collapseBtn.addEventListener('click', function () {
    collapsePanel();
  });

  newBtn.addEventListener('click', function () {
    resetConversation();
  });

  input.addEventListener('input', syncComposer);

  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    sendMessage(input.value);
  });

  showEmptyState();
  syncComposer();
})();
