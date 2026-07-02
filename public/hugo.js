(function () {
  'use strict';

  // ---- DOM refs ----
  var headerDate = document.getElementById('header-date');
  var headerBadges = document.getElementById('header-badges');
  var briefPanel = document.getElementById('brief-panel');
  var questionsPanel = document.getElementById('questions-panel');
  var answerPanel = document.getElementById('answer-panel');
  var marketPanel = document.getElementById('market-panel');
  var executionPanel = document.getElementById('execution-panel');
  var input = document.getElementById('question-input');
  var sendBtn = document.getElementById('send-btn');
  var inputError = document.getElementById('input-error');
  var overlay = document.getElementById('overlay');
  var hugoPresence = document.getElementById('hugo-presence');

  // MIE-23: presentation mode switch. Avatar mode is the default and must remain
  // unchanged. Abstract mode is a reversible visual layer only.
  // Resolution order: window.__HUGO_PRESENTATION_MODE → URL param → localStorage → avatar.
  function resolvePresentationMode() {
    try {
      var injected = window.__HUGO_PRESENTATION_MODE;
      if (injected === 'abstract' || injected === 'avatar') return injected;
      var params = new URLSearchParams(window.location.search);
      var fromUrl = params.get('presentation') || params.get('PRESENTATION_MODE');
      if (fromUrl === 'abstract' || fromUrl === 'avatar') return fromUrl;
      var stored = localStorage.getItem('hugo_presentation_mode');
      if (stored === 'abstract' || stored === 'avatar') return stored;
    } catch (err) {
      // never throw
    }
    return 'avatar';
  }

  var PRESENTATION_MODE = resolvePresentationMode();
  var isAbstractMode = PRESENTATION_MODE === 'abstract';

  // MIE-23B: remote speaking flag — set ONLY by the existing LiveKit
  // ActiveSpeakersChanged handler; read by syncAbstractPresence (no parallel listeners).
  var abstractRemoteSpeaking = false;
  var abstractEndedUntil = 0;

  function lifecycleLog(msg, extra) {
    try {
      if (extra !== undefined) console.log('[HUGO lifecycle]', msg, extra);
      else console.log('[HUGO lifecycle]', msg);
    } catch (err) {
      // never throw
    }
  }

  function idleLog(msg, extra) {
    try {
      if (extra !== undefined) console.log('[HUGO idle]', msg, extra);
      else console.log('[HUGO idle]', msg);
    } catch (err) {
      // never throw
    }
  }

  function roomLog(msg, extra) {
    try {
      if (extra !== undefined) console.log('[HUGO room]', msg, extra);
      else console.log('[HUGO room]', msg);
    } catch (err) {
      // never throw
    }
  }

  function videoLog(msg, extra) {
    try {
      if (extra !== undefined) console.log('[HUGO video]', msg, extra);
      else console.log('[HUGO video]', msg);
    } catch (err) {
      // never throw
    }
  }

  // MIE-26 / MIE-26A: microphone pipeline diagnostic — logging only.
  function voiceLog(msg, extra) {
    try {
      var prefix = '[Hugo Voice]';
      if (extra !== undefined) console.log(prefix, msg, extra);
      else console.log(prefix, msg);
    } catch (err1) {
      try {
        console.warn('[Hugo Voice] log failed', msg, extra, err1);
      } catch (err2) {
        // never throw
      }
    }
  }

  function logMicrophonePermissionState(done) {
    var settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      if (typeof done === 'function') done();
    }

    try {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
        voiceLog('microphone permission query unavailable');
        settle();
        return;
      }

      // MIE-26A: permissions.query can hang in some browsers/contexts — never block logs.
      setTimeout(function () {
        if (!settled) {
          voiceLog('microphone permission query timed out');
          settle();
        }
      }, 2500);

      var permPromise = navigator.permissions.query({ name: 'microphone' });
      if (!permPromise || typeof permPromise.then !== 'function') {
        voiceLog('microphone permission query failed', { reason: 'no promise returned' });
        settle();
        return;
      }

      permPromise
        .then(function (result) {
          if (result && result.state === 'granted') voiceLog('microphone permission granted');
          else if (result && result.state === 'denied') voiceLog('microphone permission denied');
          else voiceLog('microphone permission state', { state: result && result.state });
          settle();
        })
        .catch(function (err) {
          voiceLog('microphone permission query failed', {
            message: err && err.message ? err.message : String(err),
          });
          settle();
        });
    } catch (err) {
      voiceLog('microphone permission query failed', {
        message: err && err.message ? err.message : String(err),
      });
      settle();
    }
  }

  function findLocalMicrophonePublication(room) {
    var lp = room && room.localParticipant;
    if (!lp) return null;
    try {
      var pubs = lp.audioTrackPublications;
      if (pubs && typeof pubs.forEach === 'function') {
        var found = null;
        pubs.forEach(function (pub) {
          if (found || !pub) return;
          var source = pub.source;
          if (source === 'microphone' || source === 1) found = pub;
        });
        if (found) return found;
      }
      var allPubs = lp.trackPublications;
      if (allPubs && typeof allPubs.forEach === 'function') {
        var foundAll = null;
        allPubs.forEach(function (pub) {
          if (foundAll || !pub) return;
          if (pub.kind === 'audio' && (pub.source === 'microphone' || pub.source === 1)) {
            foundAll = pub;
          }
        });
        return foundAll;
      }
    } catch (err) {
      voiceLog('microphone publication inspect failed', {
        message: err && err.message ? err.message : String(err),
      });
    }
    return null;
  }

  function runMicrophonePipelineChecks(context) {
    voiceLog('pipeline check', { context: context || 'unknown' });

    if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      voiceLog('getUserMedia API available');
    } else {
      voiceLog('getUserMedia failed', { reason: 'API unavailable' });
    }
    voiceLog('getUserMedia not invoked by Hugo');

    var LiveKit = window.LivekitClient || window.LiveKitClient;
    if (LiveKit && typeof LiveKit.createLocalAudioTrack === 'function') {
      voiceLog('LocalAudioTrack SDK API available');
    } else {
      voiceLog('LocalAudioTrack creation failed', { reason: 'SDK API unavailable' });
    }
    voiceLog('LocalAudioTrack not created by Hugo');

    var room = window.__hugoLiveKitRoom;
    var lp = room && room.localParticipant;
    if (!lp) voiceLog('localParticipant is null');
    else voiceLog('localParticipant available');

    voiceLog('publishMicrophone not invoked by Hugo');

    var micPub = findLocalMicrophonePublication(room);
    if (context === 'after_renewal') {
      if (micPub) voiceLog('microphone track still published');
      else voiceLog('microphone track missing after renewal');
    } else if (micPub) {
      voiceLog('microphone published', {
        trackSid: micPub.trackSid || null,
        muted: typeof micPub.isMuted === 'boolean' ? micPub.isMuted : null,
      });
    } else {
      voiceLog('publish failed', { reason: 'no local microphone publication found' });
    }

    try {
      var audioEl = document.getElementById('avatar-audio');
      voiceLog('ElevenLabs inbound audio element', {
        hasSrcObject: !!(audioEl && audioEl.srcObject),
        paused: audioEl ? audioEl.paused : null,
        muted: audioEl ? audioEl.muted : null,
      });
      voiceLog('ElevenLabs user audio receipt cannot be verified from client');
    } catch (err) {
      voiceLog('ElevenLabs inbound audio inspect failed', {
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  function diagnoseMicrophonePipeline(context) {
    if (typeof window.__hugoVoiceDiagnose === 'function') {
      window.__hugoVoiceDiagnose(context);
    }
  }

  function applyPresentationMode() {
    try {
      if (isAbstractMode) {
        document.body.setAttribute('data-presentation-mode', PRESENTATION_MODE);
        document.body.setAttribute('data-hugo-conversation', hugoConversationState);
      } else {
        document.body.setAttribute('data-presentation-mode', PRESENTATION_MODE);
        document.body.removeAttribute('data-hugo-conversation');
      }
      if (hugoPresence) {
        if (isAbstractMode) {
          hugoPresence.classList.remove('hidden');
          hugoPresence.setAttribute('aria-hidden', 'false');
        } else {
          hugoPresence.classList.add('hidden');
          hugoPresence.setAttribute('aria-hidden', 'true');
        }
      }
    } catch (err) {
      // never throw
    }
  }

  applyPresentationMode();

  // ---- State (memory only, never persisted) ----
  var knowledge = null;
  var history = [];
  var asking = false;

  // MIE-18A: conversation-first state machine.
  // Allowed: connecting | ready | briefing | idle | thinking | speaking | fallback | error
  var hugoConversationState = 'connecting';

  // MIE-22B: the briefing is modeled as ordered CHAPTERS, not cards. They stay
  // hidden until Hugo "reaches" each one, then reveal sequentially. The reveal
  // TRIGGER for v1 is a deterministic timer; the architecture is organised around
  // chapters so a future version can swap the trigger for real speech events
  // (revealNextChapter) without touching the UX. Presence flags below let us skip
  // empty chapters and never reveal a section that has no real content.
  var marketHasRows = false;
  var questionsHasItems = false;
  var executionHasData = false;

  // Ordered list of present chapters (each = array of DOM elements to reveal).
  var briefingChapters = [];
  var nextChapterIndex = 0;
  var chapterRevealTimerId = null;
  var briefingRevealStarted = false;
  // v1 pacing between chapter reveals (placeholder for real speech events).
  var CHAPTER_REVEAL_INTERVAL_MS = 3500;

  var MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDate(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    if (!m) return String(d || '');
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }

  function brief() {
    return (knowledge && knowledge.analysis && knowledge.analysis.brief) || {};
  }

  function supportingData() {
    return (knowledge && knowledge.analysis && knowledge.analysis.supportingData) || {};
  }

  // Prefer brief.attention, then top-level attention, then attentionLevel.
  function normAttention() {
    var b = brief();
    var raw = b.attention || (knowledge && knowledge.attention) || (knowledge && knowledge.attentionLevel) || '';
    var a = String(raw).toUpperCase();
    if (a === 'HIGH_ACTIVITY') a = 'HIGH';
    if (a === 'STRATEGIC_MOVEMENT') a = 'STRATEGIC';
    if (['NORMAL', 'INTERESTING', 'HIGH', 'STRATEGIC'].indexOf(a) !== -1) return a;
    return 'NORMAL';
  }

  function normConfidence() {
    var b = brief();
    var c = String((b.confidence || (knowledge && knowledge.confidence) || '')).toUpperCase();
    return ['LOW', 'MEDIUM', 'HIGH'].indexOf(c) !== -1 ? c : '';
  }

  // ---------- Rendering ----------
  function renderHeader() {
    headerDate.textContent = fmtDate(knowledge && knowledge.date);

    var att = normAttention();
    var conf = normConfidence();
    var html = '<span class="badge att-' + att + '">' + att + '</span>';
    if (conf) {
      html += '<span class="badge conf-' + conf + '">' + conf + '</span>';
    }
    headerBadges.innerHTML = html;
  }

  function renderBrief() {
    var b = brief();
    var html = '';

    // The CTA + welcome are the meeting's entry point — always visible. They are
    // NOT a chapter; everything below them is revealed progressively.
    html +=
      '<div class="voice-row">' +
        '<button class="btn btn-primary" id="voice-btn" type="button">&#9654; Iniciar conversación con Hugo</button>' +
        '<div class="voice-status" id="voice-status"></div>' +
        '<div class="welcome-note" id="welcome-note">Hugo tiene listo el briefing competitivo de hoy. Cuando quieras, iniciá la reunión y te lo presenta.</div>' +
        '<button type="button" class="report-expand-link" id="report-expand-link">Ver informe completo</button>' +
        '<div id="voice-area">' +
          '<button type="button" class="btn talk-voice-btn hidden" id="talk-voice-btn">Hablar con Hugo</button>' +
          '<div class="voice-status talk-voice-status hidden" id="talk-voice-status"></div>' +
        '</div>' +
      '</div>';

    // Chapter 1 — Executive Brief (the lead of the document).
    if (b.headline || b.whyItMatters) {
      html += '<div class="chapter hidden" id="chapter-brief">';
      if (b.headline) html += '<h1 class="headline">' + escapeHtml(b.headline) + '</h1>';
      if (b.whyItMatters) html += '<p class="why-it-matters">' + escapeHtml(b.whyItMatters) + '</p>';
      html += '</div>';
    }

    // Chapter 2 — Recommended Action (revealed right after the brief).
    var action = b.recommendedAction;
    if (action && (action.action || action.reason)) {
      html += '<div class="chapter hidden brief-section" id="chapter-action"><div class="section-label">Acción recomendada</div>';
      html += '<div class="action-card">';
      if (action.priority) html += '<span class="action-priority">' + escapeHtml(action.priority) + '</span>';
      if (action.action) html += '<div class="action-text">' + escapeHtml(action.action) + '</div>';
      if (action.reason) html += '<div class="action-reason">' + escapeHtml(action.reason) + '</div>';
      html += '</div></div>';
    }

    // Chapter 3 — Top Stories.
    var stories = Array.isArray(b.topStories) ? b.topStories : [];
    if (stories.length) {
      html += '<div class="chapter hidden brief-section" id="chapter-stories"><div class="section-label">Top Stories</div>';
      stories.forEach(function (s) {
        s = s || {};
        html += '<div class="story">';
        if (s.entity) html += '<div class="story-entity">' + escapeHtml(s.entity) + '</div>';
        if (s.fact) html += '<div class="story-fact">' + escapeHtml(s.fact) + '</div>';
        if (s.interpretation) html += '<div class="story-interpretation">' + escapeHtml(s.interpretation) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Chapter 4 — Watch Tomorrow.
    var watch = Array.isArray(b.watchTomorrow) ? b.watchTomorrow : [];
    if (watch.length) {
      html += '<div class="chapter hidden brief-section" id="chapter-watch"><div class="section-label">Vigilar mañana</div>';
      watch.forEach(function (w) {
        w = w || {};
        html += '<div class="watch-item">';
        if (w.entity) html += '<div class="watch-entity">' + escapeHtml(w.entity) + '</div>';
        if (w.signal) html += '<div class="watch-signal">' + escapeHtml(w.signal) + '</div>';
        if (w.ifConfirmed) html += '<div class="watch-if">' + escapeHtml(w.ifConfirmed) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    briefPanel.innerHTML = html;

    // MIE-18A: the CTA is now the single entry point of the whole conversation.
    // It no longer calls /hugo/voice; it starts the ElevenLabs Agent flow.
    var voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) voiceBtn.addEventListener('click', startConversation);
    var talkVoiceBtn = document.getElementById('talk-voice-btn');
    if (talkVoiceBtn) talkVoiceBtn.addEventListener('click', onTalkVoiceButtonClick);
    var expandLink = document.getElementById('report-expand-link');
    if (expandLink) expandLink.addEventListener('click', revealFullReport);
    // Sync the freshly rendered button with the current state.
    setHugoConversationState(hugoConversationState);
  }

  function renderMarket() {
    var inv = supportingData().marketInventory;
    var rows = Array.isArray(inv) ? inv.slice(0, 8) : [];
    if (!rows.length) {
      marketHasRows = false;
      marketPanel.classList.add('hidden');
      return;
    }

    var html = '<div class="panel-title">Mercado</div>';
    rows.forEach(function (r) {
      r = r || {};
      var ads = Number.isFinite(Number(r.activeAds)) ? Number(r.activeAds) : 0;
      html +=
        '<div class="market-row">' +
          '<span class="market-entity">' + escapeHtml(r.entity || '—') + '</span>' +
          '<span class="market-ads">' + ads + '</span>' +
        '</div>';
    });
    marketPanel.innerHTML = html;
    // MIE-22B: content is ready, but Supporting Information stays hidden until the
    // reveal sequence reaches it — nothing appears before Hugo presents it.
    marketHasRows = true;
  }

  // MIE-22B — Execution Summary. Operational transparency, NOT a technical
  // dashboard. Strictly consumes real values exposed by the backend
  // (knowledge.generatedAt + knowledge.meta). Anything missing is simply omitted;
  // nothing is ever estimated, calculated or fabricated. If no real value exists
  // at all, the whole section stays hidden.
  function renderExecution() {
    var meta = (knowledge && knowledge.meta) || null;
    if (!meta) {
      executionHasData = false;
      executionPanel.classList.add('hidden');
      return;
    }

    var rows = '';
    var generated = fmtClock(knowledge && knowledge.generatedAt);
    if (generated) {
      rows += execItem('Generado', generated);
    }

    var durationMs = meta.telemetry && meta.telemetry.durationMs;
    var duration = fmtDuration(durationMs);
    if (duration) {
      rows += execItem('Duración', duration);
    }

    // AI Cost is the TOTAL execution cost the backend reports (it already
    // aggregates every measured provider, e.g. Claude + GPT). We never display a
    // single-provider cost and never sum anything ourselves.
    var totalCost = meta.financial && meta.financial.totalRunCostUsd;
    var cost = fmtCostUsd(totalCost);
    if (cost) {
      rows += execItem('Costo IA', cost);
    }

    // Models actually used, exactly as exposed by the backend. The per-provider
    // cost breakdown stays internal and is never shown.
    var models = [];
    if (meta.modelArchitect) models.push(String(meta.modelArchitect));
    if (meta.modelAuditor) models.push(String(meta.modelAuditor));

    if (!rows && !models.length) {
      executionHasData = false;
      executionPanel.classList.add('hidden');
      return;
    }

    var html = '<div class="panel-title">Ejecución</div>';
    if (rows) html += '<div class="exec-grid">' + rows + '</div>';
    if (models.length) {
      html += '<div class="exec-models"><div class="exec-label">Modelos</div><div class="exec-model-list">';
      models.forEach(function (m) {
        html += '<span class="exec-model">' + escapeHtml(m) + '</span>';
      });
      html += '</div></div>';
    }

    executionPanel.innerHTML = html;
    executionHasData = true;
  }

  function execItem(label, value) {
    return '<div class="exec-item">' +
      '<div class="exec-label">' + escapeHtml(label) + '</div>' +
      '<div class="exec-value">' + escapeHtml(value) + '</div>' +
    '</div>';
  }

  // Local wall-clock HH:MM for the generation timestamp. Returns '' if unparseable.
  function fmtClock(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  // Human duration: "9.4 s" under a minute, "1.5 min" otherwise. '' if invalid.
  function fmtDuration(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return '';
    if (n < 60000) return (n / 1000).toFixed(1) + ' s';
    return (n / 60000).toFixed(1) + ' min';
  }

  // Total cost as "USD X.XXXX". '' if not a real number.
  function fmtCostUsd(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return '';
    return 'USD ' + n.toFixed(4);
  }

  function renderQuestions() {
    var b = brief();
    var qs = Array.isArray(b.followUpQuestions) ? b.followUpQuestions.slice(0, 3) : [];
    qs = qs.filter(function (q) { return typeof q === 'string' && q.trim(); });
    if (!qs.length) {
      questionsHasItems = false;
      questionsPanel.classList.add('hidden');
      return;
    }

    questionsPanel.innerHTML =
      '<div class="panel-title">Preguntas sugeridas</div>' +
      '<div class="q-list" id="suggested-list"></div>';
    var list = document.getElementById('suggested-list');
    qs.forEach(function (q) { list.appendChild(questionButton(q)); });
    // MIE-22B: kept hidden until the reveal sequence reaches the questions.
    questionsHasItems = true;
  }

  function questionButton(q) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'q-btn';
    btn.textContent = q;
    btn.addEventListener('click', function () {
      input.value = q;
      submitQuestion();
    });
    return btn;
  }

  // ---------- MIE-22B: Briefing chapter reveal ----------
  // Build the ordered list of PRESENT chapters. Reveal order matches the
  // document's visual order so nothing ever pops in above already-shown content:
  //   Executive Brief → Recommended Action → Top Stories → Watch Tomorrow →
  //   Suggested Questions → Supporting Information (Market + Execution).
  function buildBriefingChapters() {
    briefingChapters = [];
    nextChapterIndex = 0;

    function addChapter(els) {
      var present = (els || []).filter(Boolean);
      if (present.length) briefingChapters.push(present);
    }

    addChapter([document.getElementById('chapter-brief')]);
    addChapter([document.getElementById('chapter-action')]);
    addChapter([document.getElementById('chapter-stories')]);
    addChapter([document.getElementById('chapter-watch')]);
    addChapter([questionsHasItems ? questionsPanel : null]);
    // Supporting Information is a single chapter: the market table plus the
    // quiet execution summary, revealed together.
    addChapter([
      marketHasRows ? marketPanel : null,
      executionHasData ? executionPanel : null,
    ]);
  }

  // Reveal one chapter (fade + subtle vertical motion via the .revealed class).
  function clearChapterFocus() {
    try {
      var focused = document.querySelectorAll('.chapter.chapter-focus');
      for (var i = 0; i < focused.length; i++) focused[i].classList.remove('chapter-focus');
    } catch (err) {
      // never throw
    }
  }

  function setChapterFocus(chapter) {
    if (!isAbstractMode || !chapter) return;
    clearChapterFocus();
    chapter.forEach(function (el) { if (el) el.classList.add('chapter-focus'); });
  }

  function finishBriefingReveal() {
    if (!isAbstractMode) return;
    clearChapterFocus();
    document.body.classList.add('briefing-complete');
  }

  // MIE-23: reveal the entire document immediately — no conversation, no voice.
  function revealFullReport() {
    try {
      if (chapterRevealTimerId) {
        clearTimeout(chapterRevealTimerId);
        chapterRevealTimerId = null;
      }
      buildBriefingChapters();
      briefingChapters.forEach(function (chapter) {
        chapter.forEach(function (el) {
          if (!el) return;
          el.classList.remove('hidden');
          el.classList.add('revealed');
          el.classList.remove('chapter-focus');
        });
      });
      var welcome = document.getElementById('welcome-note');
      if (welcome) welcome.classList.add('hidden');
      clearChapterFocus();
      document.body.classList.add('report-expanded');
      document.body.classList.add('briefing-complete');
      briefingRevealStarted = true;
      var expandLink = document.getElementById('report-expand-link');
      if (expandLink) expandLink.classList.add('hidden');
    } catch (err) {
      // never throw
    }
  }

  function revealChapter(chapter) {
    if (!chapter) return;
    chapter.forEach(function (el) {
      if (!el) return;
      el.classList.remove('hidden');
    });
    // Double rAF so the transition runs from the pre-reveal state.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        chapter.forEach(function (el) { if (el) el.classList.add('revealed'); });
        setChapterFocus(chapter);
        var anchor = chapter[0];
        if (anchor && typeof anchor.scrollIntoView === 'function') {
          try { anchor.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* noop */ }
        }
      });
    });
  }

  // Advance to the next chapter. This is the single SEAM the reveal is built
  // around: v1 calls it on a timer; a future version can call it from real
  // speech events without changing anything else.
  function revealNextChapter() {
    if (nextChapterIndex >= briefingChapters.length) {
      if (chapterRevealTimerId) { clearTimeout(chapterRevealTimerId); chapterRevealTimerId = null; }
      finishBriefingReveal();
      return;
    }
    if (avatarConversationActive) {
      resetAvatarIdleTimer('briefing_chapter');
    }
    revealChapter(briefingChapters[nextChapterIndex]);
    nextChapterIndex += 1;
    scheduleNextChapterReveal();
  }

  function scheduleNextChapterReveal() {
    if (chapterRevealTimerId) { clearTimeout(chapterRevealTimerId); chapterRevealTimerId = null; }
    if (nextChapterIndex >= briefingChapters.length) return;
    chapterRevealTimerId = setTimeout(revealNextChapter, CHAPTER_REVEAL_INTERVAL_MS);
  }

  // Begin the progressive reveal. Idempotent: the briefing is presented once per
  // page session (a reconnect after idle never replays it). Triggered when Hugo
  // starts the briefing (and as a safety net when the avatar is unavailable so
  // the report is never trapped empty after an explicit start).
  function startBriefingReveal() {
    if (briefingRevealStarted) return;
    briefingRevealStarted = true;

    var welcome = document.getElementById('welcome-note');
    if (welcome) welcome.classList.add('hidden');

    buildBriefingChapters();
    revealNextChapter();
  }

  // MIE-23 / MIE-23B: pulse states via existing conversational + audio + LiveKit
  // signals. One function, no parallel listeners.
  function syncAbstractPresence() {
    if (!isAbstractMode || !hugoPresence) return;

    var audioSpeaking = false;
    try {
      var audioEl = document.getElementById('avatar-audio');
      if (audioEl && audioEl.srcObject && !audioEl.paused && !audioEl.muted) {
        audioSpeaking = true;
      }
    } catch (err) {
      // never throw
    }

    var thinking = asking
      || hugoConversationState === 'thinking'
      || hugoConversationState === 'briefing'
      || hugoConversationState === 'connecting';
    var speaking = audioSpeaking || abstractRemoteSpeaking
      || hugoConversationState === 'speaking';
    var ended = !avatarConversationActive && Date.now() < abstractEndedUntil;

    var pulseState = 'idle';
    if (ended) pulseState = 'ended';
    else if (speaking) pulseState = 'speaking';
    else if (thinking) pulseState = 'thinking';

    var states = ['idle', 'thinking', 'speaking', 'ended'];
    for (var si = 0; si < states.length; si++) {
      hugoPresence.classList.toggle('presence-state-' + states[si], pulseState === states[si]);
    }
  }

  function wireAbstractAudioPresence(audioEl) {
    wireAvatarAudioLifecycle(audioEl);
  }

  // Remote audio play = real conversation activity (all presentation modes).
  function wireAvatarAudioLifecycle(audioEl) {
    if (!audioEl || audioEl.__hugoLifecycleWired) return;
    audioEl.__hugoLifecycleWired = true;
    function onAudioActivity(evt) {
      if (isAbstractMode) syncAbstractPresence();
      if (!avatarConversationActive) return;
      if (evt === 'play' || evt === 'playing') {
        resetAvatarIdleTimer('remote_audio');
        return;
      }
      // timeupdate: extend activity while audio plays; arm/log throttled inside reset.
      if (evt === 'timeupdate' && !audioEl.paused && !audioEl.muted) {
        resetAvatarIdleTimer('remote_audio_progress');
      }
    }
    ['play', 'playing', 'timeupdate', 'pause', 'ended', 'volumechange'].forEach(function (evt) {
      audioEl.addEventListener(evt, function () { onAudioActivity(evt); });
    });
  }

  // Video lifecycle: never stop the room on pause/ended — only log + idle reset on play.
  function wireAvatarVideoLifecycle(videoEl) {
    if (!videoEl || videoEl.__hugoVideoLifecycleWired) return;
    videoEl.__hugoVideoLifecycleWired = true;
    function onVideoEvent(evt) {
      if (avatarConversationActive && (evt === 'play' || evt === 'playing')) {
        resetAvatarIdleTimer('remote_video');
      }
      if (evt === 'pause' || evt === 'ended' || evt === 'stalled'
        || evt === 'suspend' || evt === 'emptied' || evt === 'error') {
        videoLog(evt, {
          paused: videoEl.paused,
          readyState: videoEl.readyState,
          hasSrcObject: !!videoEl.srcObject,
        });
      }
    }
    ['play', 'playing', 'pause', 'ended', 'stalled', 'suspend', 'emptied', 'error']
      .forEach(function (evt) {
        videoEl.addEventListener(evt, function () { onVideoEvent(evt); });
      });
  }

  // ---------- Ask ----------
  function setAsking(on) {
    asking = on;
    sendBtn.disabled = on;
    sendBtn.textContent = on ? 'Pensando...' : 'Enviar';
    syncAbstractPresence();
  }

  // MIE-22B: the Q&A is no longer a floating overlay. Each exchange is appended
  // into the report as a new "Conversación" section — like adding an appendix to
  // today's briefing. It lives in the document flow (right column), so it never
  // covers Hugo and never floats over the report.
  function ensureConversationOpen() {
    if (answerPanel.classList.contains('conversation-open')) return;
    answerPanel.classList.add('conversation-open');
    answerPanel.classList.remove('hidden');
    var title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'Conversación';
    answerPanel.appendChild(title);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { answerPanel.classList.add('visible'); });
    });
  }

  // Insert the question immediately as a new section, with a pending answer slot
  // directly below it. Returns refs so the answer can be filled in on response.
  function appendQuestionEntry(questionText) {
    ensureConversationOpen();

    var entry = document.createElement('div');
    entry.className = 'qa-entry';

    var q = document.createElement('div');
    q.className = 'qa-question';
    q.textContent = questionText;

    var a = document.createElement('div');
    a.className = 'qa-answer qa-pending';
    a.textContent = 'Hugo está pensando...';

    entry.appendChild(q);
    entry.appendChild(a);
    answerPanel.appendChild(entry);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { entry.classList.add('revealed'); });
    });
    if (typeof entry.scrollIntoView === 'function') {
      try { entry.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* noop */ }
    }

    return { entry: entry, answerNode: a };
  }

  function fillAnswer(ref, data) {
    if (!ref || !ref.answerNode) return;
    ref.answerNode.classList.remove('qa-pending');
    ref.answerNode.textContent = data.answer || '';

    var next = Array.isArray(data.nextQuestions) ? data.nextQuestions : [];
    next = next.filter(function (q) { return typeof q === 'string' && q.trim(); }).slice(0, 3);
    if (next.length) {
      var list = document.createElement('div');
      list.className = 'q-list';
      next.forEach(function (q) { list.appendChild(questionButton(q)); });
      ref.entry.appendChild(list);
    }

    if (ref.entry && typeof ref.entry.scrollIntoView === 'function') {
      try { ref.entry.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* noop */ }
    }
  }

  function fillAnswerError(ref, message) {
    if (!ref || !ref.answerNode) return;
    ref.answerNode.classList.remove('qa-pending');
    ref.answerNode.classList.add('qa-error');
    ref.answerNode.textContent = message || 'No se pudo obtener respuesta.';
  }

  function submitQuestion() {
    if (asking) return;
    var question = String(input.value || '').trim();
    inputError.textContent = '';
    if (!question) return;

    setAsking(true);
    // MIE-17C: sending a message is real conversation activity.
    resetAvatarIdleTimer('user_message');

    // MIE-22B: the question becomes a section of the report immediately, and the
    // input clears as the text moves into the document.
    var ref = appendQuestionEntry(question);
    input.value = '';
    autoGrow();

    fetch('/hugo/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ date: (knowledge && knowledge.date) || new Date().toISOString().slice(0, 10), question: question, history: history }),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        if (!result.ok) {
          var msg = result.body && result.body.error ? result.body.error : 'No se pudo obtener respuesta.';
          fillAnswerError(ref, msg);
          return;
        }
        fillAnswer(ref, result.body);
        // MIE-17C: Hugo finished responding — real conversation activity.
        resetAvatarIdleTimer('hugo_response');
        history.push({ question: question, answer: result.body.answer || '' });
        if (history.length > 3) history = history.slice(-3);
        // MIE-17B: after the existing Ask flow fully succeeds, forward ONLY the
        // original user text to the ElevenLabs Agent. Never blocks Hugo Ask.
        sendUserMessageToAgent(question);
      })
      .catch(function () {
        fillAnswerError(ref, 'Error de conexión.');
      })
      .then(function () {
        setAsking(false);
      });
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  // ---------- Initial load ----------
  function showOverlay(message) {
    overlay.textContent = message;
    overlay.classList.remove('hidden');
  }

  function load() {
    fetch('/hugo/knowledge', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 404) {
          showOverlay('No hay briefing disponible para hoy.');
          return null;
        }
        if (!res.ok) {
          showOverlay('Error cargando el briefing.');
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        knowledge = data;
        renderHeader();
        renderBrief();
        renderMarket();
        renderQuestions();
        renderExecution();
        // MIE-22B: prepare the (still hidden) chapter sequence. Nothing is shown
        // until the user starts the briefing — the workspace stays clean.
        buildBriefingChapters();
      })
      .catch(function () {
        showOverlay('Error cargando el briefing.');
      });
  }

  // ---------- LiveAvatar (LITE Mode via LiveKit) ----------
  // The avatar is fully independent: it never blocks the Brief, Questions,
  // Workspace, or Ask Hugo. On any failure it falls back to the static iframe.
  var avatarFallbackTimerId;
  var avatarVideoLive = false;

  // MIE-18B: single source of truth for the avatar session lifecycle.
  // Guarantees exactly one session/room and one in-flight connection attempt.
  // Allowed states: idle | connecting | connected | failed | disconnected
  var avatarLifecycle = {
    state: 'idle',
    room: null,
    connectPromise: null,
    sessionId: null,
    // MIE-20B: LITE session control WebSocket URL ("ws_url" from /sessions/start).
    // Per the official schema this is "Custom Mode only"; in the ElevenLabs
    // Connector path it is normally absent (LiveAvatar's bridge owns that WS).
    wsUrl: null,
    // MIE-21: LITE sessions expire by design after max_session_duration seconds
    // (connector mode → 300). We renew the session shortly before that.
    maxSessionDuration: 300,
    renewing: false,
  };
  // Distinguishes an intentional teardown from an unexpected SDK disconnect.
  var avatarDisposing = false;

  // MIE-20: HTTP keep-alive loop state. Single interval; stops on dispose/disconnect.
  var avatarKeepAliveTimerId = null;
  var avatarKeepAliveFailures = 0;
  var AVATAR_KEEPALIVE_MS = 45000;
  var AVATAR_KEEPALIVE_MAX_FAILURES = 3;

  // MIE-20B: native LITE keep-alive over the documented session control
  // WebSocket. Official protocol (LITE Events): send the command event
  //   { "type": "session.keep_alive", "event_id": "<unique>" }
  // The docs give no numeric cadence ("send periodically"); spec default 30s.
  var avatarNativeKaSocket = null;
  var avatarNativeKaTimerId = null;
  var avatarNativeKaStarted = false;
  var AVATAR_NATIVE_KA_MS = 30000;

  // MIE-21: graceful renewal. Exactly one renewal timer; fires shortly before the
  // session's documented hard expiry, disposes the room and reconnects a fresh one.
  var avatarRenewalTimerId = null;
  var DEFAULT_MAX_SESSION_DURATION = 300;
  var RENEWAL_LEAD_SECONDS = 30;

  // MIE-17B: on-demand lifecycle flags.
  // - avatarConversationActive: true only between an explicit CTA start and a
  //   stop. Gates ALL background activity (keep-alive, renewal). When false there
  //   must be NO session, NO timers, NO network activity → ZERO credits.
  // - avatarStopExecuted: idempotency latch so pagehide + beforeunload +
  //   visibilitychange together fire the stop flow at most once per session.
  var avatarConversationActive = false;
  var avatarStopExecuted = false;

  // MIE-17C: idle timeout. After 45s without REAL conversation activity the
  // session is stopped (credits → 0) and the CTA returns. State is page-session
  // scoped: hasDeliveredInitialBrief only resets on a full page reload, so a
  // reconnect after idle never replays the Executive Brief / greeting.
  var hasDeliveredInitialBrief = false;
  var lastAvatarStopReason = '';
  var avatarIdleTimeoutId = null;
  var lastAvatarActivityAt = 0;
  var lastAvatarIdleArmAt = 0;
  var lastAvatarIdleLogAt = 0;
  var avatarIdleScheduledForAt = 0;
  var AVATAR_IDLE_MS = 45 * 1000;
  var AVATAR_IDLE_ARM_THROTTLE_MS = 1500;
  var AVATAR_IDLE_LOG_THROTTLE_MS = 2000;

  // MIE-27B: voice entry v1 — single local microphone track (no republish/renewal).
  var microphoneActive = false;
  var microphoneActivating = false;
  var hugoLocalMicrophoneTrack = null;
  var hugoLocalMicrophoneStream = null;
  var LOCAL_PARTICIPANT_TIMEOUT_MS = 10000;

  function voicePipelineLog(msg, extra) {
    voiceLog(msg, extra);
  }

  function stopMediaStream(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    try {
      stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (e) { /* noop */ }
      });
    } catch (err) {
      // never throw
    }
  }

  function resetMicrophoneResources() {
    var hadMic = microphoneActive || !!hugoLocalMicrophoneTrack;
    try {
      var room = window.__hugoLiveKitRoom;
      var lp = room && room.localParticipant;
      if (lp && hugoLocalMicrophoneTrack && typeof lp.unpublishTrack === 'function') {
        try {
          var unpublishResult = lp.unpublishTrack(hugoLocalMicrophoneTrack);
          if (unpublishResult && typeof unpublishResult.catch === 'function') {
            unpublishResult.catch(function () { /* noop */ });
          }
        } catch (unpubErr) {
          // never throw
        }
      }
    } catch (err) {
      // never throw
    }
    try {
      if (hugoLocalMicrophoneTrack && typeof hugoLocalMicrophoneTrack.stop === 'function') {
        hugoLocalMicrophoneTrack.stop();
      }
    } catch (err) {
      // never throw
    }
    hugoLocalMicrophoneTrack = null;
    stopMediaStream(hugoLocalMicrophoneStream);
    hugoLocalMicrophoneStream = null;
    microphoneActive = false;
    microphoneActivating = false;
    if (hadMic) voicePipelineLog('microphone stopped');
  }

  function setTalkVoiceButtonState(state, errorMsg) {
    try {
      var btn = document.getElementById('talk-voice-btn');
      var status = document.getElementById('talk-voice-status');
      if (!btn) return;

      if (state === 'hidden') {
        btn.classList.add('hidden');
        if (status) {
          status.classList.add('hidden');
          status.textContent = '';
        }
        return;
      }

      btn.classList.remove('hidden');
      if (status) status.classList.remove('hidden');

      if (state === 'ready') {
        btn.disabled = false;
        btn.textContent = 'Hablar con Hugo';
      } else if (state === 'activating') {
        btn.disabled = true;
        btn.textContent = 'Activando micrófono...';
      } else if (state === 'active') {
        btn.disabled = false;
        btn.textContent = 'Terminar conversación';
      }

      if (status) status.textContent = errorMsg || '';
    } catch (err) {
      // never throw
    }
  }

  function syncTalkVoiceButtonVisibility() {
    var show = avatarConversationActive
      && (hugoConversationState === 'idle'
        || hugoConversationState === 'thinking'
        || hugoConversationState === 'speaking');
    if (!show) {
      setTalkVoiceButtonState('hidden');
      return;
    }
    if (microphoneActive) setTalkVoiceButtonState('active');
    else if (microphoneActivating) setTalkVoiceButtonState('activating');
    else setTalkVoiceButtonState('ready');
  }

  function waitForLocalParticipant(room, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var startedAt = Date.now();
      function check() {
        var lp = room && room.localParticipant;
        if (lp) {
          resolve(lp);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('localParticipant timeout'));
          return;
        }
        setTimeout(check, 100);
      }
      check();
    });
  }

  function createLocalMicrophoneTrackFromStream(stream) {
    var mediaTrack = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
    if (!mediaTrack) return Promise.reject(new Error('no_audio_track'));

    var LiveKit = window.LivekitClient || window.LiveKitClient;
    if (!LiveKit) return Promise.reject(new Error('livekit_sdk_unavailable'));

    if (LiveKit.LocalAudioTrack) {
      try {
        return Promise.resolve(new LiveKit.LocalAudioTrack(mediaTrack, undefined, true));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    if (typeof LiveKit.createLocalAudioTrack === 'function') {
      var settings = typeof mediaTrack.getSettings === 'function'
        ? mediaTrack.getSettings() : {};
      var deviceId = settings && settings.deviceId;
      stopMediaStream(stream);
      hugoLocalMicrophoneStream = null;
      if (deviceId) return LiveKit.createLocalAudioTrack({ deviceId: deviceId });
      return LiveKit.createLocalAudioTrack();
    }
    return Promise.reject(new Error('LocalAudioTrack creation failed'));
  }

  function onTalkVoiceButtonClick() {
    if (microphoneActive) {
      voicePipelineLog('conversation terminated by user');
      executeAvatarStopFlow('user_toggle');
      return;
    }
    activateMicrophonePipeline();
  }

  function dispatchExecutiveBriefOnce() {
    if (hasDeliveredInitialBrief) {
      voicePipelineLog('brief replay prevented');
      return false;
    }
    hasDeliveredInitialBrief = true;
    var briefingText = 'Comenzá el briefing competitivo de hoy para Nicolás.\n'
      + 'Sé breve, preciso y hablá como Hugo.';
    sendUserMessageToAgent(briefingText);
    return true;
  }

  function activateMicrophonePipeline() {
    voicePipelineLog('microphone activation requested');

    if (microphoneActive) {
      voicePipelineLog('microphone already active');
      return;
    }
    if (microphoneActivating) return;

    if (!isRoomConnected()) {
      voicePipelineLog('session unavailable', { reason: 'room not connected' });
      setTalkVoiceButtonState('ready', 'No hay sesión activa con Hugo.');
      return;
    }

    if (hugoLocalMicrophoneTrack) {
      voicePipelineLog('microphone track already exists');
      return;
    }

    var gUM = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    if (typeof gUM !== 'function') {
      voicePipelineLog('getUserMedia failed', { reason: 'API unavailable' });
      setTalkVoiceButtonState('ready', 'El navegador no admite micrófono.');
      return;
    }

    microphoneActivating = true;
    setTalkVoiceButtonState('activating');
    voicePipelineLog('requesting browser microphone');

    var room = window.__hugoLiveKitRoom;
    var capturedStream = null;

    gUM.call(navigator.mediaDevices, { audio: true })
      .then(function (stream) {
        capturedStream = stream;
        hugoLocalMicrophoneStream = stream;
        voicePipelineLog('microphone permission granted');
        return createLocalMicrophoneTrackFromStream(stream);
      })
      .then(function (localTrack) {
        if (!localTrack) throw new Error('LocalAudioTrack creation failed');
        hugoLocalMicrophoneTrack = localTrack;
        voicePipelineLog('LocalAudioTrack created');
        voicePipelineLog('waiting for localParticipant');
        return waitForLocalParticipant(room, LOCAL_PARTICIPANT_TIMEOUT_MS)
          .then(function (lp) {
            voicePipelineLog('localParticipant available');
            voicePipelineLog('publishing microphone');
            var LiveKit = window.LivekitClient || window.LiveKitClient;
            var publishOptions = {};
            if (LiveKit && LiveKit.Track && LiveKit.Track.Source
              && LiveKit.Track.Source.Microphone !== undefined) {
              publishOptions.source = LiveKit.Track.Source.Microphone;
            }
            return lp.publishTrack(localTrack, publishOptions);
          });
      })
      .then(function () {
        var micPub = findLocalMicrophonePublication(room);
        if (!micPub) throw new Error('publish failed');
        voicePipelineLog('microphone published', {
          trackSid: micPub.trackSid || null,
        });
        microphoneActive = true;
        microphoneActivating = false;
        setTalkVoiceButtonState('active');
        voicePipelineLog('microphone active');
      })
      .catch(function (err) {
        microphoneActivating = false;
        var msg = err && err.message ? err.message : String(err);
        var errName = err && err.name ? err.name : '';

        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
          voicePipelineLog('permission denied', { message: msg });
          setTalkVoiceButtonState('ready', 'Permiso de micrófono denegado.');
        } else if (msg.indexOf('localParticipant timeout') !== -1) {
          voicePipelineLog('localParticipant timeout');
          setTalkVoiceButtonState('ready', 'No se pudo conectar el micrófono a la sesión.');
        } else if (msg.indexOf('LocalAudioTrack') !== -1 || msg === 'no_audio_track') {
          voicePipelineLog('LocalAudioTrack creation failed', { message: msg });
          setTalkVoiceButtonState('ready', 'No se pudo inicializar el micrófono.');
        } else if (msg.indexOf('publish failed') !== -1) {
          voicePipelineLog('publish failed', { message: msg });
          setTalkVoiceButtonState('ready', 'No se pudo publicar el micrófono.');
        } else {
          voicePipelineLog('publish failed', { message: msg });
          setTalkVoiceButtonState('ready', 'No se pudo activar el micrófono.');
        }
        resetMicrophoneResources();
        if (capturedStream) stopMediaStream(capturedStream);
      });
  }

  function showAvatarLoading() {
    var status = document.getElementById('avatar-status');
    var video = document.getElementById('avatar-video');
    var fallback = document.getElementById('avatar-fallback');
    if (status) status.textContent = 'Conectando...';
    if (video) video.style.display = 'none';
    if (fallback) fallback.style.display = 'none';
  }

  function showAvatarLive() {
    var status = document.getElementById('avatar-status');
    var video = document.getElementById('avatar-video');
    var fallback = document.getElementById('avatar-fallback');
    if (status) status.textContent = '';
    if (video) video.style.display = 'block';
    if (fallback) fallback.style.display = 'none';
  }

  function showAvatarFallback() {
    var status = document.getElementById('avatar-status');
    var video = document.getElementById('avatar-video');
    var fallback = document.getElementById('avatar-fallback');
    if (status) status.textContent = '';
    if (video) video.style.display = 'none';
    if (fallback) fallback.style.display = 'block';
  }

  // TEMP DEBUG (MIE-17A-AUDIT): all logs prefixed with [Hugo Avatar].
  function avatarLog() {
    var args = ['[Hugo Avatar]'].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }

  function audioElState(audioEl) {
    if (!audioEl) return { exists: false };
    var srcObject = audioEl.srcObject || null;
    var audioTracks = null;
    if (srcObject && typeof srcObject.getAudioTracks === 'function') {
      audioTracks = srcObject.getAudioTracks().length;
    }
    return {
      exists: true,
      muted: audioEl.muted,
      volume: audioEl.volume,
      paused: audioEl.paused,
      hasSrcObject: !!srcObject,
      audioTracks: audioTracks,
    };
  }

  function videoElState(videoEl) {
    if (!videoEl) return { exists: false };
    return {
      exists: true,
      paused: videoEl.paused,
      readyState: videoEl.readyState,
      hasSrcObject: !!videoEl.srcObject,
      display: videoEl.style.display,
    };
  }

  // ===== MIE-19C (AUDIT ONLY) — LiveKit lifecycle instrumentation =====
  // Logging-only. Never changes application behavior. Prefix: [Hugo LiveKit].
  var auditSnapshotTimerId = null;
  var auditReconnectingAtMs = 0;

  function lkParticipantCount(room) {
    var r = room || window.__hugoLiveKitRoom;
    if (!r) return null;
    var p = r.remoteParticipants || r.participants;
    if (p && typeof p.size === 'number') return p.size;
    if (p && typeof p.length === 'number') return p.length;
    return null;
  }

  function lkLog(event, extra) {
    try {
      var room = window.__hugoLiveKitRoom;
      var entry = {
        event: event,
        ts: Date.now(),
        roomState: room ? room.state : null,
        participantCount: lkParticipantCount(room),
        lifecycleState: avatarLifecycle ? avatarLifecycle.state : null,
      };
      if (extra) {
        Object.keys(extra).forEach(function (k) { entry[k] = extra[k]; });
      }
      console.log('[Hugo LiveKit]', entry);
    } catch (err) {
      // audit logging must never throw
    }
  }

  function stopAuditSnapshots() {
    try {
      if (auditSnapshotTimerId) {
        clearInterval(auditSnapshotTimerId);
        auditSnapshotTimerId = null;
      }
    } catch (err) {
      // never throw
    }
  }

  // Periodic debug snapshot every 30s while connected. Single timer, self-stops.
  function startAuditSnapshots() {
    try {
      if (auditSnapshotTimerId) return; // never duplicate timers
      auditSnapshotTimerId = setInterval(function () {
        try {
          if (!isRoomConnected()) {
            stopAuditSnapshots();
            return;
          }
          lkLog('periodic snapshot', {
            audioElement: audioElState(document.getElementById('avatar-audio')),
            videoElement: videoElState(document.getElementById('avatar-video')),
          });
        } catch (err) {
          // never throw
        }
      }, 30000);
    } catch (err) {
      // never throw
    }
  }

  // Attach log-only listeners for every available RoomEvent. These are ADDITIVE
  // and separate from the behavior listeners; they never mutate state or flow.
  function instrumentRoomAudit(room, LiveKit) {
    try {
      if (!room || !LiveKit || !LiveKit.RoomEvent) return;
      var E = LiveKit.RoomEvent;

      if (E.Connected) {
        room.on(E.Connected, function () {
          lkLog('RoomEvent.Connected', { roomSid: room.sid || null });
          startAuditSnapshots();
        });
      }
      if (E.Reconnecting) {
        room.on(E.Reconnecting, function () {
          auditReconnectingAtMs = Date.now();
          lkLog('RoomEvent.Reconnecting');
        });
      }
      if (E.Reconnected) {
        room.on(E.Reconnected, function () {
          lkLog('RoomEvent.Reconnected', {
            elapsedMs: auditReconnectingAtMs ? (Date.now() - auditReconnectingAtMs) : null,
          });
          auditReconnectingAtMs = 0;
        });
      }
      if (E.Disconnected) {
        room.on(E.Disconnected, function (reason) {
          roomLog('disconnected reason=' + (reason == null ? 'unknown' : String(reason)), {
            intentional: !!avatarDisposing,
          });
          lkLog('RoomEvent.Disconnected', {
            reason: reason == null ? null : String(reason),
            intentional: !!avatarDisposing,
          });
          stopAuditSnapshots();
        });
      }
      if (E.ConnectionQualityChanged) {
        room.on(E.ConnectionQualityChanged, function (quality, participant) {
          lkLog('RoomEvent.ConnectionQualityChanged', {
            quality: quality == null ? null : String(quality),
            participantIdentity: participant && participant.identity,
          });
        });
      }
      if (E.TrackSubscribed) {
        room.on(E.TrackSubscribed, function (track, publication, participant) {
          lkLog('RoomEvent.TrackSubscribed', {
            trackKind: track && track.kind,
            trackSid: track && track.sid,
            publicationSource: publication && publication.source,
            participantIdentity: participant && participant.identity,
          });
        });
      }
      if (E.TrackUnsubscribed) {
        room.on(E.TrackUnsubscribed, function (track, publication, participant) {
          lkLog('RoomEvent.TrackUnsubscribed', {
            trackKind: track && track.kind,
            trackSid: track && track.sid,
            participantIdentity: participant && participant.identity,
          });
        });
      }
      if (E.DataReceived) {
        room.on(E.DataReceived, function (payload, participant, kind, topic) {
          var bytes = null;
          try {
            bytes = (payload && payload.byteLength != null)
              ? payload.byteLength
              : (payload && payload.length != null ? payload.length : null);
          } catch (sizeErr) {
            bytes = null;
          }
          // Never log the message text/content — size + topic only.
          lkLog('RoomEvent.DataReceived', {
            bytes: bytes,
            topic: topic == null ? null : String(topic),
            participantIdentity: participant && participant.identity,
          });
        });
      }
      if (E.ParticipantConnected) {
        room.on(E.ParticipantConnected, function (participant) {
          lkLog('RoomEvent.ParticipantConnected', {
            participantIdentity: participant && participant.identity,
          });
        });
      }
      if (E.ParticipantDisconnected) {
        room.on(E.ParticipantDisconnected, function (participant) {
          lkLog('RoomEvent.ParticipantDisconnected', {
            participantIdentity: participant && participant.identity,
          });
        });
      }
    } catch (err) {
      // never throw
    }
  }

  // MIE-17B: forward the user's text to the ElevenLabs Agent over the LiveKit
  // data channel so the avatar can respond by voice. This is independent of and
  // never interferes with the existing /hugo/ask flow. Only the user's text is
  // sent — never Hugo's answer, Daily Knowledge, or the Executive Brief.
  function sendUserMessageToAgent(text) {
    var message = String(text == null ? '' : text).trim();
    if (!message) return;

    var room = window.__hugoLiveKitRoom;
    var connected = room && (room.state === 'connected' || (window.LivekitClient
      && window.LivekitClient.ConnectionState
      && room.state === window.LivekitClient.ConnectionState.Connected));

    if (!room || !connected || !room.localParticipant) {
      console.warn('[Hugo Avatar] room unavailable');
      return;
    }

    try {
      avatarLog('preparing user_message');
      var payload = {
        event_type: 'elevenlabs_agent_command',
        elevenlabs_event_type: 'user_message',
        data: { text: message },
      };
      var bytes = new TextEncoder().encode(JSON.stringify(payload));

      // MIE-19C (AUDIT): data-channel publish telemetry (size only, no text).
      lkLog('data publish started', { payloadSize: bytes.length });

      var result = room.localParticipant.publishData(bytes, {
        reliable: true,
        topic: 'agent-control',
      });
      avatarLog('payload published');
      // MIE-17C: a successful agent interaction is real conversation activity.
      resetAvatarIdleTimer('agent_message');

      if (result && typeof result.then === 'function') {
        result
          .then(function () {
            avatarLog('publishData resolved');
            lkLog('data publish resolved', { payloadSize: bytes.length });
          })
          .catch(function (err) {
            avatarLog('publishData rejected', err);
            lkLog('data publish rejected', { payloadSize: bytes.length });
          });
      } else {
        lkLog('data publish resolved', { payloadSize: bytes.length });
      }
    } catch (err) {
      avatarLog('publishData rejected', err);
      lkLog('data publish rejected');
    }
  }

  // MIE-18A: lightweight, explicit conversation state machine. No framework.
  function setHugoConversationState(state) {
    try {
      hugoConversationState = state;
      avatarLog('state ->', state);

      var btn = document.getElementById('voice-btn');
      var status = document.getElementById('voice-status');

      if (btn) {
        if (state === 'connecting' || state === 'ready'
          || state === 'fallback' || state === 'error') {
          btn.disabled = false;
          btn.innerHTML = '&#9654; Iniciar conversación con Hugo';
        } else if (state === 'briefing') {
          btn.disabled = true;
          btn.textContent = 'Hugo está preparando el briefing...';
        } else if (state === 'idle') {
          btn.disabled = true;
          btn.textContent = 'Conversación iniciada';
        } else if (state === 'thinking' || state === 'speaking') {
          btn.disabled = true;
        }
      }

      if (status) {
        if (state === 'connecting') status.textContent = 'Conectando con Hugo...';
        else if (state === 'error') status.textContent = 'No se pudo iniciar la conversación.';
        else status.textContent = '';
      }
      if (isAbstractMode) {
        document.body.setAttribute('data-hugo-conversation', state);
      }
      syncAbstractPresence();
      syncTalkVoiceButtonVisibility();
    } catch (err) {
      // State updates must never break the page.
    }
  }

  // MIE-18B: lifecycle state transition + logging (never throws).
  function setLifecycleState(state) {
    try {
      avatarLifecycle.state = state;
      avatarLog('lifecycle ' + state);
    } catch (err) {
      // never throw
    }
  }

  // MIE-18B: connected-state check supporting both the enum and the string.
  function isRoomConnected(room) {
    var r = room || avatarLifecycle.room || window.__hugoLiveKitRoom;
    if (!r) return false;
    if (window.LivekitClient && window.LivekitClient.ConnectionState) {
      return r.state === window.LivekitClient.ConnectionState.Connected;
    }
    return r.state === 'connected';
  }

  // MIE-18B: safely tear down and forget the current room. Never throws.
  // Nulls references BEFORE disconnecting and guards the Disconnected handler
  // via avatarDisposing so intentional teardown is not treated as a failure.
  function disposeAvatarRoom() {
    try {
      // MIE-20: stop keep-alive whenever the room is torn down.
      stopAvatarKeepAlive();
      // MIE-20B: stop the native LITE control-socket keep-alive too.
      stopNativeKeepAlive();
      // MIE-21: never leave a renewal timer pointing at a disposed room.
      clearRenewalTimer();
      var room = avatarLifecycle.room || window.__hugoLiveKitRoom;
      avatarLifecycle.room = null;
      window.__hugoLiveKitRoom = null;
      avatarVideoLive = false;
      clearTimeout(avatarFallbackTimerId);

      if (room && typeof room.disconnect === 'function') {
        avatarDisposing = true;
        try {
          room.disconnect();
        } catch (err) {
          // never throw
        }
        avatarDisposing = false;
        avatarLog('room disposed');
      }
    } catch (err) {
      avatarDisposing = false;
      // never throw
    }
  }

  // MIE-20: stop the keep-alive loop (idempotent, never throws).
  function stopAvatarKeepAlive() {
    try {
      if (avatarKeepAliveTimerId) {
        clearInterval(avatarKeepAliveTimerId);
        avatarKeepAliveTimerId = null;
      }
    } catch (err) {
      // never throw
    }
  }

  // MIE-20: send one keep-alive tick to our backend proxy (never throws).
  function sendAvatarKeepAlive() {
    var sid = avatarLifecycle.sessionId;
    if (!sid) {
      stopAvatarKeepAlive();
      return;
    }
    avatarLog('keep-alive sent');
    fetch('/hugo/avatar/keepalive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('keepalive_failed');
        avatarKeepAliveFailures = 0;
        avatarLog('keep-alive ok');
      })
      .catch(function (err) {
        avatarKeepAliveFailures += 1;
        avatarLog('keep-alive failed', { consecutive: avatarKeepAliveFailures });
        if (avatarKeepAliveFailures >= AVATAR_KEEPALIVE_MAX_FAILURES) {
          console.warn('[Hugo Avatar] keep-alive stopped after '
            + AVATAR_KEEPALIVE_MAX_FAILURES + ' consecutive failures');
          stopAvatarKeepAlive();
        }
      });
  }

  // MIE-20: start the single keep-alive interval after a connected session.
  function startAvatarKeepAlive() {
    try {
      if (avatarKeepAliveTimerId) {
        avatarLog('keep-alive already running');
        return;
      }
      if (!avatarLifecycle.sessionId) return;
      avatarKeepAliveFailures = 0;
      avatarKeepAliveTimerId = setInterval(function () {
        try {
          sendAvatarKeepAlive();
        } catch (err) {
          // never throw
        }
      }, AVATAR_KEEPALIVE_MS);
      avatarLog('keep-alive started');
    } catch (err) {
      // never throw
    }
  }

  // MIE-20B: unique event_id per transmission (never reused).
  function avatarEventId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (err) {
      // fall through to fallback
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // MIE-20B: stop the native LITE keep-alive (timer + control socket). Never throws.
  function stopNativeKeepAlive() {
    try {
      if (avatarNativeKaTimerId) {
        clearInterval(avatarNativeKaTimerId);
        avatarNativeKaTimerId = null;
      }
      if (avatarNativeKaSocket) {
        try {
          avatarNativeKaSocket.onopen = null;
          avatarNativeKaSocket.onmessage = null;
          avatarNativeKaSocket.onerror = null;
          avatarNativeKaSocket.onclose = null;
          avatarNativeKaSocket.close();
        } catch (err) {
          // never throw
        }
        avatarNativeKaSocket = null;
      }
      if (avatarNativeKaStarted) {
        avatarNativeKaStarted = false;
        avatarLog('native keep-alive stopped');
      }
    } catch (err) {
      // never throw
    }
  }

  // MIE-20B: send one documented session.keep_alive command event (never throws).
  function sendNativeKeepAlive() {
    try {
      var socket = avatarNativeKaSocket;
      if (!socket || socket.readyState !== 1 /* OPEN */) {
        return;
      }
      // Exact documented payload — no extra fields. Fresh event_id each send.
      var payload = { type: 'session.keep_alive', event_id: avatarEventId() };
      socket.send(JSON.stringify(payload));
      avatarLog('native keep-alive sent');
    } catch (err) {
      avatarLog('native keep-alive failed');
    }
  }

  // MIE-20B: begin the single 30s native keep-alive loop once the control socket
  // is ready. Called from beginNativeKeepAlive after onopen / connected state.
  function runNativeKeepAlive() {
    if (avatarNativeKaTimerId) return; // exactly one timer
    avatarNativeKaStarted = true;
    avatarLog('native keep-alive started');
    sendNativeKeepAlive();
    avatarNativeKaTimerId = setInterval(function () {
      try {
        sendNativeKeepAlive();
      } catch (err) {
        // never throw
      }
    }, AVATAR_NATIVE_KA_MS);
  }

  // MIE-20B: open the documented LITE control WebSocket (ws_url) and start the
  // native keep-alive. Guarded: only when ws_url is present (Custom Mode). In the
  // ElevenLabs Connector path ws_url is absent and LiveAvatar's bridge owns
  // keep-alive — we log and no-op, leaving the HTTP keep-alive untouched.
  function startNativeKeepAlive() {
    try {
      if (avatarNativeKaSocket || avatarNativeKaTimerId) {
        avatarLog('native keep-alive already running');
        return;
      }
      var wsUrl = avatarLifecycle.wsUrl;
      if (!wsUrl || typeof WebSocket === 'undefined') {
        avatarLog('native keep-alive unavailable (no ws_url; connector-managed)');
        return;
      }

      var socket = new WebSocket(wsUrl);
      avatarNativeKaSocket = socket;

      // Defensive: if no session.state_updated(connected) arrives shortly after
      // open, begin anyway (keep_alive is benign). Primary path is the documented
      // "wait for connected" signal below.
      var graceTimerId = null;

      socket.onopen = function () {
        avatarLog('native keep-alive socket open');
        graceTimerId = setTimeout(function () {
          if (avatarNativeKaSocket === socket) runNativeKeepAlive();
        }, 2500);
      };

      socket.onmessage = function (evt) {
        try {
          var msg = JSON.parse(evt.data);
          if (msg && msg.type === 'session.state_updated') {
            // Documented server event. Wait for "connected" before commands.
            if (msg.state === 'connected') {
              if (graceTimerId) { clearTimeout(graceTimerId); graceTimerId = null; }
              if (avatarNativeKaSocket === socket) runNativeKeepAlive();
            } else if (msg.state === 'closed' || msg.state === 'closing') {
              stopNativeKeepAlive();
            }
          }
        } catch (err) {
          // ignore non-JSON / unrelated frames
        }
      };

      socket.onerror = function () {
        avatarLog('native keep-alive failed');
      };

      socket.onclose = function () {
        if (graceTimerId) { clearTimeout(graceTimerId); graceTimerId = null; }
        // Only tear down our own loop if this is still the active socket.
        if (avatarNativeKaSocket === socket) {
          stopNativeKeepAlive();
        }
      };
    } catch (err) {
      avatarLog('native keep-alive failed');
      // never throw; leave HTTP keep-alive as the safety net.
    }
  }

  // MIE-21: update ONLY the existing CTA status element (#voice-status).
  function setRenewalStatus(text) {
    try {
      var status = document.getElementById('voice-status');
      if (status) status.textContent = text || '';
    } catch (err) {
      // never throw
    }
  }

  // MIE-21: clear the single renewal timer (idempotent, never throws).
  function clearRenewalTimer() {
    try {
      if (avatarRenewalTimerId) {
        clearTimeout(avatarRenewalTimerId);
        avatarRenewalTimerId = null;
        avatarLog('renewal timer cleared');
      }
    } catch (err) {
      // never throw
    }
  }

  // MIE-21: schedule exactly one renewal, with lead time before hard expiry.
  // 300s → ~270s; sessions <= 60s → 80% of duration. Always replaces any prior.
  function scheduleAvatarRenewal() {
    try {
      clearRenewalTimer();
      var duration = avatarLifecycle.maxSessionDuration;
      if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) {
        duration = DEFAULT_MAX_SESSION_DURATION;
      }
      var delaySec = duration > 60 ? (duration - RENEWAL_LEAD_SECONDS) : (duration * 0.8);
      if (delaySec < 1) delaySec = 1;
      avatarRenewalTimerId = setTimeout(function () {
        renewAvatarSession();
      }, delaySec * 1000);
      avatarLog('renewal scheduled', { inSeconds: Math.round(delaySec) });
      lifecycleLog('renewal scheduled', { inSeconds: Math.round(delaySec) });
    } catch (err) {
      // never throw
    }
  }

  // MIE-21: controlled single-room renewal. Dispose the current room first, then
  // request a brand-new session and reconnect through the existing init path
  // (which restarts keep-alives + schedules the next renewal). Never two rooms
  // at once; never resends the briefing; never auto-retries on failure.
  function renewAvatarSession() {
    try {
      if (avatarLifecycle.renewing) {
        avatarLog('renewal already in progress; ignoring');
        return;
      }
      avatarLog('renewing session');
      voiceLog('renewal started');
      avatarLifecycle.renewing = true;
      setRenewalStatus('Renovando sesión de Hugo...');

      // Stop keep-alives + renewal timer, then dispose via the existing path.
      // cleanupAvatarLifecycle disposes the room and clears room/promise/
      // sessionId/wsUrl; the renewing flag suppresses the native-disconnect path.
      stopAvatarKeepAlive();
      stopNativeKeepAlive();
      clearRenewalTimer();
      cleanupAvatarLifecycle('disconnected');

      // Fresh session + reconnect using the existing connection path. This mints
      // brand-new LiveKit credentials (no reuse) and re-attaches tracks via the
      // existing handleAvatarTrack() inside initAvatar().
      ensureAvatarConnected()
        .then(function () {
          avatarLifecycle.renewing = false;
          // MIE-17B: if the conversation was stopped (tab hidden / unload) while
          // this renewal was reconnecting, do NOT keep the freshly created
          // session alive — tear it down immediately so no orphan session leaks.
          if (!avatarConversationActive) {
            avatarLog('renewal completed after stop; tearing down fresh session');
            var freshSid = avatarLifecycle.sessionId;
            if (freshSid) sendAvatarStop(freshSid);
            stopAvatarKeepAlive();
            stopNativeKeepAlive();
            clearRenewalTimer();
            cleanupAvatarLifecycle('disconnected');
            setRenewalStatus('');
            return;
          }
          setRenewalStatus('');
          avatarLog('renewal connected');
          voiceLog('renewal finished');
          diagnoseMicrophonePipeline('after_renewal');
          // The next renewal is scheduled by initAvatar's connect handler.
        })
        .catch(function () {
          // Existing failure path already disposed the room + showed the
          // fallback iframe. Clear renewal state, permit a manual CTA retry,
          // and NEVER auto-retry / loop.
          avatarLifecycle.renewing = false;
          clearRenewalTimer();
          avatarLog('renewal failed');
          window.__hugoBriefingDispatched = false;
          setRenewalStatus('');
          setHugoConversationState('fallback');
        });
    } catch (err) {
      avatarLifecycle.renewing = false;
      clearRenewalTimer();
      avatarLog('renewal failed');
    }
  }

  // MIE-17B: tell the backend to stop the LiveAvatar session. Prefers
  // navigator.sendBeacon (survives page unload) with a urlencoded body; falls
  // back to a keepalive fetch. Never throws. Never blocks the browser.
  function sendAvatarStop(sessionId) {
    try {
      if (!sessionId) return;
      var url = '/hugo/avatar/stop';

      if (navigator && typeof navigator.sendBeacon === 'function') {
        try {
          // URLSearchParams → application/x-www-form-urlencoded (beacon-safe).
          var params = new URLSearchParams();
          params.set('session_id', sessionId);
          var queued = navigator.sendBeacon(url, params);
          avatarLog('stop sent via beacon', { queued: !!queued });
          if (queued) return;
        } catch (beaconErr) {
          // fall through to fetch
        }
      }

      // Fallback: keepalive fetch is best-effort during unload.
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
        keepalive: true,
      })
        .then(function () { avatarLog('stop sent via fetch'); })
        .catch(function (err) { console.warn('[Hugo Avatar] stop request failed', err); });
    } catch (err) {
      console.warn('[Hugo Avatar] stop request error');
    }
  }

  // MIE-17C: clear the single idle timer (idempotent, never throws).
  function clearAvatarIdleTimer() {
    try {
      if (avatarIdleTimeoutId) {
        clearTimeout(avatarIdleTimeoutId);
        avatarIdleTimeoutId = null;
      }
      avatarIdleScheduledForAt = 0;
    } catch (err) {
      // never throw
    }
  }

  function armAvatarIdleTimer() {
    var now = Date.now();
    lastAvatarIdleArmAt = now;
    avatarIdleScheduledForAt = lastAvatarActivityAt + AVATAR_IDLE_MS;
    var delay = Math.max(1, avatarIdleScheduledForAt - now);

    if (avatarIdleTimeoutId) {
      clearTimeout(avatarIdleTimeoutId);
      avatarIdleTimeoutId = null;
    }

    avatarIdleTimeoutId = setTimeout(onAvatarIdleCheck, delay);
  }

  function onAvatarIdleCheck() {
    avatarIdleTimeoutId = null;
    avatarIdleScheduledForAt = 0;
    if (!avatarConversationActive) return;

    var silentForMs = Date.now() - lastAvatarActivityAt;
    if (silentForMs < AVATAR_IDLE_MS) {
      var remaining = AVATAR_IDLE_MS - silentForMs;
      avatarIdleScheduledForAt = lastAvatarActivityAt + AVATAR_IDLE_MS;
      avatarIdleTimeoutId = setTimeout(onAvatarIdleCheck, Math.max(1, remaining));
      return;
    }

    idleLog('fired', { silentForMs: silentForMs });
    avatarLog('idle timeout reached (45s of conversation inactivity)');
    executeAvatarStopFlow('idle_timeout');
  }

  function shouldRearmAvatarIdleTimer(now) {
    if (!avatarIdleTimeoutId) return true;
    if (now - lastAvatarIdleArmAt >= AVATAR_IDLE_ARM_THROTTLE_MS) return true;
    var newFireAt = lastAvatarActivityAt + AVATAR_IDLE_MS;
    if (newFireAt > avatarIdleScheduledForAt + 500) return true;
    return false;
  }

  // MIE-17C: record conversation activity and (throttled) re-arm the idle timer.
  // lastAvatarActivityAt is ALWAYS updated; arm + logs are throttled separately.
  function resetAvatarIdleTimer(reason) {
    try {
      if (!avatarConversationActive) return;

      var now = Date.now();
      lastAvatarActivityAt = now;

      if (!shouldRearmAvatarIdleTimer(now)) return;

      if (now - lastAvatarIdleLogAt >= AVATAR_IDLE_LOG_THROTTLE_MS) {
        lastAvatarIdleLogAt = now;
        idleLog('reset reason=' + (reason || 'unknown'));
      }

      armAvatarIdleTimer();
    } catch (err) {
      // never throw
    }
  }

  // MIE-17B: the ONE centralized stop path. Idempotent (runs at most once per
  // session via avatarStopExecuted), tears down EVERYTHING, and is safe to call
  // from pagehide / beforeunload or a normal end-of-conversation.
  function executeAvatarStopFlow(reason) {
    try {
      if (avatarStopExecuted) {
        avatarLog('stop flow ignored (already executed)');
        return;
      }
      // Nothing to stop: no session, no room, not active → ZERO work / requests.
      if (!avatarConversationActive && !avatarLifecycle.sessionId && !avatarLifecycle.room) {
        return;
      }
      avatarStopExecuted = true;
      avatarConversationActive = false;
      lastAvatarStopReason = reason || 'manual';
      lifecycleLog('stopped: reason=' + (reason || 'manual'));
      syncAbstractPresence();
      var sessionId = avatarLifecycle.sessionId;
      avatarLog('stop flow', { reason: reason || 'manual', hasSessionId: !!sessionId });

      // 1) Ask the backend to stop the LiveAvatar session (stops credit usage).
      if (sessionId) sendAvatarStop(sessionId);

      // 2) Clear EVERY timer/interval/timeout and disconnect the room. Note:
      //    cleanupAvatarLifecycle → disposeAvatarRoom already stops the keep-alive
      //    interval, the native keep-alive timer/socket, the renewal timer and the
      //    fallback timeout, and calls room.disconnect(); we also call them here
      //    explicitly so no timer can possibly survive a stop.
      stopAvatarKeepAlive();
      stopNativeKeepAlive();
      clearRenewalTimer();
      // MIE-17C: the idle timer must never survive a stop.
      clearAvatarIdleTimer();

      // MIE-27D: unpublish mic while room/localParticipant still exist; stop audit
      // snapshots; clear renewal-in-progress before disconnect.
      resetMicrophoneResources();
      stopAuditSnapshots();
      avatarLifecycle.renewing = false;

      // 3) Disconnect LiveKit + reset all room/session references via the existing
      //    cleanup path. avatarStopExecuted guards the native Disconnected handler
      //    so this intentional teardown is not treated as an error.
      cleanupAvatarLifecycle('disconnected');

      // 4) Reset conversation flags so a fresh CTA can start a new session later.
      window.__hugoBriefingDispatched = false;
      // MIE-17C: return the CTA to its initial enabled label ("Iniciar
      // conversación con Hugo"). Note: hasDeliveredInitialBrief is intentionally
      // NOT reset here — it is page-session scoped.
      setHugoConversationState('ready');
      if (isAbstractMode) abstractEndedUntil = Date.now() + 2600;
      syncAbstractPresence();
      avatarLog('stop flow complete');
    } catch (err) {
      // never throw — must not block the browser during unload.
    }
  }

  // MIE-18B: clear stale promise/session and dispose any unhealthy room.
  function cleanupAvatarLifecycle(targetState) {
    try {
      avatarLifecycle.connectPromise = null;
      avatarLifecycle.sessionId = null;
      avatarLifecycle.wsUrl = null;
      disposeAvatarRoom();
      setLifecycleState(targetState || 'failed');
    } catch (err) {
      // never throw
    }
  }

  // MIE-18B: idempotent connection entry point with a synchronous mutex.
  // - reuse an existing healthy connected room (no new session/room/init);
  // - reuse the single in-flight connection attempt;
  // - otherwise start exactly one fresh attempt, marking state/promise
  //   synchronously BEFORE any async work begins.
  function ensureAvatarConnected() {
    // 1) Healthy connected room → reuse, no network/SDK work.
    if (avatarLifecycle.room && isRoomConnected(avatarLifecycle.room)) {
      if (avatarLifecycle.state !== 'connected') setLifecycleState('connected');
      avatarLog('session reused');
      avatarLog('room reused');
      return Promise.resolve(avatarLifecycle.room);
    }

    // 2) An attempt is already in flight → return the same promise.
    if (avatarLifecycle.state === 'connecting' && avatarLifecycle.connectPromise) {
      avatarLog('waiting for connection');
      return avatarLifecycle.connectPromise;
    }

    // 3) Fresh attempt. A retry is only reachable here after failed/disconnected.
    if (avatarLifecycle.state === 'failed' || avatarLifecycle.state === 'disconnected') {
      avatarLog('manual retry started');
    }

    // Synchronous mutex: set state + promise BEFORE any fetch/connect happens.
    // initAvatar() (and its fetch) is deferred to a microtask so connectPromise
    // is assigned before any async work starts.
    setLifecycleState('connecting');
    avatarLifecycle.connectPromise = Promise.resolve()
      .then(function () { return initAvatar(); })
      .then(function (room) {
        // Connected. Keep the room; clear only the in-flight marker.
        avatarLifecycle.connectPromise = null;
        return room;
      })
      .catch(function (err) {
        // Failed attempt: clear stale promise/session, dispose unhealthy room.
        cleanupAvatarLifecycle('failed');
        throw err;
      });
    return avatarLifecycle.connectPromise;
  }

  // MIE-19: the CTA is the ONLY place allowed to start the conversation /
  // dispatch the initial briefing. The avatar may already be connected silently;
  // it never speaks until the user clicks here.
  function startConversation() {
    avatarLog('CTA clicked');

    // 1) Synchronous briefing mutex — MUST run before any async work so that
    //    repeated/fast clicks can never dispatch more than one briefing.
    if (window.__hugoBriefingDispatched) {
      avatarLog('briefing already dispatched; ignoring duplicate click');
      return;
    }
    if (lastAvatarStopReason === 'user_toggle') {
      hasDeliveredInitialBrief = false;
    }
    lastAvatarStopReason = '';
    window.__hugoBriefingDispatched = true;
    avatarLog('briefing dispatch locked');

    // MIE-17B: a brand-new session begins here. Mark the conversation active
    // (enables keep-alive/renewal once connected) and reset the stop latch so a
    // later stop flow can run exactly once for THIS session.
    avatarConversationActive = true;
    avatarStopExecuted = false;
    abstractEndedUntil = 0;
    abstractRemoteSpeaking = false;
    avatarLog('conversation active');
    lifecycleLog((isAbstractMode ? 'abstract ' : '') + 'start');
    syncAbstractPresence();

    // MIE-17C: clicking the CTA is real conversation activity — (re)start the
    // idle timer. This also covers the explicit reconnect-after-idle case.
    resetAvatarIdleTimer('cta');

    // 2) The click is the official audio-unlock gesture (no autoplay hacks).
    window.__hugoAudioUnlocked = true;
    avatarLog('audio unlock attempted');
    var audioEl = document.getElementById('avatar-audio');
    if (audioEl && audioEl.srcObject) {
      audioEl.play().catch(function () {});
    } else {
      avatarLog('audio unlock: no audio track attached yet');
    }

    // 3) Ensure connection, then send exactly ONE briefing once connected.
    setHugoConversationState('connecting');
    ensureAvatarConnected()
      .then(function () {
        avatarLog('avatar connected');
        if (!hasDeliveredInitialBrief) {
          // FIRST RUN (this page session): deliver the initial brief exactly as
          // before, then latch hasDeliveredInitialBrief so it never replays.
          setHugoConversationState('briefing');
          avatarLog('briefing requested');
          if (dispatchExecutiveBriefOnce()) {
            avatarLog('briefing sent');
          } else {
            avatarLog('briefing skipped (already delivered)');
          }
          // MIE-22B: Hugo is now presenting — begin revealing the report chapter
          // by chapter (deterministic v1 trigger; idempotent).
          startBriefingReveal();
          // Speaking-completion sync with LiveKit is a future sprint; transition
          // to the idle conversational state immediately without blocking the UI.
          setHugoConversationState('idle');
          diagnoseMicrophonePipeline('conversation_idle');
        } else {
          // RECONNECT AFTER IDLE: cost-free, visual-only. Never re-send the
          // Executive Brief / greeting, never enter the 'briefing' state, never
          // call the LLM or ElevenLabs, never generate local speech. The input is
          // immediately usable (it never depended on avatar state).
          avatarLog('reconnect after idle; skipping initial brief');
          setHugoConversationState('idle');
          setRenewalStatus('Te escucho.');
          diagnoseMicrophonePipeline('conversation_idle_reconnect');
        }
        // Connection is real conversation activity; (re)arm the idle timer.
        resetAvatarIdleTimer('connected');
      })
      .catch(function (err) {
        avatarLog('briefing failed', err);
        // Release the mutex so the user can retry manually, and ensure no idle
        // timer keeps running for a session that never connected.
        window.__hugoBriefingDispatched = false;
        avatarConversationActive = false;
        clearAvatarIdleTimer();
        // MIE-22B: the user explicitly asked for the briefing. Even if the avatar
        // could not connect, reveal the report so it is never trapped empty.
        // Idempotent, so a later successful retry never double-reveals.
        startBriefingReveal();
        setHugoConversationState('error');
      });
  }

  function handleAvatarTrack(track) {
    if (!track || !track.kind) return;

    avatarLog('handleAvatarTrack called', { kind: track && track.kind });
    avatarLog('detected track.kind:', track.kind);
    // MIE-17C: a remote track being subscribed is real conversation activity
    // (debounced, so video+audio bursts won't recreate the timer repeatedly).
    resetAvatarIdleTimer('track_subscribed');

    if (track.kind === 'video') {
      avatarLog('treating track as VIDEO');
      var videoEl = document.getElementById('avatar-video');
      if (!videoEl) return;
      track.attach(videoEl);
      videoEl.style.display = 'block';
      avatarVideoLive = true;
      showAvatarLive();
      wireAvatarVideoLifecycle(videoEl);
      // First video track is live; the timeout must never fire afterwards.
      clearTimeout(avatarFallbackTimerId);
      avatarLog('fallback timer cancelled (video went live)');
      avatarLog('video attached; element state:', videoElState(videoEl));
      return;
    }

    if (track.kind === 'audio') {
      avatarLog('treating track as AUDIO');
      var audioEl = document.getElementById('avatar-audio');
      if (!audioEl) return;

      track.attach(audioEl);

      // Defensive fallback: some LiveKit builds/browsers don't populate
      // srcObject via attach(). If so, wire the raw MediaStreamTrack directly.
      if (!audioEl.srcObject && track.mediaStreamTrack) {
        try {
          avatarLog('audio srcObject missing after attach; applying MediaStream fallback');
          audioEl.srcObject = new MediaStream([track.mediaStreamTrack]);
        } catch (streamErr) {
          avatarLog('audio MediaStream fallback failed', streamErr);
        }
      }

      avatarLog('audio attached; element state:', audioElState(audioEl));
      wireAbstractAudioPresence(audioEl);

      // MIE-19C (AUDIT): detailed audio-track state at attach time.
      try {
        var mst = track.mediaStreamTrack;
        lkLog('audio track attached', {
          trackSid: track && track.sid,
          readyState: mst && mst.readyState,
          muted: track && typeof track.isMuted === 'boolean'
            ? track.isMuted
            : (mst ? mst.muted : null),
          enabled: mst ? mst.enabled : null,
          hasSrcObject: !!audioEl.srcObject,
          paused: audioEl.paused,
          currentTime: audioEl.currentTime,
        });
      } catch (auditErr) {
        // never throw
      }

      if (window.__hugoAudioUnlocked) {
        var playPromise = audioEl.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise
            .then(function () {
              avatarLog('audioEl.play() succeeded; element state:', audioElState(audioEl));
              lkLog('audio play success', { currentTime: audioEl.currentTime });
              syncAbstractPresence();
            })
            .catch(function (err) {
              avatarLog('audioEl.play() failed (autoplay likely blocked until user interaction)', err);
              console.warn('Avatar audio autoplay blocked until user interaction.', err);
              lkLog('audio play failed', { paused: audioEl.paused });
              syncAbstractPresence();
            });
        } else {
          avatarLog('audioEl.play() returned no promise; element state:', audioElState(audioEl));
        }
      } else {
        avatarLog('audioEl.play() deferred until user gesture unlock');
        syncAbstractPresence();
      }
    }
  }

  // MIE-18A: returns a Promise that resolves ONLY once the room is connected,
  // and rejects on any failure (always falling back to the iframe first).
  function initAvatar() {
    avatarLog('initAvatar started');
    showAvatarLoading();

    return new Promise(function (resolve, reject) {
      avatarLog('session creation requested');
      fetch('/hugo/avatar/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
      })
        .then(function (res) {
          if (!res.ok) throw new Error('session_failed');
          return res.json();
        })
        .then(function (session) {
          var livekitUrl = session && session.livekit_url;
          var clientToken = session && session.livekit_client_token;
          if (!livekitUrl || !clientToken) {
            throw new Error('missing_credentials');
          }
          avatarLog('/hugo/avatar/session succeeded', {
            session_id: session && session.session_id,
            hasLivekitUrl: !!livekitUrl,
            hasClientToken: !!clientToken,
            ws_url: session && session.ws_url,
          });
          // Track the active session id (never logged as a secret elsewhere).
          avatarLifecycle.sessionId = (session && session.session_id) || null;
          // MIE-20B: capture the documented LITE control WebSocket URL (if any).
          // Absent in the ElevenLabs Connector path (ws_url is "Custom Mode only").
          avatarLifecycle.wsUrl = (session && session.ws_url) || null;
          // MIE-21: store max_session_duration to drive renewal. Default 300 if
          // missing / invalid / <= 0.
          var maxDur = session && session.max_session_duration;
          avatarLifecycle.maxSessionDuration = (typeof maxDur === 'number'
            && isFinite(maxDur) && maxDur > 0) ? maxDur : DEFAULT_MAX_SESSION_DURATION;
          lifecycleLog('session created');

          // UMD global name varies by build; accept both spellings.
          var LiveKit = window.LivekitClient || window.LiveKitClient;
          if (!LiveKit || !LiveKit.Room) {
            avatarLog('LiveKit SDK unavailable; using fallback');
            showAvatarFallback();
            setHugoConversationState('fallback');
            reject(new Error('livekit_sdk_unavailable'));
            return;
          }

          avatarFallbackTimerId = setTimeout(function () {
            if (avatarVideoLive) return;
            avatarLog('fallback timer fired (no video after timeout)');
            console.warn('Avatar timeout.');
            showAvatarFallback();
          }, 15000);

          var room = new LiveKit.Room();
          // Single source of truth for the active room.
          avatarLifecycle.room = room;
          // TEMP DEBUG (MIE-17A-AUDIT): expose room for browser inspection.
          window.__hugoLiveKitRoom = room;
          avatarLog('LiveKit room created');

          // MIE-19C (AUDIT ONLY): attach additive log-only LiveKit listeners.
          instrumentRoomAudit(room, LiveKit);

          if (LiveKit.RoomEvent) {
            var RoomEvent = LiveKit.RoomEvent;

            // MIE-18B: react to an UNEXPECTED native disconnect only. An
            // intentional teardown (avatarDisposing) must be ignored here.
            if (RoomEvent.Disconnected) {
              room.on(RoomEvent.Disconnected, function (reason) {
                if (avatarDisposing) return;
                if (avatarStopExecuted) return;
                if (avatarLifecycle.renewing) return;
                if (avatarLifecycle.room && avatarLifecycle.room !== room) return;
                roomLog('disconnected reason=' + (reason == null ? 'unknown' : String(reason)));
                avatarLog('native room disconnected', { reason: reason == null ? null : String(reason) });
                cleanupAvatarLifecycle('disconnected');
                showAvatarFallback();
                // Release the briefing mutex so the user can manually start a
                // new conversation after reconnecting.
                window.__hugoBriefingDispatched = false;
                setHugoConversationState('fallback');
              });
            }

            if (RoomEvent.TrackSubscribed) {
              room.on(RoomEvent.TrackSubscribed, function (track, publication, participant) {
                avatarLog('RoomEvent.TrackSubscribed', {
                  trackKind: track && track.kind,
                  trackSid: track && track.sid,
                  publicationKind: publication && publication.kind,
                  publicationSource: publication && publication.source,
                  publicationTrackSid: publication && publication.trackSid,
                  participantIdentity: participant && participant.identity,
                  participantSid: participant && participant.sid,
                });
                handleAvatarTrack(track);
              });
            }

            if (RoomEvent.TrackUnsubscribed) {
              room.on(RoomEvent.TrackUnsubscribed, function (track, publication, participant) {
                avatarLog('RoomEvent.TrackUnsubscribed', {
                  trackKind: track && track.kind,
                  trackSid: track && track.sid,
                  participantIdentity: participant && participant.identity,
                });
              });
            }

            if (RoomEvent.ParticipantConnected) {
              room.on(RoomEvent.ParticipantConnected, function (participant) {
                avatarLog('RoomEvent.ParticipantConnected', {
                  identity: participant && participant.identity,
                  sid: participant && participant.sid,
                });
              });
            }

            if (RoomEvent.ParticipantDisconnected) {
              room.on(RoomEvent.ParticipantDisconnected, function (participant) {
                avatarLog('RoomEvent.ParticipantDisconnected', {
                  identity: participant && participant.identity,
                  sid: participant && participant.sid,
                });
              });
            }

            // LiveKit speaking signal — abstract presence + idle reset (all modes).
            if (RoomEvent.ActiveSpeakersChanged) {
              room.on(RoomEvent.ActiveSpeakersChanged, function (speakers) {
                try {
                  abstractRemoteSpeaking = false;
                  if (Array.isArray(speakers)) {
                    for (var si = 0; si < speakers.length; si++) {
                      var sp = speakers[si];
                      if (sp && room.localParticipant && sp !== room.localParticipant) {
                        abstractRemoteSpeaking = true;
                        break;
                      }
                    }
                  }
                  if (avatarConversationActive) {
                    resetAvatarIdleTimer('livekit_speaker');
                  }
                  if (isAbstractMode) syncAbstractPresence();
                } catch (spErr) {
                  // never throw
                }
              });
            }
          }

          avatarLog('before room.connect(...)');
          room.connect(livekitUrl, clientToken)
            .then(function () {
              avatarLog('room.connect(...) resolved', {
                state: room.state,
              });
              setLifecycleState('connected');
              avatarLog('avatar connected');
              lifecycleLog('livekit connected');
              // MIE-19C (AUDIT): begin periodic snapshots (idempotent; also
              // started by RoomEvent.Connected when that event is emitted).
              lkLog('connect resolved');
              startAuditSnapshots();
              // MIE-17B: background activity (keep-alive + renewal) runs ONLY for
              // an active conversation. Without this gate an idle/unused session
              // would keep consuming credits. The only connect paths are the CTA
              // and renewal, both of which keep avatarConversationActive = true.
              if (avatarConversationActive) {
                // MIE-20: keep the LiveAvatar session alive while connected.
                startAvatarKeepAlive();
                // MIE-20B: official native LITE keep-alive over the session control
                // WebSocket (guarded on ws_url; no-op + log in connector mode).
                startNativeKeepAlive();
                // MIE-21: schedule the single renewal before this session expires.
                scheduleAvatarRenewal();
                diagnoseMicrophonePipeline('after_connect');
              } else {
                avatarLog('connected without active conversation; no keep-alive/renewal');
              }
              // Only advance to 'ready' if the CTA flow hasn't moved further.
              // The avatar is connected but SILENT: it never speaks until the
              // user clicks the CTA. Make the CTA active and clearly waiting.
              if (hugoConversationState === 'connecting') {
                setHugoConversationState('ready');
                avatarLog('waiting for user');
              }
              // Attach any tracks already published at connect time (consume only).
              var participants = room.remoteParticipants || room.participants;
              if (participants && typeof participants.forEach === 'function') {
                participants.forEach(function (participant) {
                  var pubs = participant && (participant.trackPublications || participant.tracks);
                  if (pubs && typeof pubs.forEach === 'function') {
                    pubs.forEach(function (pub) {
                      if (pub && pub.track) handleAvatarTrack(pub.track);
                    });
                  }
                });
              }
              resolve(room);
            })
            .catch(function (err) {
              avatarLog('room.connect(...) rejected; using fallback', err);
              console.warn('LiveKit connection failed.', err);
              clearTimeout(avatarFallbackTimerId);
              showAvatarFallback();
              setHugoConversationState('fallback');
              reject(err);
            });
        })
        .catch(function (err) {
          avatarLog('session creation failed', err);
          console.warn('Avatar session unavailable; using fallback.', err);
          showAvatarFallback();
          setHugoConversationState('fallback');
          reject(err);
        });
    });
  }

  // TEMP DEBUG (MIE-17A-AUDIT): on-demand snapshot of avatar/audio state.
  window.__hugoAvatarDebug = function () {
    var room = window.__hugoLiveKitRoom || null;
    var remoteCount = null;
    if (room) {
      var participants = room.remoteParticipants || room.participants;
      if (participants && typeof participants.size === 'number') {
        remoteCount = participants.size;
      } else if (participants && typeof participants.length === 'number') {
        remoteCount = participants.length;
      }
    }
    // MIE-19C (AUDIT): track counts + channel availability (no secrets).
    var audioTracks = null;
    var videoTracks = null;
    var dataChannelAvailable = false;
    var localParticipantConnected = false;
    var roomSid = null;
    var connectionState = room ? room.state : undefined;
    try {
      if (room) {
        roomSid = room.sid || null;
        var lp = room.localParticipant || null;
        localParticipantConnected = !!lp;
        dataChannelAvailable = !!(lp && typeof lp.publishData === 'function');
      }
      var audioEl = document.getElementById('avatar-audio');
      var videoEl = document.getElementById('avatar-video');
      if (audioEl && audioEl.srcObject && typeof audioEl.srcObject.getAudioTracks === 'function') {
        audioTracks = audioEl.srcObject.getAudioTracks().length;
      }
      if (videoEl && videoEl.srcObject && typeof videoEl.srcObject.getVideoTracks === 'function') {
        videoTracks = videoEl.srcObject.getVideoTracks().length;
      }
    } catch (err) {
      // never throw
    }

    return {
      hasRoom: !!room,
      roomState: room ? room.state : undefined,
      remoteParticipants: remoteCount,
      // MIE-18B: lifecycle visibility for QA (no secrets/tokens exposed).
      lifecycle: {
        state: avatarLifecycle.state,
        hasRoom: !!avatarLifecycle.room,
        hasConnectPromise: !!avatarLifecycle.connectPromise,
        hasSessionId: !!avatarLifecycle.sessionId,
        hasWsUrl: !!avatarLifecycle.wsUrl,
        maxSessionDuration: avatarLifecycle.maxSessionDuration,
        renewing: avatarLifecycle.renewing,
        renewalTimerActive: !!avatarRenewalTimerId,
        conversationActive: avatarConversationActive,
        stopExecuted: avatarStopExecuted,
        hasDeliveredInitialBrief: hasDeliveredInitialBrief,
        idleTimerActive: !!avatarIdleTimeoutId,
        nativeKeepAlive: {
          socketOpen: !!(avatarNativeKaSocket && avatarNativeKaSocket.readyState === 1),
          timerActive: !!avatarNativeKaTimerId,
        },
      },
      audioElement: audioElState(document.getElementById('avatar-audio')),
      videoElement: videoElState(document.getElementById('avatar-video')),
      // MIE-19C (AUDIT) — LiveKit connection snapshot (no secrets/tokens).
      lifecycleState: avatarLifecycle.state,
      remoteParticipantCount: remoteCount,
      localParticipantConnected: localParticipantConnected,
      audioTracks: audioTracks,
      videoTracks: videoTracks,
      dataChannelAvailable: dataChannelAvailable,
      roomSid: roomSid,
      connectionState: connectionState,
    };
  };

  // ---------- Events ----------
  sendBtn.addEventListener('click', submitQuestion);
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitQuestion();
    }
  });

  // MIE-17B: ONE centralized, idempotent stop path for every teardown trigger.
  // executeAvatarStopFlow() stops the backend session, disconnects LiveKit, and
  // clears all timers — running at most once per session, so pagehide +
  // beforeunload can never fire duplicate stops.
  window.addEventListener('pagehide', function () { executeAvatarStopFlow('pagehide'); });
  window.addEventListener('beforeunload', function () { executeAvatarStopFlow('beforeunload'); });

  // MIE-22B: public seam for the reveal sequence. v1 advances chapters on a
  // timer; a future version can drive this from real avatar speech events
  // (e.g. on each spoken section) without changing any other UX.
  window.__hugoRevealNextChapter = revealNextChapter;
  window.__hugoPresentationMode = PRESENTATION_MODE;

  // MIE-26B: global diagnostic with guaranteed console logging (not closure voiceLog).
  window.__hugoVoiceDiagnose = function (context) {
    function logVoiceDiagnostic(message, payload) {
      try {
        console.log('[Hugo Voice]', message, payload || '');
      } catch (err) {
        try {
          console.warn('[Hugo Voice]', message, payload || '');
        } catch (_) {}
      }
    }

    var ctx = context || 'unknown';
    logVoiceDiagnostic('diagnostic started', { context: ctx });

    function findMicPublication(room) {
      var lp = room && room.localParticipant;
      if (!lp) return null;
      try {
        var pubs = lp.audioTrackPublications;
        if (pubs && typeof pubs.forEach === 'function') {
          var found = null;
          pubs.forEach(function (pub) {
            if (found || !pub) return;
            var source = pub.source;
            if (source === 'microphone' || source === 1) found = pub;
          });
          if (found) return found;
        }
        var allPubs = lp.trackPublications;
        if (allPubs && typeof allPubs.forEach === 'function') {
          var foundAll = null;
          allPubs.forEach(function (pub) {
            if (foundAll || !pub) return;
            if (pub.kind === 'audio' && (pub.source === 'microphone' || pub.source === 1)) {
              foundAll = pub;
            }
          });
          return foundAll;
        }
      } catch (err) {
        logVoiceDiagnostic('microphone publication inspect failed', {
          message: err && err.message ? err.message : String(err),
        });
      }
      return null;
    }

    function runPipelineChecks() {
      logVoiceDiagnostic('pipeline check', { context: ctx });

      if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
        logVoiceDiagnostic('getUserMedia API available');
      } else {
        logVoiceDiagnostic('getUserMedia failed', { reason: 'API unavailable' });
      }
      logVoiceDiagnostic('getUserMedia not invoked by Hugo');

      var LiveKit = window.LivekitClient || window.LiveKitClient;
      if (LiveKit && typeof LiveKit.createLocalAudioTrack === 'function') {
        logVoiceDiagnostic('LocalAudioTrack SDK API available');
      } else {
        logVoiceDiagnostic('LocalAudioTrack creation failed', { reason: 'SDK API unavailable' });
      }
      logVoiceDiagnostic('LocalAudioTrack not created by Hugo');

      var room = window.__hugoLiveKitRoom;
      var lp = room && room.localParticipant;
      if (!lp) logVoiceDiagnostic('localParticipant is null');
      else logVoiceDiagnostic('localParticipant available');

      logVoiceDiagnostic('publishMicrophone not invoked by Hugo');

      var micPub = findMicPublication(room);
      if (ctx === 'after_renewal') {
        if (micPub) logVoiceDiagnostic('microphone track still published');
        else logVoiceDiagnostic('microphone track missing after renewal');
      } else if (micPub) {
        logVoiceDiagnostic('microphone published', {
          trackSid: micPub.trackSid || null,
          muted: typeof micPub.isMuted === 'boolean' ? micPub.isMuted : null,
        });
      } else {
        logVoiceDiagnostic('publish failed', { reason: 'no local microphone publication found' });
      }

      try {
        var audioEl = document.getElementById('avatar-audio');
        logVoiceDiagnostic('ElevenLabs inbound audio element', {
          hasSrcObject: !!(audioEl && audioEl.srcObject),
          paused: audioEl ? audioEl.paused : null,
          muted: audioEl ? audioEl.muted : null,
        });
        logVoiceDiagnostic('ElevenLabs user audio receipt cannot be verified from client');
      } catch (err) {
        logVoiceDiagnostic('ElevenLabs inbound audio inspect failed', {
          message: err && err.message ? err.message : String(err),
        });
      }
    }

    function finishPipeline() {
      try {
        runPipelineChecks();
        logVoiceDiagnostic('diagnostic complete', { context: ctx });
      } catch (err) {
        logVoiceDiagnostic('diagnostic pipeline failed', {
          message: err && err.message ? err.message : String(err),
        });
      }
    }

    try {
      var permSettled = false;
      function settlePermission() {
        if (permSettled) return;
        permSettled = true;
        finishPipeline();
      }

      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
        logVoiceDiagnostic('microphone permission query unavailable');
        settlePermission();
        return;
      }

      setTimeout(function () {
        if (!permSettled) {
          logVoiceDiagnostic('microphone permission query timed out');
          settlePermission();
        }
      }, 2500);

      var permPromise = navigator.permissions.query({ name: 'microphone' });
      if (!permPromise || typeof permPromise.then !== 'function') {
        logVoiceDiagnostic('microphone permission query failed', { reason: 'no promise returned' });
        settlePermission();
        return;
      }

      permPromise
        .then(function (result) {
          if (result && result.state === 'granted') logVoiceDiagnostic('microphone permission granted');
          else if (result && result.state === 'denied') logVoiceDiagnostic('microphone permission denied');
          else logVoiceDiagnostic('microphone permission state', { state: result && result.state });
          settlePermission();
        })
        .catch(function (err) {
          logVoiceDiagnostic('microphone permission query failed', {
            message: err && err.message ? err.message : String(err),
          });
          settlePermission();
        });
    } catch (err) {
      logVoiceDiagnostic('diagnostic failed', {
        message: err && err.message ? err.message : String(err),
      });
      try {
        runPipelineChecks();
        logVoiceDiagnostic('diagnostic complete', { context: ctx, afterError: true });
      } catch (err2) {
        logVoiceDiagnostic('diagnostic pipeline failed', {
          message: err2 && err2.message ? err2.message : String(err2),
        });
      }
    }
  };

  load();

  // MIE-17B: ON-DEMAND LIFECYCLE. The avatar session is NO LONGER created on page
  // load — that wasted LiveAvatar credits for anyone merely reading the Brief.
  // We deliberately do NOT call ensureAvatarConnected()/initAvatar() here. The
  // ONLY path allowed to create a session is the CTA (startConversation). On load
  // we just present the enabled CTA in a neutral "ready to start" state; zero
  // LiveAvatar credits are consumed until the user clicks.
  setHugoConversationState('ready');
})();
