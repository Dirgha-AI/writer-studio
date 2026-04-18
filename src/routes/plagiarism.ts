/**
 * Writer — Plagiarism Check
 *
 * POST /plagiarism/check
 *   → Embed the submitted text via LiteLLM text-embedding-3-small,
 *     search the user's own Qdrant collection for similar chunks,
 *     and ask kimi-k2 to score unoriginality and flag suspicious phrases.
 *
 * Response:
 *   {
 *     score: 0-100,
 *     verdict: 'original' | 'partial' | 'likely_plagiarized',
 *     flagged_phrases: [{ text, reason }],
 *     similar_chunks: [{ text, source, similarity }]
 *   }
 *
 * @module writer/plagiarism
 */

import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { streamChat } from '../services/ai-router';
import { checkBilling } from '../middleware/billing-guard';

export const plagiarismRoutes = new Hono();

// ─── Config ──────────────────────────────────────────────────────────────────

const QDRANT_BASE = 'http://localhost:6333';
const QDRANT_COLLECTION = 'user_docs';

const LITELLM_BASE = process.env.LITELLM_API_BASE || 'http://localhost:4000';
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY || '';
const EMBED_MODEL = 'text-embedding-3-small';

const PLAGIARISM_MODEL = 'kimi-k2';

// Maximum text length we send to the LLM for phrase analysis
const MAX_TEXT_LEN = 8000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Embed a single string via LiteLLM → returns a float vector. */
async function embedText(input: string): Promise<number[]> {
  const res = await fetch(`${LITELLM_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LITELLM_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: [input] }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Embedding request failed (${res.status}): ${detail}`);
  }

  const data = await res.json() as { data: Array<{ embedding: number[]; index: number }> };
  if (!Array.isArray(data.data) || data.data.length === 0) {
    throw new Error('Embedding API returned no vectors');
  }
  return data.data[0].embedding;
}

interface QdrantScoredPoint {
  id: string;
  score: number;
  payload: {
    user_id: string;
    document_id: string;
    chunk_index: number;
    text: string;
    source: string;
  };
}

/** Search user's Qdrant collection for similar chunks. */
async function qdrantSearch(vector: number[], userId: string, limit: number): Promise<QdrantScoredPoint[]> {
  const body = {
    vector,
    limit,
    with_payload: true,
    filter: {
      must: [{ key: 'user_id', match: { value: userId } }],
    },
  };

  const res = await fetch(`${QDRANT_BASE}/collections/${QDRANT_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Qdrant search failed (${res.status}): ${detail}`);
  }

  const data = await res.json() as { result: QdrantScoredPoint[] };
  return data.result ?? [];
}

/** Collect all streamed text chunks from streamChat into a single string. */
async function collectStream(gen: AsyncGenerator<any>): Promise<string> {
  let text = '';
  for await (const chunk of gen) {
    if (chunk.type === 'text' || chunk.type === 'content_block_delta') {
      text += chunk.content || (chunk as any).delta?.text || '';
    }
    if (chunk.type === 'error') throw new Error(chunk.content);
    if (chunk.type === 'done') break;
  }
  return text;
}

/** Try to parse JSON from raw AI output, stripping markdown fences. */
function extractJson(raw: string): any {
  try { return JSON.parse(raw.trim()); } catch { /* fall through */ }

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ }
  }

  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return JSON.parse(brace[0]); } catch { /* fall through */ }
  }

  return null;
}

// ─── Route: POST /plagiarism/check ───────────────────────────────────────────

const PLAGIARISM_SYSTEM = `You are an academic integrity reviewer. Given a passage of text, analyse it for signs of plagiarism: verbatim copying, close paraphrasing, unusual phrasing that sounds borrowed, or unattributed ideas.

Return ONLY valid JSON — no prose, no markdown fences — matching this exact schema:
{
  "score": <integer 0-100 where 0=fully original, 100=definitely plagiarized>,
  "verdict": <"original" | "partial" | "likely_plagiarized">,
  "flagged_phrases": [
    { "text": "<exact phrase from the submitted text>", "reason": "<why this phrase is suspicious>" }
  ]
}

Guidelines:
- score < 20  → verdict = "original"
- score 20-60 → verdict = "partial"
- score > 60  → verdict = "likely_plagiarized"
- flagged_phrases should list only real concerns — return an empty array if the text is clearly original.
- Be precise and constructive; do not flag common academic phrasing unnecessarily.`;

