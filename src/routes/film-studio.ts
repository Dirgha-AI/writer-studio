/**
 * Writer Film Studio — screenplay → shots → video generation
 *
 * POST /film/decompose      — AI decomposes screenplay text into visual shots
 * POST /film/render          — submit a shot for video generation (Muapi.ai)
 * GET  /film/status/:jobId   — poll render job status
 * POST /film/render-sequence — submit all shots in a scene for sequential render
 *
 * Shot decomposition: AI-powered via streamChat (Claude as cinematographer)
 * Video render: Muapi.ai gateway (Open-Higgsfield compatible)
 * Swap: replace renderShot() to use any video API (Kling, Sora, Veo, RunPod)
 *
 * @module writer/film-studio
 */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { checkBilling } from '../middleware/billing-guard';
import { streamChat, type ChatMessage, type StreamChunk } from '../services/ai-router';

export const filmStudioRoutes = new Hono();

const DEFAULT_MODEL = process.env.FILM_STUDIO_MODEL || 'groq/llama-3.3-70b-versatile';

// ── Types ────────────────────────────────────────────────────────────────────

interface Shot {
  shot_number: number;
  type: 'establishing' | 'close_up' | 'medium' | 'wide' | 'over_shoulder' | 'pov' | 'insert' | 'tracking' | 'aerial' | 'dutch_angle';
  description: string;
  dialogue: string | null;
  characters: string[];
  location: string;
  camera: {
    lens: string;
    aperture: string;
    movement: string;
  };
  duration_seconds: number;
  mood: string;
  lighting: string;
  time_of_day: string;
  sfx: string | null;
}

interface RenderJob {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'pending_configuration';
  videoUrl?: string;
  progress?: number;
  estimatedSeconds?: number;
  message?: string;
}

// ── In-memory job store (swap to Neon/Redis in production) ───────────────────

const jobStore = new Map<string, RenderJob>();

// ── Utility: Collect streamChat into string ─────────────────────────────────

async function collectStream(gen: AsyncGenerator<StreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of gen) {
    if (chunk.type === 'text' || chunk.type === 'content_block_delta') {
      text += chunk.content || (chunk as any).delta?.text || '';
    }
    if (chunk.type === 'error') throw new Error(chunk.content);
  }
  return text;
}

// ── Swappable Provider: Shot Decomposition ──────────────────────────────────

const DECOMPOSE_SYSTEM_PROMPT = `You are a professional film director, cinematographer, and 1st Assistant Director combined. You read screenplay text and decompose it into a precise shot list that a VFX house or AI video generator can execute.

## Your Expertise

You understand:
- **Screenplay format**: scene headings (INT./EXT.), action lines, character cues, dialogue blocks, parentheticals, transitions (CUT TO, DISSOLVE TO, SMASH CUT)
- **Shot types**: establishing (wide scene-setter), wide (full environment + characters), medium (waist-up), close_up (face/detail), insert (object detail), over_shoulder (OTS conversation), pov (character's viewpoint), tracking (camera follows subject), aerial (drone/crane), dutch_angle (tilted for unease)
- **Camera terminology**: lens focal length (24mm wide, 35mm standard, 50mm portrait, 85mm telephoto, 135mm compressed), aperture (f/1.4 shallow DOF, f/2.8 moderate, f/8 deep), movements (static, pan left/right, tilt up/down, dolly in/out, crane up/down, steadicam follow, handheld, rack focus, whip pan, push-in)
- **Lighting**: natural, golden hour, overcast flat, studio three-point, chiaroscuro, neon practical, moonlight, fluorescent harsh, candlelight warm, silhouette backlit
- **Mood descriptors**: tense, intimate, expansive, claustrophobic, dreamlike, gritty, serene, chaotic, melancholic, triumphant

## Output Rules

1. Parse the screenplay text and produce one shot per meaningful visual beat.
2. Dialogue exchanges should alternate between OTS shots or close-ups (standard coverage pattern).
3. Every new scene heading (INT./EXT.) starts with an establishing or wide shot.
4. Insert shots for any object mentioned in action lines that carries narrative weight.
5. Duration: establishing 3-5s, dialogue shots 2-4s per line, action shots 1-3s, inserts 1-2s.
6. Each shot's \`description\` must be a self-contained visual prompt — assume the video generator has NO context beyond this single description. Include characters' appearance, wardrobe, emotion, and environment.
7. Return ONLY valid JSON — no markdown fences, no commentary, no explanation.

## JSON Schema

Return an array of shot objects:
\`\`\`
[
  {
    "shot_number": 1,
    "type": "establishing",
    "description": "A rain-soaked Tokyo street at night, neon signs reflecting off wet pavement, crowds with umbrellas, steam rising from a ramen cart in the foreground",
    "dialogue": null,
    "characters": [],
    "location": "EXT. TOKYO STREET - NIGHT",
    "camera": { "lens": "24mm", "aperture": "f/2.8", "movement": "slow dolly forward" },
    "duration_seconds": 4,
    "mood": "melancholic",
    "lighting": "neon practical with rain reflections",
    "time_of_day": "night",
    "sfx": "rain, distant traffic, muffled J-pop from a shop"
  }
]
\`\`\`

Parse the screenplay carefully. Every visual beat gets its own shot. Never skip dialogue — map each line to a shot.`;

