/**
 * Writer Scientist — research, outline, draft pipeline
 *
 * POST /scientist/research  — search OpenAlex for papers by topic
 * POST /scientist/outline   — generate a structured academic outline from papers
 * POST /scientist/draft     — stream a full draft via SSE
 *
 * Swap providers: change searchPapers() to Semantic Scholar / Tavily,
 * change the model string in generateOutline() / draft, or replace
 * streamChat with any OpenAI-compatible generator.
 *
 * @module writer/scientist
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getUser } from '../middleware/auth';
import { checkBilling } from '../middleware/billing-guard';
import { streamChat, type ChatMessage, type StreamChunk } from '../services/ai-router';
import { buildWriterContext } from '../services/writer-context-builder';

export const scientistRoutes = new Hono();

// Use groq as default — it is the most reliably available provider on this server.
// claude-sonnet-4-6 can be used as an override via body.model once an Anthropic key is live.
const DEFAULT_MODEL = 'groq/llama-3.3-70b-versatile';

// ── Provider: Paper Search (swap to Semantic Scholar, Tavily, etc.) ──────────

interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  doi: string | null;
  cited_by_count: number;
}

/**
 * Reconstruct an abstract from OpenAlex's inverted index format.
 * The API stores abstracts as `{ "word": [pos1, pos2], ... }`.
 * We rebuild the original text by placing each word at its positions.
 */
function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null | undefined,
  maxChars = 300,
): string {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';

  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);

  const full = words.map(([, w]) => w).join(' ');
  if (full.length <= maxChars) return full;
  return full.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
}

async function searchPapers(topic: string): Promise<Paper[]> {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', topic);
  url.searchParams.set('per_page', '10');
  url.searchParams.set('sort', 'relevance_score:desc');
  url.searchParams.set('mailto', 'hello@dirgha.ai');

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    console.error('[scientist/research] OpenAlex error:', res.status, await res.text().catch(() => ''));
    return [];
  }

  const data = await res.json() as { results?: any[] };
  if (!Array.isArray(data.results)) return [];

  return data.results.map((work: any) => ({
    id: work.id ?? '',
    title: work.title ?? 'Untitled',
    authors: (work.authorships ?? [])
      .slice(0, 3)
      .map((a: any) => a.author?.display_name ?? 'Unknown'),
    year: work.publication_year ?? null,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    doi: work.doi ?? null,
    cited_by_count: work.cited_by_count ?? 0,
  }));
}

// ── Provider: Outline Generation (swap model via streamChat) ─────────────────

function buildPaperContext(papers: Paper[]): string {
  if (!papers || papers.length === 0) return 'No papers provided.';
  return papers
    .map((p, i) => {
      const authors = p.authors.join(', ') || 'Unknown';
      const year = p.year ?? 'n.d.';
      const cite = p.cited_by_count > 0 ? ` [cited ${p.cited_by_count}×]` : '';
      const abs = p.abstract ? `\n    ${p.abstract}` : '';
      return `${i + 1}. "${p.title}" (${year}) by ${authors}${cite}${abs}`;
    })
    .join('\n');
}

/** Collect a streamChat generator into a plain string. */
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

async function generateOutline(
  topic: string,
  papers: Paper[],
  model = DEFAULT_MODEL,
  additionalContext?: string,
): Promise<string> {
  const paperContext = buildPaperContext(papers);

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        `Generate a detailed academic paper outline for: ${topic}`,
        '',
        'Relevant papers:',
        paperContext,
        '',
        'Output a structured outline with the following sections:',
        '- Abstract (brief summary of scope and contribution)',
        '- 1. Introduction (problem statement, motivation, research questions)',
        '- 2. Literature Review (key themes from the papers above)',
        '- 3. Methods (proposed methodology)',
        '- 4. Results (expected results structure)',
        '- 5. Discussion (interpretation, implications, limitations)',
        '- 6. Conclusion (summary and future work)',
        '- References (list the papers cited above)',
        '',
        'Under each section include 2-4 bullet points describing what to cover.',
      ].join('\n'),
    },
  ];

  const gen = streamChat(messages, model, additionalContext, {
    systemPrompt:
      'You are a scientific writing assistant. Generate clear, structured academic paper outlines. Be specific and actionable — each bullet should tell the writer exactly what to write.',
    temperature: 0.4,
  });

  return collectStream(gen);
}

