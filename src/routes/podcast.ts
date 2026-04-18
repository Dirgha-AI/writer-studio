/**
 * Writer Podcast — text-to-speech synthesis for the Writer module.
 * Swap provider: change synthesizeSpeech() to use Cartesia, ElevenLabs, Groq, etc.
 * @module writer/podcast
 */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { config } from '../config';

export const podcastRoutes = new Hono();

// ── Provider detection ──────────────────────────────────────────────

type Provider = 'openai' | 'elevenlabs' | 'cartesia';

const OPENAI_TTS_API = 'https://api.openai.com/v1/audio/speech';
const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';
const CARTESIA_API = 'https://api.cartesia.ai';

/** A key is valid if it is set and not an obvious placeholder. */
function isValidKey(key: string | undefined): boolean {
  if (!key) return false;
  // Reject placeholder patterns used during development
  if (key.includes('xxxx') || key === 'YOUR_KEY_HERE' || key.length < 20) return false;
  return true;
}

function detectProvider(): Provider | null {
  if (isValidKey(config.tts?.openaiApiKey)) return 'openai';
  if (isValidKey(config.tts?.elevenlabsApiKey)) return 'elevenlabs';
  if (isValidKey(config.tts?.cartesiaApiKey)) return 'cartesia';
  return null;
}

// ── Swappable speech synthesis ──────────────────────────────────────

async function synthesizeOpenAI(text: string, voice: string): Promise<ArrayBuffer> {
  const res = await fetch(OPENAI_TTS_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.tts.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: voice || 'alloy',
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI TTS ${res.status}: ${body}`);
  }
  return res.arrayBuffer();
}

async function synthesizeElevenLabs(text: string, voice: string): Promise<ArrayBuffer> {
  const voiceId = voice || 'rachel';
  const res = await fetch(`${ELEVENLABS_API}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': config.tts.elevenlabsApiKey,
    },
    body: JSON.stringify({
      model_id: 'eleven_multilingual_v2',
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS ${res.status}: ${body}`);
  }
  return res.arrayBuffer();
}

async function synthesizeCartesia(text: string, voice: string): Promise<ArrayBuffer> {
  const res = await fetch(`${CARTESIA_API}/tts/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.tts.cartesiaApiKey,
    },
    body: JSON.stringify({
      model: 'sonic-english',
      transcript: text,
      voice_id: voice || '71a7ad14-091c-4e8e-a314-022ece01c121',
      speed: 1.0,
      output_format: 'mp3',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cartesia TTS ${res.status}: ${body}`);
  }
  return res.arrayBuffer();
}

async function synthesizeSpeech(text: string, voice: string): Promise<{ audio: ArrayBuffer; provider: Provider }> {
  const provider = detectProvider();
  if (!provider) {
    throw new NoProviderError('No TTS provider configured — set OPENAI_API_KEY, ELEVENLABS_API_KEY, or CARTESIA_API_KEY');
  }
  let audio: ArrayBuffer;
  switch (provider) {
    case 'openai':
      audio = await synthesizeOpenAI(text, voice);
      break;
    case 'elevenlabs':
      audio = await synthesizeElevenLabs(text, voice);
      break;
    case 'cartesia':
      audio = await synthesizeCartesia(text, voice);
      break;
  }
  return { audio, provider };
}

// ── Custom error for missing provider ───────────────────────────────

class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProviderError';
  }
}

// ── Route: POST /podcast/synthesize ─────────────────────────────────

podcastRoutes.post('/podcast/synthesize', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { text?: string; voice?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { text, voice } = body;
  if (!text || typeof text !== 'string') {
    return c.json({ error: 'Missing required field: text' }, 400);
  }
  if (text.length < 2) {
    return c.json({ error: 'Text too short — minimum 2 characters' }, 400);
  }
  if (text.length > 4096) {
    return c.json({ error: 'Text too long — maximum 4096 characters' }, 400);
  }

  try {
    const { audio, provider } = await synthesizeSpeech(text, voice || 'alloy');
    c.header('Content-Type', 'audio/mpeg');
    c.header('X-TTS-Provider', provider);
    c.header('Content-Disposition', 'inline; filename="podcast.mp3"');
    return c.body(audio);
  } catch (err: any) {
    if (err instanceof NoProviderError) {
      return c.json({ error: err.message }, 503);
    }
    console.error('[writer/podcast] synthesize error:', err.message || err);
    return c.json({ error: 'Speech synthesis failed' }, 500);
  }
});