async function decomposeScreenplay(
  screenplay: string,
  model = DEFAULT_MODEL,
): Promise<Shot[]> {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        'Decompose this screenplay into a detailed shot list. Return ONLY the JSON array, no wrapping text.\n\n',
        '--- SCREENPLAY START ---\n',
        screenplay,
        '\n--- SCREENPLAY END ---',
      ].join(''),
    },
  ];

  const gen = streamChat(messages, model, undefined, {
    systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
    temperature: 0.3,
  });

  const raw = await collectStream(gen);

  // Parse JSON — strip markdown fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array of shots');
    }
    return parsed as Shot[];
  } catch (err: any) {
    // Try to extract JSON array from the response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]) as Shot[];
    }
    throw new Error(`Failed to parse shot list: ${err.message}`);
  }
}

// ── Swappable Provider: Video Generation (fal.ai / Muapi.ai / stub) ─────────

function generateJobId(): string {
  return `film-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function renderShot(shot: Shot): Promise<RenderJob> {
  const falKey = process.env.FAL_KEY;
  const muapiKey = process.env.MUAPI_API_KEY;
  const muapiBase = process.env.MUAPI_API_BASE || 'https://api.muapi.ai';

  // Build the visual prompt from the shot data (shared by all providers)
  const visualPrompt = [
    shot.description,
    shot.lighting ? `Lighting: ${shot.lighting}.` : '',
    shot.mood ? `Mood: ${shot.mood}.` : '',
    shot.camera?.lens ? `Shot on ${shot.camera.lens} lens` : '',
    shot.camera?.aperture ? `at ${shot.camera.aperture}` : '',
    shot.camera?.movement ? `with ${shot.camera.movement}` : '',
    shot.time_of_day ? `Time: ${shot.time_of_day}.` : '',
    'Cinematic, film grain, professional color grading.',
  ]
    .filter(Boolean)
    .join(' ');

  // ── Provider 1: fal.ai (Kling Video) ──────────────────────────────────────
  if (falKey) {
    try {
      const res = await fetch('https://fal.run/fal-ai/kling-video/v2.1/standard/text-to-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${falKey}`,
        },
        body: JSON.stringify({
          prompt: visualPrompt,
          duration: Math.min(shot.duration_seconds || 4, 10),
          aspect_ratio: '16:9',
        }),
        signal: AbortSignal.timeout(300_000), // 5 min — synchronous, waits for completion
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error('[film-studio/render] fal.ai error:', res.status, errText);
        const jobId = `err-${generateJobId()}`;
        const job: RenderJob = {
          jobId,
          status: 'failed',
          message: `fal.ai returned ${res.status}: ${errText.slice(0, 200)}`,
        };
        jobStore.set(jobId, job);
        return job;
      }

      const data = await res.json() as { video?: { url: string }; request_id?: string };
      const jobId = data.request_id ? `fal-${data.request_id}` : `fal-${generateJobId()}`;

      const job: RenderJob = {
        jobId,
        status: 'completed',
        videoUrl: data.video?.url,
      };
      jobStore.set(jobId, job);
      return job;

    } catch (err: any) {
      console.error('[film-studio/render] fal.ai request failed:', err.message);
      const jobId = `err-${generateJobId()}`;
      const job: RenderJob = { jobId, status: 'failed', message: `fal.ai network error: ${err.message}` };
      jobStore.set(jobId, job);
      return job;
    }
  }

  // ── Provider 2: Muapi.ai ───────────────────────────────────────────────────
  if (muapiKey) {
    try {
      const res = await fetch(`${muapiBase}/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${muapiKey}`,
        },
        body: JSON.stringify({
          prompt: visualPrompt,
          type: 'video',
          duration: Math.min(shot.duration_seconds || 4, 10),
          aspect_ratio: '16:9',
          model: process.env.MUAPI_MODEL || 'higgsfield-v1',
          negative_prompt: 'blurry, low quality, watermark, text overlay, distorted faces, extra limbs',
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error('[film-studio/render] Muapi.ai error:', res.status, errText);
        const jobId = `err-${generateJobId()}`;
        const job: RenderJob = {
          jobId,
          status: 'failed',
          message: `Muapi.ai returned ${res.status}: ${errText.slice(0, 200)}`,
        };
        jobStore.set(jobId, job);
        return job;
      }

      const data = await res.json() as { id?: string; job_id?: string; status?: string; estimated_time?: number };
      const remoteJobId = data.id || data.job_id || generateJobId();

      const job: RenderJob = {
        jobId: remoteJobId,
        status: 'queued',
        estimatedSeconds: data.estimated_time || 60,
      };
      jobStore.set(remoteJobId, job);
      return job;

    } catch (err: any) {
      console.error('[film-studio/render] Muapi.ai request failed:', err.message);
      const jobId = `err-${generateJobId()}`;
      const job: RenderJob = { jobId, status: 'failed', message: `Network error: ${err.message}` };
      jobStore.set(jobId, job);
      return job;
    }
  }

  // ── Provider 3: Replicate (Wan 2.1) ───────────────────────────────────────
  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (replicateToken) {
    try {
      const res = await fetch('https://api.replicate.com/v1/models/wan-ai/wan2.1-t2v-480p/predictions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${replicateToken}`,
          Prefer: 'respond-async',
        },
        body: JSON.stringify({
          input: {
            prompt: visualPrompt,
            num_frames: Math.min((shot.duration_seconds || 4) * 16, 81),
            sample_steps: 30,
            fast_mode: 'Balanced',
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error('[film-studio/render] Replicate error:', res.status, errText);
        const jobId = `err-${generateJobId()}`;
        const job: RenderJob = { jobId, status: 'failed', message: `Replicate returned ${res.status}: ${errText.slice(0, 200)}` };
        jobStore.set(jobId, job);
        return job;
      }

      const data = await res.json() as { id?: string; status?: string; urls?: { get?: string } };
      const remoteId = data.id || generateJobId();
      const jobId = `repli-${remoteId}`;
      const job: RenderJob = { jobId, status: 'queued', estimatedSeconds: 90 };
      jobStore.set(jobId, job);
      return job;

    } catch (err: any) {
      console.error('[film-studio/render] Replicate request failed:', err.message);
      const jobId = `err-${generateJobId()}`;
      const job: RenderJob = { jobId, status: 'failed', message: `Replicate network error: ${err.message}` };
      jobStore.set(jobId, job);
      return job;
    }
  }

  // ── Provider 4: Stub (no keys configured) ─────────────────────────────────
  const jobId = `stub-${generateJobId()}`;
  const job: RenderJob = {
    jobId,
    status: 'pending_configuration',
    estimatedSeconds: 0,
    message: 'Video generation not configured. Set FAL_KEY, MUAPI_API_KEY, or REPLICATE_API_TOKEN to enable rendering.',
  };
  jobStore.set(jobId, job);
  return job;
}

async function checkRenderStatus(jobId: string): Promise<RenderJob> {
  // Check local store first
  const cached = jobStore.get(jobId);

  // Stub jobs always return their stored state
  if (jobId.startsWith('stub-')) {
    return cached || {
      jobId,
      status: 'pending_configuration',
      message: 'Set FAL_KEY, MUAPI_API_KEY, or REPLICATE_API_TOKEN to enable video generation.',
    };
  }

  // Error jobs are terminal
  if (jobId.startsWith('err-')) {
    return cached || { jobId, status: 'failed', message: 'Job failed.' };
  }

  // fal.ai status check (queue endpoint)
  if (jobId.startsWith('fal-')) {
    const falKey = process.env.FAL_KEY;
    if (!falKey) {
      return cached || { jobId, status: 'pending_configuration', message: 'FAL_KEY not set.' };
    }
    const remoteId = jobId.slice(4); // strip 'fal-' prefix
    try {
      const res = await fetch(`https://queue.fal.run/fal-ai/kling-video/requests/${remoteId}/status`, {
        headers: { Authorization: `Key ${falKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return cached || { jobId, status: 'failed', message: `fal.ai status check failed: ${res.status}` };
      }
      const data = await res.json() as { status?: string; output?: { video?: { url: string } } };
      const statusMap: Record<string, RenderJob['status']> = {
        IN_QUEUE: 'queued',
        IN_PROGRESS: 'processing',
        COMPLETED: 'completed',
        FAILED: 'failed',
      };
      const job: RenderJob = {
        jobId,
        status: statusMap[data.status || ''] || 'processing',
        videoUrl: data.output?.video?.url,
      };
      jobStore.set(jobId, job);
      return job;
    } catch (err: any) {
      console.error('[film-studio/status] fal.ai check failed:', err.message);
      return cached || { jobId, status: 'failed', message: err.message };
    }
  }

  // Replicate (Wan 2.1) status check
  if (jobId.startsWith('repli-')) {
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) return cached || { jobId, status: 'pending_configuration', message: 'REPLICATE_API_TOKEN not set.' };
    const remoteId = jobId.slice(6); // strip 'repli-'
    try {
      const res = await fetch(`https://api.replicate.com/v1/predictions/${remoteId}`, {
        headers: { Authorization: `Token ${replicateToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return cached || { jobId, status: 'failed', message: `Replicate status check failed: ${res.status}` };
      const data = await res.json() as { status?: string; output?: string | string[]; error?: string };
      const statusMap: Record<string, RenderJob['status']> = {
        starting: 'queued', processing: 'processing', succeeded: 'completed', failed: 'failed', canceled: 'failed',
      };
      const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
      const job: RenderJob = {
        jobId,
        status: statusMap[data.status || ''] || 'processing',
        videoUrl: outputUrl || undefined,
        message: data.error || undefined,
      };
      jobStore.set(jobId, job);
      return job;
    } catch (err: any) {
      console.error('[film-studio/status] Replicate check failed:', err.message);
      return cached || { jobId, status: 'failed', message: err.message };
    }
  }

  // Query Muapi.ai for real status
  const apiKey = process.env.MUAPI_API_KEY;
  const baseUrl = process.env.MUAPI_API_BASE || 'https://api.muapi.ai';

  if (!apiKey) {
    return cached || { jobId, status: 'pending_configuration', message: 'No video API key configured.' };
  }

  try {
    const res = await fetch(`${baseUrl}/v1/status/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return cached || { jobId, status: 'failed', message: `Status check failed: ${res.status}` };
    }

    const data = await res.json() as {
      status?: string;
      video_url?: string;
      output_url?: string;
      progress?: number;
      estimated_time?: number;
    };

    const statusMap: Record<string, RenderJob['status']> = {
      queued: 'queued',
      pending: 'queued',
      processing: 'processing',
      running: 'processing',
      completed: 'completed',
      done: 'completed',
      success: 'completed',
      failed: 'failed',
      error: 'failed',
    };

    const job: RenderJob = {
      jobId,
      status: statusMap[data.status || ''] || 'processing',
      videoUrl: data.video_url || data.output_url || undefined,
      progress: data.progress,
      estimatedSeconds: data.estimated_time,
    };

    jobStore.set(jobId, job);
    return job;

  } catch (err: any) {
    console.error('[film-studio/status] Check failed:', err.message);
    return cached || { jobId, status: 'failed', message: err.message };
  }
}

// ── Route 1: POST /film/decompose ───────────────────────────────────────────

filmStudioRoutes.post('/film/decompose', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { screenplay?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const screenplay = body.screenplay?.trim();
  if (!screenplay) {
    return c.json({ error: 'screenplay text is required' }, 400);
  }

  if (screenplay.length > 50_000) {
    return c.json({ error: 'Screenplay too long — max 50,000 characters per request. Split into scenes.' }, 400);
  }

  const model = body.model || DEFAULT_MODEL;
  const billing = await checkBilling(user.id, model);
  if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

  try {
    const shots = await decomposeScreenplay(screenplay, model);
    const totalDuration = shots.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);

    return c.json({
      shots,
      total_shots: shots.length,
      estimated_duration_seconds: totalDuration,
      estimated_duration_formatted: `${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`,
    });
  } catch (err: any) {
    console.error('[film-studio/decompose] Error:', err.message);
    return c.json({ error: err.message || 'Shot decomposition failed' }, 500);
  }
});

// ── Route 2: POST /film/render ──────────────────────────────────────────────

filmStudioRoutes.post('/film/render', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { shot?: Shot };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const shot = body.shot;
  if (!shot || !shot.description) {
    return c.json({ error: 'shot object with description is required' }, 400);
  }

  try {
    const result = await renderShot(shot);
    return c.json(result);
  } catch (err: any) {
    console.error('[film-studio/render] Error:', err.message);
    return c.json({ error: err.message || 'Render submission failed' }, 500);
  }
});

// ── Route 3: GET /film/status/:jobId ────────────────────────────────────────

filmStudioRoutes.get('/film/status/:jobId', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const jobId = c.req.param('jobId');
  if (!jobId) {
    return c.json({ error: 'jobId is required' }, 400);
  }

  try {
    const result = await checkRenderStatus(jobId);
    return c.json(result);
  } catch (err: any) {
    console.error('[film-studio/status] Error:', err.message);
    return c.json({ error: err.message || 'Status check failed' }, 500);
  }
});

// ── Route 4: POST /film/render-sequence ─────────────────────────────────────

filmStudioRoutes.post('/film/render-sequence', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { shots?: Shot[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const shots = body.shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    return c.json({ error: 'shots array is required' }, 400);
  }

  if (shots.length > 50) {
    return c.json({ error: 'Max 50 shots per sequence render' }, 400);
  }

  // Submit all shots in parallel
  const results = await Promise.allSettled(
    shots.map((shot) => renderShot(shot)),
  );

  const jobs = results.map((r, i) => {
    if (r.status === 'fulfilled') {
      return { shot_number: shots[i].shot_number ?? i + 1, ...r.value };
    }
    return {
      shot_number: shots[i].shot_number ?? i + 1,
      jobId: `err-${generateJobId()}`,
      status: 'failed' as const,
      message: r.reason?.message || 'Unknown error',
    };
  });

  return c.json({
    jobs,
    total: jobs.length,
    queued: jobs.filter((j) => j.status === 'queued').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    pending_configuration: jobs.filter((j) => j.status === 'pending_configuration').length,
  });
});
