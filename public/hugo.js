(function () {
  'use strict';

  // ---- DOM refs ----
  var headerDate = document.getElementById('header-date');
  var headerBadges = document.getElementById('header-badges');
  var briefPanel = document.getElementById('brief-panel');
  var questionsPanel = document.getElementById('questions-panel');
  var answerPanel = document.getElementById('answer-panel');
  var marketPanel = document.getElementById('market-panel');
  var input = document.getElementById('question-input');
  var sendBtn = document.getElementById('send-btn');
  var inputError = document.getElementById('input-error');
  var overlay = document.getElementById('overlay');

  // ---- State (memory only, never persisted) ----
  var knowledge = null;
  var history = [];
  var asking = false;

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

    html +=
      '<div class="voice-row">' +
        '<button class="btn btn-primary" id="voice-btn" type="button">&#9654; Iniciar briefing</button>' +
        '<div class="voice-status" id="voice-status"></div>' +
        '<div id="voice-area"></div>' +
      '</div>';

    if (b.headline) {
      html += '<h1 class="headline">' + escapeHtml(b.headline) + '</h1>';
    }
    if (b.whyItMatters) {
      html += '<p class="why-it-matters">' + escapeHtml(b.whyItMatters) + '</p>';
    }

    var stories = Array.isArray(b.topStories) ? b.topStories : [];
    if (stories.length) {
      html += '<div class="brief-section"><div class="section-label">Top Stories</div>';
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

    var action = b.recommendedAction;
    if (action && (action.action || action.reason)) {
      html += '<div class="brief-section"><div class="section-label">Acción recomendada</div>';
      html += '<div class="action-card">';
      if (action.priority) html += '<span class="action-priority">' + escapeHtml(action.priority) + '</span>';
      if (action.action) html += '<div class="action-text">' + escapeHtml(action.action) + '</div>';
      if (action.reason) html += '<div class="action-reason">' + escapeHtml(action.reason) + '</div>';
      html += '</div></div>';
    }

    var watch = Array.isArray(b.watchTomorrow) ? b.watchTomorrow : [];
    if (watch.length) {
      html += '<div class="brief-section"><div class="section-label">Vigilar mañana</div>';
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

    var voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) voiceBtn.addEventListener('click', startBriefing);
  }

  function renderMarket() {
    var inv = supportingData().marketInventory;
    var rows = Array.isArray(inv) ? inv.slice(0, 8) : [];
    if (!rows.length) {
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
    marketPanel.classList.remove('hidden');
  }

  function renderQuestions() {
    var b = brief();
    var qs = Array.isArray(b.followUpQuestions) ? b.followUpQuestions.slice(0, 3) : [];
    qs = qs.filter(function (q) { return typeof q === 'string' && q.trim(); });
    if (!qs.length) {
      questionsPanel.classList.add('hidden');
      return;
    }

    questionsPanel.innerHTML =
      '<div class="panel-title">Preguntas sugeridas</div>' +
      '<div class="q-list" id="suggested-list"></div>';
    var list = document.getElementById('suggested-list');
    qs.forEach(function (q) { list.appendChild(questionButton(q)); });
    questionsPanel.classList.remove('hidden');
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

  // ---------- Voice ----------
  function startBriefing() {
    if (!knowledge || !knowledge.date) return;
    var voiceBtn = document.getElementById('voice-btn');
    var status = document.getElementById('voice-status');
    var area = document.getElementById('voice-area');

    if (voiceBtn) voiceBtn.disabled = true;
    if (status) status.textContent = 'Cargando...';
    if (area) area.innerHTML = '';

    fetch('/hugo/voice?date=' + encodeURIComponent(knowledge.date), {
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.audioUrl) {
          throw new Error('unavailable');
        }
        if (status) status.textContent = '';
        renderVoice(area, result.body);
      })
      .catch(function () {
        if (status) status.textContent = 'Audio no disponible.';
        if (voiceBtn) voiceBtn.disabled = false;
      });
  }

  function renderVoice(area, data) {
    if (!area) return;
    var hasTranscript = typeof data.transcript === 'string' && data.transcript.trim();

    var html = '<audio id="voice-audio" controls preload="auto"></audio>';
    if (hasTranscript) {
      html +=
        '<button class="transcript-toggle" id="transcript-toggle" type="button">Mostrar transcripción</button>' +
        '<div class="transcript-body hidden" id="transcript-body"></div>';
    }
    area.innerHTML = html;

    var audioEl = document.getElementById('voice-audio');
    if (audioEl) {
      audioEl.addEventListener('error', function () {
        console.error('Voice audio failed to load:', audioEl.error);
      });
      audioEl.src = data.audioUrl;
      audioEl.load();
      var playPromise = audioEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function () { /* autoplay may be blocked; controls remain available */ });
      }
    }

    if (hasTranscript) {
      var toggle = document.getElementById('transcript-toggle');
      var body = document.getElementById('transcript-body');
      body.textContent = data.transcript;
      toggle.addEventListener('click', function () {
        var nowHidden = body.classList.toggle('hidden');
        toggle.textContent = nowHidden ? 'Mostrar transcripción' : 'Ocultar transcripción';
      });
    }
  }

  // ---------- Ask ----------
  function setAsking(on) {
    asking = on;
    sendBtn.disabled = on;
    sendBtn.textContent = on ? 'Pensando...' : 'Enviar';
  }

  function renderAnswer(data) {
    var html = '<p class="answer-text">' + escapeHtml(data.answer || '') + '</p>';

    var next = Array.isArray(data.nextQuestions) ? data.nextQuestions : [];
    next = next.filter(function (q) { return typeof q === 'string' && q.trim(); }).slice(0, 3);
    if (next.length) {
      html += '<div class="q-list" id="next-list"></div>';
    }

    answerPanel.innerHTML = html;
    answerPanel.classList.remove('hidden');

    if (next.length) {
      var list = document.getElementById('next-list');
      next.forEach(function (q) { list.appendChild(questionButton(q)); });
    }

    // Force fade-in even when replacing an existing answer.
    answerPanel.classList.remove('visible');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { answerPanel.classList.add('visible'); });
    });
  }

  function submitQuestion() {
    if (asking) return;
    var question = String(input.value || '').trim();
    inputError.textContent = '';
    if (!question) return;

    setAsking(true);

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
          inputError.textContent = msg;
          return;
        }
        renderAnswer(result.body);
        history.push({ question: question, answer: result.body.answer || '' });
        if (history.length > 3) history = history.slice(-3);
        input.value = '';
        autoGrow();
      })
      .catch(function () {
        inputError.textContent = 'Error de conexión.';
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

  function handleAvatarTrack(track) {
    if (!track || !track.kind) return;

    avatarLog('handleAvatarTrack called', { kind: track && track.kind });
    avatarLog('detected track.kind:', track.kind);

    if (track.kind === 'video') {
      avatarLog('treating track as VIDEO');
      var videoEl = document.getElementById('avatar-video');
      if (!videoEl) return;
      track.attach(videoEl);
      videoEl.style.display = 'block';
      avatarVideoLive = true;
      showAvatarLive();
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

      var playPromise = audioEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise
          .then(function () {
            avatarLog('audioEl.play() succeeded; element state:', audioElState(audioEl));
          })
          .catch(function (err) {
            avatarLog('audioEl.play() failed (autoplay likely blocked until user interaction)', err);
            console.warn('Avatar audio autoplay blocked until user interaction.', err);
          });
      } else {
        avatarLog('audioEl.play() returned no promise; element state:', audioElState(audioEl));
      }
    }
  }

  function initAvatar() {
    avatarLog('initAvatar started');
    showAvatarLoading();

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

        // UMD global name varies by build; accept both spellings.
        var LiveKit = window.LivekitClient || window.LiveKitClient;
        if (!LiveKit || !LiveKit.Room) {
          avatarLog('LiveKit SDK unavailable; using fallback');
          showAvatarFallback();
          return;
        }

        avatarFallbackTimerId = setTimeout(function () {
          if (avatarVideoLive) return;
          avatarLog('fallback timer fired (no video after timeout)');
          console.warn('Avatar timeout.');
          showAvatarFallback();
        }, 15000);

        var room = new LiveKit.Room();
        // TEMP DEBUG (MIE-17A-AUDIT): expose room for browser inspection.
        window.__hugoLiveKitRoom = room;
        avatarLog('LiveKit room created');

        if (LiveKit.RoomEvent) {
          var RoomEvent = LiveKit.RoomEvent;

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
        }

        avatarLog('before room.connect(...)');
        room.connect(livekitUrl, clientToken)
          .then(function () {
            avatarLog('room.connect(...) resolved', {
              state: room.state,
            });
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
          })
          .catch(function (err) {
            avatarLog('room.connect(...) rejected; using fallback', err);
            console.warn('LiveKit connection failed.', err);
            clearTimeout(avatarFallbackTimerId);
            showAvatarFallback();
          });
      })
      .catch(function (err) {
        avatarLog('avatar session unavailable; using fallback', err);
        console.warn('Avatar session unavailable; using fallback.', err);
        showAvatarFallback();
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
    return {
      hasRoom: !!room,
      roomState: room ? room.state : undefined,
      remoteParticipants: remoteCount,
      audioElement: audioElState(document.getElementById('avatar-audio')),
      videoElement: videoElState(document.getElementById('avatar-video')),
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

  load();

  // Avatar runs independently of the rest of Hugo and never blocks it.
  initAvatar();
})();
