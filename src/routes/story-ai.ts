/** Writer Story Engine — AI generation endpoints.
 *
 * POST /story/scenes/:sceneId/generate  — generate scene prose from context
 * POST /story/universes/:id/expand      — expand universe (logline, structure ideas)
 *
 * Uses streamChat (LiteLLM proxy → direct provider fallback).
 * Returns generated text as JSON (client decides whether to save).
 */
import { Hono } from 'hono';
import { query, query as neonQuery } from '../services/neon';
import { getUser } from '../middleware/auth';
import { deductAiCredits } from '../services/credits';
import { streamChat } from '../services/ai-router';
import { buildWriterContext } from '../services/writer-context-builder';

async function checkAndDeductCredits(userId: string, cost: number, purpose: string): Promise<string | null> {
  const result = await neonQuery('SELECT ai_credits FROM profiles WHERE id = $1 LIMIT 1', [userId]);
  const profile = result.rows[0];
  if (profile && profile.ai_credits < cost) return 'Insufficient credits. Top up at app.dirgha.ai/credits';
  await deductAiCredits(userId, cost, purpose).catch(console.error);
  return null;
}

export const storyAiRoutes = new Hono();

const DEFAULT_MODEL = 'claude-sonnet-4-6';

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

// ── POST /story/scenes/:sceneId/generate ──────────────────────────────────────
storyAiRoutes.post('/story/scenes/:sceneId/generate', async (c) => {
  const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const sceneId = c.req.param('sceneId');

  // Load scene + act + universe for context
  const { rows } = await query(
    `SELECT ss.*, sa.act_number, sa.title AS act_title, sa.summary AS act_summary,
            sa.beat_sheet, sa.universe_id, su.title AS universe_title, su.logline, su.genre
     FROM story_scenes ss
     JOIN story_acts sa ON sa.id = ss.act_id
     JOIN story_universes su ON su.id = sa.universe_id
     WHERE ss.id = $1 AND su.user_id = $2`,
    [sceneId, user.id]
  );
  if (!rows[0]) return c.json({ error: 'Scene not found' }, 404);
  const scene = rows[0];

  // Load entities for this universe
  const { rows: entities } = await query(
    `SELECT name, type, arc FROM story_entities
     WHERE universe_id IN (
       SELECT su.id FROM story_scenes ss JOIN story_acts sa ON sa.id=ss.act_id JOIN story_universes su ON su.id=sa.universe_id WHERE ss.id=$1
     )`,
    [sceneId]
  );

  const characters = entities.filter((e: any) => e.type === 'character').map((e: any) => `${e.name}${e.arc ? ` (arc: ${e.arc})` : ''}`);

  const { style = 'prose', tone = 'cinematic', length = 'medium' } = await c.req.json<any>().catch(() => ({}));
  const wordTarget = length === 'short' ? '100-200' : length === 'long' ? '400-600' : '200-350';

  const systemPrompt = `You are an AI writing assistant specializing in story and screenplay writing.
Write vivid, character-driven prose. Be specific, sensory, and true to the established tone.`;

  const userMsg = `Universe: "${scene.universe_title}"
Genre: ${scene.genre?.join(', ') || 'unspecified'}
Logline: ${scene.logline || 'not provided'}

Act ${scene.act_number}${scene.act_title ? ` — ${scene.act_title}` : ''}: ${scene.act_summary || 'no summary'}

Characters: ${characters.length ? characters.join(', ') : 'unspecified'}
Scene location: ${scene.location || 'unspecified'}
Scene characters: ${scene.characters?.join(', ') || 'none specified'}
Existing notes: ${scene.notes || 'none'}

Write a ${style === 'screenplay' ? 'screenplay-formatted' : 'prose'} scene in a ${tone} tone.
Target: ${wordTarget} words. Write only the scene content — no titles, headers, or explanations.`;

  const creditErr = await checkAndDeductCredits(user.id, 1, `StoryGen: scene ${sceneId}`);
  if (creditErr) return c.json({ error: creditErr, code: 'INSUFFICIENT_CREDITS' }, 402);

  // Build rich project context for the AI call
  const writerContext = await buildWriterContext({
    userId: user.id,
    prompt: userMsg,
    universeId: scene.universe_id,
  });

  try {
    const content = await collectStream(streamChat([{ role: 'user', content: userMsg }], DEFAULT_MODEL, writerContext || undefined, { systemPrompt }));
    return c.json({ content, scene_id: sceneId, model: DEFAULT_MODEL });
  } catch (err: any) {
    return c.json({ error: err.message || 'AI generation failed' }, 500);
  }
});

// ── POST /story/universes/:id/expand ─────────────────────────────────────────
storyAiRoutes.post('/story/universes/:id/expand', async (c) => {
  const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');

  const { rows: [u] } = await query(`SELECT * FROM story_universes WHERE id=$1 AND user_id=$2`, [id, user.id]);
  if (!u) return c.json({ error: 'Universe not found' }, 404);

  const { rows: entities } = await query(`SELECT name, type FROM story_entities WHERE universe_id=$1`, [id]);
  const chars = entities.filter((e: any) => e.type === 'character').map((e: any) => e.name);

  const systemPrompt = `You are a story development consultant. Help develop story universes with compelling structure and themes.`;
  const userMsg = `Universe: "${u.title}"
Current logline: ${u.logline || 'none'}
Genre: ${u.genre?.join(', ') || 'unspecified'}
Characters: ${chars.join(', ') || 'none'}

Provide story development suggestions as JSON with these fields:
{
  "logline": "improved 1-sentence logline",
  "themes": ["theme1", "theme2", "theme3"],
  "act_structure": [{"act": 1, "title": "", "summary": ""}, {"act": 2, "title": "", "summary": ""}, {"act": 3, "title": "", "summary": ""}],
  "tone_suggestions": ["tone1", "tone2"],
  "similar_works": ["reference1", "reference2"]
}
Return ONLY valid JSON, no markdown.`;

  const creditErr = await checkAndDeductCredits(user.id, 1, `StoryExpand: universe ${id}`);
  if (creditErr) return c.json({ error: creditErr, code: 'INSUFFICIENT_CREDITS' }, 402);

  // Build rich project context for the AI call
  const writerContext = await buildWriterContext({
    userId: user.id,
    prompt: userMsg,
    universeId: id,
  });

  try {
    const raw = await collectStream(streamChat([{ role: 'user', content: userMsg }], DEFAULT_MODEL, writerContext || undefined, { systemPrompt }));
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const suggestions = JSON.parse(cleaned);
    return c.json({ suggestions, universe_id: id });
  } catch (err: any) {
    return c.json({ error: err.message || 'AI expansion failed' }, 500);
  }
});
