/** Writer — Evaluation routes for writing project items.
 *
 * POST   /projects/:projectId/items/:itemId/evaluate
 *   → Trigger AI evaluation; store + return result.
 *
 * GET    /projects/:projectId/items/:itemId/evaluations
 *   → Fetch the latest stored evaluation (or null).
 *
 * PATCH  /projects/:projectId/items/:itemId/evaluations/comments/:commentId/addressed
 *   → Mark a comment as addressed (stub — JSONB update).
 */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { checkBilling } from '../middleware/billing-guard';
import { query } from '../services/neon';
import { streamChat } from '../services/ai-router';

export const evaluationRoutes = new Hono();

// ── helpers ──────────────────────────────────────────────────────────────────

/** Verify user owns the project AND the item belongs to it. Returns item row or null. */
async function verifyItemOwnership(projectId: string, itemId: string, userId: string) {
  const { rows: [project] } = await query(
    'SELECT id FROM writing_projects WHERE id=$1 AND user_id=$2',
    [projectId, userId]
  );
  if (!project) return null;
  const { rows: [item] } = await query(
    'SELECT * FROM writing_project_items WHERE id=$1 AND project_id=$2',
    [itemId, projectId]
  );
  return item ?? null;
}

async function collectStream(gen: AsyncGenerator<any>): Promise<string> {
  let text = '';
  for await (const chunk of gen) {
    if (chunk.type === 'text' || chunk.type === 'content_block_delta') {
      text += chunk.content || chunk.delta?.text || '';
    }
    if (chunk.type === 'error') throw new Error(chunk.content);
  }
  return text;
}

/** Try to extract a JSON object from raw AI text (handles markdown fences). */
function extractJson(raw: string): any {
  // Try direct parse first
  try { return JSON.parse(raw.trim()); } catch { /* fall through */ }

  // Strip markdown code fences if present
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ }
  }

  // Try to grab the first {...} block
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return JSON.parse(brace[0]); } catch { /* fall through */ }
  }

  return null;
}

const EVAL_SYSTEM = `You are a writing evaluation council composed of four expert readers:
story_editor (narrative structure), character_coach (character depth), first_reader (engagement/pacing), genre_expert (genre conventions).

Evaluate the provided text and return ONLY valid JSON — no prose, no markdown fences, no explanation.
The JSON must exactly follow this schema:
{
  "composite_score": <number 0-10, one decimal place>,
  "process_score": <number 0-10, one decimal place>,
  "evaluators_run": ["story_editor", "character_coach", "first_reader", "genre_expert"],
  "comments": [
    {
      "id": "<uuid-style string>",
      "evaluator": "<story_editor|character_coach|first_reader|genre_expert>",
      "severity": "<critical|moderate|minor>",
      "dimension": "<structure|clarity|engagement|voice|pacing>",
      "quote": "<verbatim excerpt from text, or empty string>",
      "description": "<what the issue is>",
      "suggestion": "<concrete fix>"
    }
  ],
  "scores": [
    {
      "evaluator": "<name>",
      "composite_score": <number>,
      "dimension_scores": {
        "structure": <0-10>,
        "clarity": <0-10>,
        "engagement": <0-10>,
        "voice": <0-10>,
        "pacing": <0-10>
      }
    }
  ],
  "consensus": [
    {
      "issue": "<summary of agreed issue>",
      "severity": "<critical|moderate|minor>",
      "agreement_level": <0.0-1.0>,
      "evaluators": ["<name>", ...],
      "dimension": "<dimension>"
    }
  ]
}

Score 0-10 where 10 = publication-ready, 5 = solid draft, 3 = needs significant revision.
Provide at least 2 comments and 1 consensus item. Be specific and constructive.`;

// ── POST /evaluate — direct text evaluation (no project/item required) ────────
evaluationRoutes.post('/evaluate', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const billing = await checkBilling(user.id, 'kimi-k2');
    if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

    const body = await c.req.json().catch(() => ({}));
    const text: string = body?.text || body?.content || '';
    if (!text.trim()) return c.json({ error: 'No text provided to evaluate' }, 422);

    const userPrompt = `Please evaluate the following writing:\n\n---\n${text.slice(0, 6000)}\n---`;
    let raw = '';
    try {
      raw = await collectStream(
        streamChat(
          [{ role: 'user', content: userPrompt }],
          'kimi-k2',
          undefined,
          { systemPrompt: EVAL_SYSTEM }
        )
      );
    } catch (err: any) {
      return c.json({ error: 'AI evaluation service unavailable', detail: err.message }, 502);
    }

    const parsed = extractJson(raw);
    if (!parsed) return c.json({ error: 'AI returned unparseable response — please retry' }, 502);

    return c.json({ evaluation: parsed }, 200);
  } catch (err) {
    console.error('[evaluations/direct] error:', err);
    return c.json({ error: 'Evaluation failed' }, 500);
  }
});

