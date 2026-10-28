(function () {
  'use strict';

  var API = '/affiliates/v1';
  var state = {
    sessionToken: null,
    termsVersion: 'affiliate_v3',
    joinEnabled: false,
    inviteToken: null,
  };

  function qs(id) {
    return document.getElementById(id);
  }

  function show(el) {
    if (el) el.hidden = false;
  }

  function hide(el) {
    if (el) el.hidden = true;
  }

  function setStatus(text, kind) {
    var box = qs('join-status');
    if (!text) {
      hide(box);
      return;
    }
    box.textContent = text;
    box.className = 'status-msg status-msg--' + (kind || 'info');
    show(box);
  }

  function parseInviteToken() {
    try {
      var params = new URLSearchParams(window.location.search);
      var t = params.get('t') || params.get('invite_token');
      if (!t) return null;
      t = String(t).trim();
      return t || null;
    } catch (_e) {
      return null;
    }
  }

  async function apiPost(path, body, sessionToken) {
    var headers = { 'Content-Type': 'application/json' };
    if (sessionToken) {
      headers['X-Affiliate-Join-Session'] = sessionToken;
    }
    var res = await fetch(API + path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body || {}),
    });
    var json = null;
    try {
      json = await res.json();
    } catch (_e) {
      json = null;
    }
    return { status: res.status, body: json };
  }

  async function apiGet(path, sessionToken) {
    var headers = {};
    if (sessionToken) {
      headers['X-Affiliate-Join-Session'] = sessionToken;
    }
    var res = await fetch(API + path, { method: 'GET', headers: headers });
    var json = null;
    try {
      json = await res.json();
    } catch (_e) {
      json = null;
    }
    return { status: res.status, body: json };
  }

  function showJoinPanel() {
    show(qs('join-panel'));
  }

  function bindTermsCheckbox() {
    var cb = qs('accept-terms');
    var btn = qs('btn-send-otp');
    cb.addEventListener('change', function () {
      btn.disabled = !cb.checked || !state.joinEnabled;
    });
  }

  async function loadConfig() {
    var res = await apiGet('/config');
    if (res.status === 200 && res.body && res.body.ok) {
      state.joinEnabled = res.body.join_enabled === true;
      if (res.body.terms_version) {
        state.termsVersion = res.body.terms_version;
        var label = qs('terms-version-label');
        if (label) label.textContent = state.termsVersion;
      }
    }
  }

  async function validateInvite() {
    if (!state.inviteToken) return;

    showJoinPanel();

    if (!state.joinEnabled) {
      setStatus('Programa próximamente disponible.', 'warn');
      return;
    }

    setStatus('Validando tu invitación…', 'info');
    var res = await apiPost('/invite/validate', { t: state.inviteToken });
    if (res.status === 403) {
      setStatus('Programa próximamente disponible.', 'warn');
      return;
    }
    if (res.status !== 200 || !res.body || !res.body.ok) {
      setStatus(
        'No pudimos validar esta invitación. Verificá el enlace o contactá a Credizona.',
        'error',
      );
      return;
    }

    state.sessionToken = res.body.session_token;
    if (res.body.terms_version) {
      state.termsVersion = res.body.terms_version;
      var label = qs('terms-version-label');
      if (label) label.textContent = state.termsVersion;
    }

    var phoneEl = qs('phone-masked');
    if (res.body.phone_masked) {
      phoneEl.textContent =
        'Enviaremos un código al celular registrado: ' + res.body.phone_masked + '.';
      show(phoneEl);
    }

    setStatus(null);
  }

  async function onSendOtp() {
    if (!state.sessionToken || !state.joinEnabled) return;
    var btn = qs('btn-send-otp');
    btn.disabled = true;
    var res = await apiPost(
      '/terms/accept',
      { accept: true, terms_version: state.termsVersion },
      state.sessionToken,
    );
    if (res.status === 403) {
      setStatus('Programa próximamente disponible.', 'warn');
      btn.disabled = false;
      return;
    }
    if (res.status !== 200 || !res.body || !res.body.ok) {
      setStatus('No pudimos registrar la aceptación. Intentá de nuevo.', 'error');
      btn.disabled = false;
      return;
    }
    state.sessionToken = res.body.session_token || state.sessionToken;

    var otpRes = await apiPost('/otp/send', {}, state.sessionToken);
    if (otpRes.status === 403) {
      setStatus('Programa próximamente disponible.', 'warn');
      btn.disabled = false;
      return;
    }
    if (otpRes.status !== 200 || !otpRes.body || !otpRes.body.ok) {
      setStatus('No pudimos enviar el SMS. Esperá un momento e intentá de nuevo.', 'error');
      btn.disabled = false;
      return;
    }
    state.sessionToken = otpRes.body.session_token || state.sessionToken;
    hide(qs('step-terms'));
    show(qs('step-otp'));
    qs('otp-input').focus();
  }

  async function onVerifyOtp() {
    if (!state.sessionToken) return;
    var otp = String(qs('otp-input').value || '').trim();
    if (!/^\d{6}$/.test(otp)) {
      setStatus('Ingresá un código de 6 dígitos.', 'error');
      return;
    }
    var btn = qs('btn-verify-otp');
    btn.disabled = true;
    var res = await apiPost('/otp/verify', { otp: otp }, state.sessionToken);
    if (res.status === 403) {
      setStatus('Programa próximamente disponible.', 'warn');
      btn.disabled = false;
      return;
    }
    if (res.status !== 200 || !res.body || !res.body.ok) {
      setStatus('Código incorrecto o vencido. Revisá el SMS e intentá de nuevo.', 'error');
      btn.disabled = false;
      return;
    }
    state.sessionToken = res.body.session_token || state.sessionToken;

    var linkRes = await apiGet('/link', state.sessionToken);
    if (linkRes.status !== 200 || !linkRes.body || !linkRes.body.ok || !linkRes.body.referral_url) {
      setStatus('Registro completado, pero no pudimos cargar tu enlace. Recargá la página.', 'error');
      btn.disabled = false;
      return;
    }

    var url = linkRes.body.referral_url;
    qs('referral-url').textContent = url;
    var waText = encodeURIComponent('Conocé Credizona y solicitá tu préstamo: ' + url);
    qs('btn-whatsapp').href = 'https://wa.me/?text=' + waText;

    hide(qs('step-otp'));
    hide(qs('join-status'));
    show(qs('step-success'));
    btn.disabled = false;
  }

  function onCopyLink() {
    var url = qs('referral-url').textContent;
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () {
          setStatus('Enlace copiado.', 'info');
        },
        function () {
          setStatus('No pudimos copiar automáticamente. Seleccioná el enlace y copialo.', 'warn');
        },
      );
    }
  }

  async function init() {
    bindTermsCheckbox();
    state.inviteToken = parseInviteToken();
    await loadConfig();

    qs('btn-send-otp').addEventListener('click', onSendOtp);
    qs('btn-verify-otp').addEventListener('click', onVerifyOtp);
    qs('btn-copy-link').addEventListener('click', onCopyLink);

    if (state.inviteToken) {
      await validateInvite();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
