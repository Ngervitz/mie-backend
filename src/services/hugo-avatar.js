const logger = require('../lib/logger');

// Thin adapter for starting a LiveAvatar LITE session wired to the existing
// ElevenLabs Agent (which itself uses Hugo's OpenAI-compatible wrapper as its
// Custom LLM). This file starts a session and returns only client-safe data.
// It never generates audio, never calls ElevenLabs directly, and never exposes
// any API key or secret to the caller.

const LIVEAVATAR_BASE = 'https://api.liveavatar.com/v1';

// Structured error carrying a safe status + body (no secrets, no raw bodies).
class AvatarError extends Error {
  constructor(status, body) {
    super((body && body.error && body.error.message) || 'Avatar session error');
    this.status = status;
    this.body = body;
  }
}

function errBody(status, provider, message, code) {
  const error = { status, provider, message };
  if (code !== undefined) error.code = code;
  return { error };
}

function requireConfig() {
  const apiKey = process.env.LIVEAVATAR_API_KEY;
  const avatarId = process.env.LIVEAVATAR_AVATAR_ID;
  const secretId = process.env.LIVEAVATAR_ELEVENLABS_SECRET_ID;
  const agentId = process.env.ELEVENLABS_AGENT_ID;

  const missing = [];
  if (!apiKey) missing.push('LIVEAVATAR_API_KEY');
  if (!avatarId) missing.push('LIVEAVATAR_AVATAR_ID');
  if (!secretId) missing.push('LIVEAVATAR_ELEVENLABS_SECRET_ID');
  if (!agentId) missing.push('ELEVENLABS_AGENT_ID');

  if (missing.length) {
    throw new AvatarError(500, errBody(500, 'config', `Avatar session is not configured (missing: ${missing.join(', ')}).`, 'missing_config'));
  }

  return { apiKey, avatarId, secretId, agentId };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch (err) {
    return null;
  }
}

// Provider error messages are safe (no secrets); fall back to a generic line.
function providerMessage(data, fallback) {
  if (data && typeof data.message === 'string' && data.message.trim()) {
    return data.message;
  }
  return fallback;
}

async function startAvatarSession() {
  const startedMs = Date.now();
  logger.info('Hugo avatar session started');

  try {
    const { apiKey, avatarId, secretId, agentId } = requireConfig();

    // 1) Mint a LITE session token bound to the ElevenLabs Agent connector.
    // NOTE (MIE-19B): this payload intentionally carries NO greeting / welcome /
    // first_message / opening field. The LiveAvatar LITE session API
    // (ElevenLabsAgentConfigSchema) does not expose any auto-greeting toggle —
    // it only accepts secret_id, agent_id, optional voice_id and optional
    // dynamic_variables. Therefore any unwanted speech on session start comes
    // from the ElevenLabs Agent's own "First message" setting, which must be
    // cleared in the ElevenLabs Agent dashboard (set it empty) so Hugo stays
    // silent until the CTA sends the first user_message.
    const sessionPayload = {
      mode: 'LITE',
      avatar_id: avatarId,
      elevenlabs_agent_config: {
        secret_id: secretId,
        agent_id: agentId,
      },
    };

    // Safe greeting-field audit (no secrets): confirms we never send a greeting.
    const GREETING_FIELDS = [
      'greeting', 'welcome_message', 'initial_message', 'first_message',
      'conversation_start', 'auto_start', 'autoGreeting', 'opening_message',
      'initial_response',
    ];
    const greetingFieldsPresent = GREETING_FIELDS.filter((f) => (
      Object.prototype.hasOwnProperty.call(sessionPayload, f)
      || Object.prototype.hasOwnProperty.call(sessionPayload.elevenlabs_agent_config, f)
    ));
    logger.info('Hugo avatar session payload shape', {
      mode: sessionPayload.mode,
      hasAvatarId: !!avatarId,
      hasAgentConfig: !!sessionPayload.elevenlabs_agent_config,
      greetingFieldsPresent,
      greetingDisabledInPayload: greetingFieldsPresent.length === 0,
    });

    let tokenRes;
    try {
      tokenRes = await fetch(`${LIVEAVATAR_BASE}/sessions/token`, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(sessionPayload),
      });
    } catch (err) {
      throw new AvatarError(502, errBody(502, 'liveavatar', 'Failed to reach LiveAvatar.', 'provider_unreachable'));
    }

    const tokenData = await safeJson(tokenRes);
    const sessionToken = tokenData && tokenData.data ? tokenData.data.session_token : undefined;
    if (!tokenRes.ok || !sessionToken) {
      const status = tokenRes.status >= 400 ? tokenRes.status : 502;
      throw new AvatarError(status, errBody(status, 'liveavatar', providerMessage(tokenData, 'Failed to create LiveAvatar session token.'), tokenData && tokenData.code));
    }

    // 2) Start the session with the scoped token.
    let startRes;
    try {
      startRes = await fetch(`${LIVEAVATAR_BASE}/sessions/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
    } catch (err) {
      throw new AvatarError(502, errBody(502, 'liveavatar', 'Failed to start LiveAvatar session.', 'provider_unreachable'));
    }

    const startData = await safeJson(startRes);
    const session = startData && startData.data ? startData.data : null;
    if (!startRes.ok || !session || !session.livekit_url || !session.livekit_client_token) {
      const status = startRes.status >= 400 ? startRes.status : 502;
      throw new AvatarError(status, errBody(status, 'liveavatar', providerMessage(startData, 'Failed to start LiveAvatar session.'), startData && startData.code));
    }

    logger.info('Hugo avatar session completed', {
      durationMs: Date.now() - startedMs,
      status: startRes.status,
    });

    // Return ONLY client-safe connection data. The livekit_agent_token is
    // intentionally withheld (it is for the agent side, not the browser).
    return {
      mode: 'LITE',
      session_id: session.session_id,
      livekit_url: session.livekit_url,
      livekit_client_token: session.livekit_client_token,
      max_session_duration: session.max_session_duration,
      ws_url: session.ws_url,
    };
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : 500;
    const code = err && err.body && err.body.error ? err.body.error.code : undefined;
    logger.error('Hugo avatar session failed', {
      durationMs: Date.now() - startedMs,
      status,
      ...(code !== undefined ? { code } : {}),
    });
    throw err;
  }
}

module.exports = { startAvatarSession, AvatarError };