// ── POST /projects/:projectId/items/:itemId/evaluate ─────────────────────────
evaluationRoutes.post('/projects/:projectId/items/:itemId/evaluate', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const billing = await checkBilling(user.id, 'kimi-k2');
    if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

    const projectId = c.req.param('projectId');
    const itemId = c.req.param('itemId');

    const item = await verifyItemOwnership(projectId, itemId, user.id).catch(() => null);
    if (!item) return c.json({ error: 'Not found' }, 404);

    const content: string = item.content || '';
    if (!content.trim()) {
      return c.json({ error: 'Item has no content to evaluate' }, 422);
    }

    const userPrompt = `Please evaluate the following writing:\n\n---\n${content.slice(0, 6000)}\n---`;

    let raw = '';
    try {
      raw = await collectStream(
        streamChat(
          [{ role: 'user', content: userPrompt }],
          'kimi-k2',
          undefined,
          { systemPrompt: EVAL_SYSTEM }
        )
      );
    } catch (err: any) {
      console.error('[evaluations] AI call failed:', err.message);
      return c.json({ error: 'AI evaluation service unavailable', detail: err.message }, 502);
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      console.error('[evaluations] Could not parse AI response:', raw.slice(0, 500));
      return c.json({ error: 'AI returned unparseable response — please retry' }, 502);
    }

    const compositeScore = typeof parsed.composite_score === 'number' ? parsed.composite_score : null;
    const processScore = typeof parsed.process_score === 'number' ? parsed.process_score : null;
    const evaluatorsRun: string[] = Array.isArray(parsed.evaluators_run)
      ? parsed.evaluators_run
      : ['story_editor', 'character_coach', 'first_reader', 'genre_expert'];
    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    const scores = Array.isArray(parsed.scores) ? parsed.scores : [];
    const consensus = Array.isArray(parsed.consensus) ? parsed.consensus : [];

    const { rows: [evaluation] } = await query(
      `INSERT INTO writing_item_evaluations
         (item_id, project_id, composite_score, process_score, evaluators_run,
          comments, scores, consensus, full_results)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        itemId,
        projectId,
        compositeScore,
        processScore,
        evaluatorsRun,
        JSON.stringify(comments),
        JSON.stringify(scores),
        JSON.stringify(consensus),
        JSON.stringify(parsed),
      ]
    );

    return c.json({ evaluation }, 201);
  } catch (err) {
    console.error('[evaluations/evaluate] error:', err);
    return c.json({ error: 'Evaluation failed' }, 500);
  }
});

// ── GET /projects/:projectId/items/:itemId/evaluations ───────────────────────
evaluationRoutes.get('/projects/:projectId/items/:itemId/evaluations', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const projectId = c.req.param('projectId');
    const itemId = c.req.param('itemId');

    const item = await verifyItemOwnership(projectId, itemId, user.id).catch(() => null);
    if (!item) return c.json({ error: 'Not found' }, 404);

    const { rows: [evaluation] } = await query(
      `SELECT * FROM writing_item_evaluations
       WHERE item_id=$1
       ORDER BY created_at DESC
       LIMIT 1`,
      [itemId]
    );

    if (!evaluation) return c.json({ evaluation: null });
    return c.json({ evaluation });
  } catch (err) {
    console.error('[evaluations/list] error:', err);
    return c.json({ error: 'Failed to fetch evaluations' }, 500);
  }
});

// ── PATCH /projects/:projectId/items/:itemId/evaluations/comments/:commentId/addressed
evaluationRoutes.patch(
  '/projects/:projectId/items/:itemId/evaluations/comments/:commentId/addressed',
  async (c) => {
    try {
      const user = await getUser(c);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const projectId = c.req.param('projectId');
      const itemId = c.req.param('itemId');

      const item = await verifyItemOwnership(projectId, itemId, user.id).catch(() => null);
      if (!item) return c.json({ error: 'Not found' }, 404);

      // Stub: JSONB comment addressed update is a future implementation.
      // The frontend only needs ok: true to toggle the UI state.
      return c.json({ ok: true });
    } catch (err) {
      console.error('[evaluations/address-comment] error:', err);
      return c.json({ error: 'Failed to address comment' }, 500);
    }
  }
);