// ── Route 1: POST /scientist/research ────────────────────────────────────────

scientistRoutes.post('/scientist/research', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { topic?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const topic = body.topic?.trim();
  if (!topic) {
    return c.json({ error: 'topic is required' }, 400);
  }

  try {
    const papers = await searchPapers(topic);
    return c.json({ papers, webContext: [] });
  } catch (err: any) {
    console.error('[scientist/research] Error:', err);
    return c.json({ error: 'Paper search failed', detail: err.message }, 502);
  }
});

// ── Route 2: POST /scientist/outline ─────────────────────────────────────────

scientistRoutes.post('/scientist/outline', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { topic?: string; papers?: Paper[]; model?: string; documentId?: string; projectId?: string; manuscriptId?: string; universeId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const topic = body.topic?.trim();
  if (!topic) {
    return c.json({ error: 'topic is required' }, 400);
  }

  const papers: Paper[] = Array.isArray(body.papers) ? body.papers : [];
  const model = body.model || DEFAULT_MODEL;

  const billing = await checkBilling(user.id, model);
  if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

  const writerContext = await buildWriterContext({
    userId: user.id,
    prompt: topic,
    documentId: body.documentId,
    projectId: body.projectId,
    manuscriptId: body.manuscriptId,
    universeId: body.universeId,
  });

  try {
    const outline = await generateOutline(topic, papers, model, writerContext || undefined);
    return c.json({ outline });
  } catch (err: any) {
    console.error('[scientist/outline] Error:', err);
    return c.json({ error: 'Outline generation failed', detail: err.message }, 502);
  }
});

// ── Route 3: POST /scientist/draft (SSE streaming) ──────────────────────────

scientistRoutes.post('/scientist/draft', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { topic?: string; outline?: string; papers?: Paper[]; model?: string; documentId?: string; projectId?: string; manuscriptId?: string; universeId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const topic = body.topic?.trim();
  const outline = body.outline?.trim();
  if (!topic) return c.json({ error: 'topic is required' }, 400);
  if (!outline) return c.json({ error: 'outline is required' }, 400);

  const papers: Paper[] = Array.isArray(body.papers) ? body.papers : [];
  const model = body.model || DEFAULT_MODEL;
  const paperContext = buildPaperContext(papers);

  const billing = await checkBilling(user.id, model);
  if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

  const writerContext = await buildWriterContext({
    userId: user.id,
    prompt: topic,
    documentId: body.documentId,
    projectId: body.projectId,
    manuscriptId: body.manuscriptId,
    universeId: body.universeId,
  });

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        `Write a complete academic paper draft on: ${topic}`,
        '',
        '## Outline to follow:',
        outline,
        '',
        '## Reference papers:',
        paperContext,
        '',
        '## Instructions:',
        '- Write in formal academic prose with clear topic sentences.',
        '- Cite the reference papers inline where relevant (Author, Year).',
        '- Include a References section at the end.',
        '- Use Markdown formatting (## for sections, **bold** for emphasis).',
        '- Target 2000-3000 words for the full draft.',
        '- Each section should flow logically from the outline.',
      ].join('\n'),
    },
  ];

  return streamSSE(c, async (stream) => {
    try {
      const gen = streamChat(messages, model, writerContext || undefined, {
        systemPrompt:
          'You are a scientific writing assistant producing a complete academic paper draft. Write clearly, cite sources, use formal tone. Output in Markdown.',
        temperature: 0.5,
      });

      for await (const chunk of gen) {
        if (chunk.type === 'text' || chunk.type === 'content_block_delta') {
          const text = chunk.content || (chunk as any).delta?.text || '';
          if (text) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'text', content: text }),
              event: 'message',
            });
          }
        } else if (chunk.type === 'error') {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'error', content: chunk.content }),
            event: 'message',
          });
          break;
        } else if (chunk.type === 'done') {
          break;
        }
      }

      await stream.writeSSE({
        data: JSON.stringify({ type: 'done' }),
        event: 'message',
      });
    } catch (err: any) {
      console.error('[scientist/draft] Stream error:', err);
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', content: err.message || 'Draft generation failed' }),
        event: 'message',
      });
    }
  });
});
