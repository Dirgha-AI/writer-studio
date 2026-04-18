/**
 * Writer Transcribe — audio to text (ASR)
 * Swap provider: change transcribeAudio() to use Izwi, Deepgram, etc.
 * @module writer/transcribe
 */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';

export const transcribeRoutes = new Hono();

// ── Swappable Provider ──────────────────────────────────────────────────────

const FASTER_WHISPER_URL = process.env.FASTER_WHISPER_URL || 'http://localhost:8010';

async function isFasterWhisperReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${FASTER_WHISPER_URL}/health`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok || res.status < 500;
  } catch {
    // Try the models endpoint as an alternative health probe
    try {
      const res2 = await fetch(`${FASTER_WHISPER_URL}/v1/models`, {
        signal: AbortSignal.timeout(1_000),
      });
      return res2.ok;
    } catch {
      return false;
    }
  }
}

async function transcribeAudio(audio: File): Promise<{ text: string; model: string }> {
  // ── Provider 1: faster-whisper-server (local, zero-cost) ──────────────────
  const fwReachable = await isFasterWhisperReachable();
  if (fwReachable) {
    try {
      const form = new FormData();
      form.append('file', audio, audio.name || 'audio.webm');
      form.append('model', 'tiny');
      form.append('response_format', 'json');

      const res = await fetch(`${FASTER_WHISPER_URL}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        const data = (await res.json()) as { text: string };
        return { text: data.text, model: 'faster-whisper-tiny' };
      }
      console.warn('[writer/transcribe] faster-whisper-server returned', res.status, '— falling back to Groq');
    } catch (err: any) {
      console.warn('[writer/transcribe] faster-whisper-server error:', err.message, '— falling back to Groq');
    }
  }

  // ── Provider 2: Groq (cloud fallback) ─────────────────────────────────────
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const form = new FormData();
  form.append('file', audio, 'audio.webm');
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => 'unknown');
    throw new Error(`Groq ASR failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as { text: string };
  return { text: data.text, model: 'whisper-large-v3' };
}

// ── Route ───────────────────────────────────────────────────────────────────

transcribeRoutes.post('/transcribe', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const body = await c.req.parseBody();
    const audio = body['audio'];

    if (!audio || !(audio instanceof File)) {
      return c.json({ error: 'Missing or invalid "audio" field in form data' }, 400);
    }

    // Enforce 25 MB file size limit and audio MIME type allowlist
    const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
    if (audio.size > MAX_AUDIO_BYTES) {
      return c.json({ error: 'Audio file too large (max 25 MB)' }, 413);
    }
    const ALLOWED_AUDIO_TYPES = [
      'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg',
      'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/mp3',
    ];
    if (audio.type && !ALLOWED_AUDIO_TYPES.includes(audio.type)) {
      return c.json({ error: 'Unsupported audio format' }, 415);
    }

    const result = await transcribeAudio(audio);
    return c.json(result);
  } catch (err: any) {
    if (err.message === 'GROQ_API_KEY not configured') {
      return c.json({ error: 'Transcription service not configured' }, 503);
    }
    console.error('[writer/transcribe] ASR error:', err);
    return c.json({ error: 'Transcription failed' }, 500);
  }
});
