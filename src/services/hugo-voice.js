const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { runHugo } = require('./hugo-brain');

const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const DEFAULT_BUCKET = 'hugo-voice';
const MAX_TRANSCRIPT_CHARS = 1000;
const ELEVENLABS_TTS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

// Structured error so the route can map a safe status + body directly.
// Never carries secrets or raw provider responses.
class VoiceError extends Error {
  constructor(status, body) {
    super((body && body.error) || 'Voice error');
    this.status = status;
    this.body = body;
  }
}

function getBucket() {
  return process.env.HUGO_VOICE_BUCKET || DEFAULT_BUCKET;
}

function validateVoiceEnv() {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
    throw new VoiceError(500, {
      error: 'Voice generation is not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID.',
    });
  }
  if (!process.env.SUPABASE_URL) {
    throw new VoiceError(500, {
      error: 'Voice storage is not configured. Set SUPABASE_URL.',
    });
  }
}

function buildPublicUrl(bucket, fileName) {
  const base = String(process.env.SUPABASE_URL).replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${bucket}/${fileName}`;
}

function getAudioPath(date) {
  return `${date}.mp3`;
}

function getTranscriptPath(date) {
  return `${date}.txt`;
}

function getPublicAudioUrl(date) {
  return buildPublicUrl(getBucket(), getAudioPath(date));
}

// Best-effort read of the transcript sidecar. Returns the text on hit,
// or null when missing/empty/unreadable (never throws).
async function readTranscriptSidecar(date) {
  try {
    const { data, error } = await supabase.storage
      .from(getBucket())
      .download(getTranscriptPath(date));
    if (error || !data) {
      return null;
    }
    const text = await data.text();
    return text && text.trim() ? text : null;
  } catch (err) {
    return null;
  }
}

// Best-effort write of the transcript sidecar. Returns an error object on
// failure (caller decides how to handle); audio is the primary asset.
async function uploadTranscriptSidecar(date, transcript) {
  const { error } = await supabase.storage
    .from(getBucket())
    .upload(getTranscriptPath(date), Buffer.from(transcript, 'utf-8'), {
      contentType: 'text/plain; charset=utf-8',
      upsert: true,
    });
  return error;
}

// Cache probe against the public object URL. The bucket is assumed Public,
// so a HEAD 200 means the audio for that date already exists.
async function audioExists(publicUrl) {
  try {
    const res = await fetch(publicUrl, { method: 'HEAD' });
    return res.ok;
  } catch (err) {
    return false;
  }
}

function truncateTranscript(text) {
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    return { text: text.slice(0, MAX_TRANSCRIPT_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

// Expensive path: runs the full Hugo Claude -> GPT pipeline to obtain
// outputs.voice.script for the requested date.
async function loadVoiceScript(date) {
  const result = await runHugo({ date });
  const voice = result && result.outputs && result.outputs.voice ? result.outputs.voice : {};
  return voice.script;
}

async function generateElevenLabsAudio(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;

  logger.info('ElevenLabs generation started', { modelId, chars: text.length });

  let response;
  try {
    response = await fetch(`${ELEVENLABS_TTS_BASE}/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
      }),
    });
  } catch (err) {
    logger.error('ElevenLabs request failed', { error: err && err.message });
    throw new VoiceError(502, { error: 'Voice provider request failed. Try again later.' });
  }

  if (response.status === 429 || response.status === 402) {
    logger.error('ElevenLabs quota/rate limit', { status: response.status });
    throw new VoiceError(502, {
      error: 'Voice provider rate limit reached or insufficient credits.',
    });
  }

  if (!response.ok) {
    logger.error('ElevenLabs generation failed', { status: response.status });
    throw new VoiceError(502, { error: `Voice provider generation failed (HTTP ${response.status}).` });
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!buffer.length) {
    throw new VoiceError(502, { error: 'Voice provider returned an empty audio file.' });
  }

  logger.info('ElevenLabs generation completed', { bytes: buffer.length });
  return buffer;
}

