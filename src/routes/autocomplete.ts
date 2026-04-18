/**
 * Writer Autocomplete — ghost text completion at cursor
 * Swap provider: change generateCompletion() to use any LLM
 * @module writer/autocomplete
 */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { streamChat } from '../services/ai-router';
import { buildWriterContext } from '../services/writer-context-builder';
import { checkBilling } from '../middleware/billing-guard';

export const autocompleteRoutes = new Hono();

// ── Swappable Provider ──────────────────────────────────────────────────────

const AUTOCOMPLETE_MODEL = 'groq/llama-3.3-70b-versatile';

const SYSTEM_PROMPT =
  'You are an autocomplete engine. Output ONLY continuation text. No quotes, no prefixes.';

async function generateCompletion(
  context: string,
  maxTokens: number,
  additionalContext?: string,
): Promise<string> {
  const gen = streamChat(
    [
      {
        role: 'user',
        content: `Continue this text naturally with 1-2 sentences. Output ONLY the continuation:\n\n${context}`,
      },
    ],
    AUTOCOMPLETE_MODEL,
    additionalContext,
    { systemPrompt: SYSTEM_PROMPT, temperature: 0.3 },
  );

  let text = '';
  for await (const chunk of gen) {
    if (chunk.type === 'text') {
      text += chunk.content || '';
    }
    if (chunk.type === 'error') {
      throw new Error(chunk.content || 'LLM stream error');
    }
  }

  const charLimit = maxTokens * 4;
  return text.trim().slice(0, charLimit);
}

// ── Route ───────────────────────────────────────────────────────────────────

autocompleteRoutes.post('/autocomplete', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const billing = await checkBilling(user.id, AUTOCOMPLETE_MODEL);
    if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

    const body = await c.req.json<{ context?: string; max_tokens?: number; documentId?: string; projectId?: string; manuscriptId?: string; universeId?: string }>();

    if (!body.context || typeof body.context !== 'string' || body.context.trim().length === 0) {
      return c.json({ error: 'context is required and must be a non-empty string' }, 400);
    }

    const maxTokens = Math.min(Math.max(body.max_tokens ?? 64, 1), 256);
    const trimmedContext = body.context.slice(-500);

    const writerContext = await buildWriterContext({
      userId: user.id,
      prompt: trimmedContext,
      documentId: body.documentId,
      projectId: body.projectId,
      manuscriptId: body.manuscriptId,
      universeId: body.universeId,
    });

    const completion = await generateCompletion(trimmedContext, maxTokens, writerContext || undefined);

    return c.json({ completion });
  } catch (err: any) {
    console.error('[writer/autocomplete]', err?.message || err);
    return c.json({ error: 'Autocomplete failed' }, 500);
  }
});