plagiarismRoutes.post('/plagiarism/check', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const billing = await checkBilling(user.id, PLAGIARISM_MODEL);
  if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

  let body: { text?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const text = body.text?.trim();
  if (!text) return c.json({ error: '"text" is required' }, 400);
  if (text.length < 20) return c.json({ error: '"text" is too short to check (minimum 20 characters)' }, 400);

  try {
    // ── Step 1: Embed the submitted text ──────────────────────────────────────
    let vector: number[];
    try {
      vector = await embedText(text);
    } catch (err: any) {
      console.warn('[plagiarism] Embedding unavailable, skipping similarity search:', err?.message);
      vector = [];
    }

    // ── Step 2: Semantic similarity search against user's own docs ────────────
    let similar_chunks: Array<{ text: string; source: string; similarity: number }> = [];
    if (vector.length > 0) {
      try {
        const hits = await qdrantSearch(vector, user.id, 10);
        similar_chunks = hits.map((h) => ({
          text: (h.payload?.text ?? '').slice(0, 300),
          source: h.payload?.source ?? 'unknown',
          similarity: Math.round(h.score * 100) / 100,
        }));
      } catch (err: any) {
        console.warn('[plagiarism] Qdrant search failed, continuing without similarity results:', err?.message);
      }
    }

    // ── Step 3: LLM phrase analysis ───────────────────────────────────────────
    const truncated = text.slice(0, MAX_TEXT_LEN);
    const userPrompt = `Analyse the following text for plagiarism:\n\n---\n${truncated}\n---`;

    let aiScore = 0;
    let aiVerdict: 'original' | 'partial' | 'likely_plagiarized' = 'original';
    let flagged_phrases: Array<{ text: string; reason: string }> = [];

    try {
      const raw = await collectStream(
        streamChat(
          [{ role: 'user', content: userPrompt }],
          PLAGIARISM_MODEL,
          undefined,
          { systemPrompt: PLAGIARISM_SYSTEM }
        )
      );

      const parsed = extractJson(raw);
      if (parsed) {
        aiScore = typeof parsed.score === 'number'
          ? Math.max(0, Math.min(100, Math.round(parsed.score)))
          : 0;
        aiVerdict = ['original', 'partial', 'likely_plagiarized'].includes(parsed.verdict)
          ? parsed.verdict
          : aiScore < 20 ? 'original' : aiScore <= 60 ? 'partial' : 'likely_plagiarized';
        flagged_phrases = Array.isArray(parsed.flagged_phrases)
          ? parsed.flagged_phrases.filter((p: any) => p?.text && p?.reason)
          : [];
      } else {
        console.warn('[plagiarism] AI returned unparseable response, using defaults');
      }
    } catch (err: any) {
      console.error('[plagiarism] LLM call failed:', err?.message);
      // Do not hard-fail — return similarity results with a neutral score
      aiScore = 0;
      aiVerdict = 'original';
    }

    // ── Step 4: Blend similarity signal with LLM score ────────────────────────
    // If Qdrant found highly similar chunks boost the score slightly
    let finalScore = aiScore;
    if (similar_chunks.length > 0) {
      const topSimilarity = similar_chunks[0].similarity;
      if (topSimilarity > 0.92) {
        finalScore = Math.min(100, finalScore + 15);
      } else if (topSimilarity > 0.85) {
        finalScore = Math.min(100, finalScore + 7);
      }
    }

    const finalVerdict: 'original' | 'partial' | 'likely_plagiarized' =
      finalScore < 20 ? 'original' : finalScore <= 60 ? 'partial' : 'likely_plagiarized';

    console.log(`[plagiarism] user=${user.id} score=${finalScore} verdict=${finalVerdict} similar=${similar_chunks.length}`);

    return c.json({
      score: finalScore,
      verdict: finalVerdict,
      flagged_phrases,
      similar_chunks,
    });
  } catch (err: any) {
    console.error('[plagiarism/check] Unexpected error:', err?.message || err);
    return c.json({ error: 'Plagiarism check failed', detail: err?.message }, 500);
  }
});