function isDuplicateUploadError(error) {
  if (!error) return false;
  const status = Number(error.statusCode);
  const message = String(error.message || '');
  return status === 409 || error.error === 'Duplicate' || /already exists/i.test(message);
}

function isBucketMissingError(error) {
  if (!error) return false;
  const status = Number(error.statusCode);
  const message = String(error.message || '');
  return status === 404 || /bucket not found/i.test(message);
}

async function generateVoiceBrief({ date }) {
  validateVoiceEnv();

  const bucket = getBucket();
  const fileName = getAudioPath(date);
  const audioUrl = getPublicAudioUrl(date);

  // 1) Cache check — return immediately on hit (no Hugo run, no TTS cost).
  //    Transcript is served from the sidecar so cache hits still show text.
  if (await audioExists(audioUrl)) {
    logger.info('Voice cache hit', { date });
    const cachedTranscript = await readTranscriptSidecar(date);
    if (cachedTranscript) {
      logger.info('Transcript sidecar hit', { date });
    } else {
      logger.warn('Transcript sidecar missing', { date });
    }
    return {
      date,
      audioUrl,
      cached: true,
      transcript: cachedTranscript || null,
      provider: 'elevenlabs',
      generatedAt: new Date().toISOString(),
    };
  }

  logger.info('Voice cache miss', { date });

  // 2) Load the deterministic voice script from the existing Hugo output.
  const rawScript = await loadVoiceScript(date);
  if (typeof rawScript !== 'string') {
    throw new VoiceError(422, { error: 'No voice script available for the requested date.' });
  }
  const trimmed = rawScript.trim();
  if (!trimmed) {
    throw new VoiceError(422, { error: 'Voice transcript is empty for the requested date.' });
  }

  const { text: transcript, truncated } = truncateTranscript(trimmed);
  if (truncated) {
    logger.info('Voice transcript truncated', {
      date,
      originalChars: trimmed.length,
      truncatedChars: transcript.length,
    });
  }

  // 3) Re-check the cache right before paying for generation (cheap concurrency guard).
  if (await audioExists(audioUrl)) {
    logger.info('Voice cache hit (pre-generation)', { date });
    return {
      date,
      audioUrl,
      cached: true,
      transcript,
      provider: 'elevenlabs',
      generatedAt: new Date().toISOString(),
    };
  }

  // 4) Generate audio.
  const buffer = await generateElevenLabsAudio(transcript);

  // 5) Upload with upsert:false so a concurrent writer cannot be clobbered.
  const { error: uploadError } = await supabase.storage.from(bucket).upload(fileName, buffer, {
    contentType: 'audio/mpeg',
    upsert: false,
  });

  if (uploadError) {
    // Another request generated it first — treat as a cache hit.
    if (isDuplicateUploadError(uploadError)) {
      logger.info('Voice object already existed during upload', { date });
      return {
        date,
        audioUrl,
        cached: true,
        transcript,
        provider: 'elevenlabs',
        generatedAt: new Date().toISOString(),
      };
    }

    if (isBucketMissingError(uploadError)) {
      logger.error('Voice storage bucket missing', { bucket });
      throw new VoiceError(500, {
        error: `Storage bucket "${bucket}" not found. Create it as a Public bucket in Supabase.`,
      });
    }

    logger.error('Voice storage upload failed', { date, error: uploadError.message });
    throw new VoiceError(500, { error: 'Failed to store the generated audio.' });
  }

  logger.info('Voice storage upload completed', { date, bucket, fileName });

  // 6) Best-effort transcript sidecar. Audio is the primary asset, so a
  //    sidecar failure must never fail the whole request.
  const sidecarError = await uploadTranscriptSidecar(date, transcript);
  if (sidecarError) {
    logger.warn('Transcript sidecar upload failed', { date, error: sidecarError.message });
  } else {
    logger.info('Transcript sidecar upload completed', { date });
  }

  return {
    date,
    audioUrl,
    cached: false,
    transcript,
    provider: 'elevenlabs',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { generateVoiceBrief, VoiceError };
