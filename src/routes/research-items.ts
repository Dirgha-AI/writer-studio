/** Writer — Research search + notes for binder items.
 *
 * POST /projects/:projectId/items/:itemId/research/search
 *   — Search web, academic, and project sources; synthesise; persist note.
 * GET  /projects/:projectId/items/:itemId/research
 *   — List saved research notes for an item.
 * DELETE /projects/:projectId/items/:itemId/research/:noteId
 *   — Delete a note.
 */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { checkBilling } from '../middleware/billing-guard';
import { query as neonQuery } from '../services/neon';
import { streamChat } from '../services/ai-router';

export const researchItemRoutes = new Hono();

const DEFAULT_MODEL = 'kimi-k2';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Collect a streamChat generator into a plain string. */
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

/** Verify the user owns the project and the item belongs to it. */
async function checkOwnership(
  projectId: string,
  itemId: string,
  userId: string
): Promise<boolean> {
  const r = await neonQuery(
    `SELECT wpi.id
     FROM writing_project_items wpi
     JOIN writing_projects wp ON wp.id = wpi.project_id
     WHERE wpi.id = $1 AND wpi.project_id = $2 AND wp.user_id = $3`,
    [itemId, projectId, userId]
  );
  return r.rows.length > 0;
}

/** Unified result shape returned from every source. */
interface ResearchResult {
  title: string;
  url?: string;
  snippet: string;
  source: string;
}

// ── source fetchers ───────────────────────────────────────────────────────────

async function fetchWebResults(searchQuery: string): Promise<ResearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: searchQuery,
        max_results: 5,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    return (data.results || []).map((r: any) => ({
      title: r.title || '',
      url: r.url || undefined,
      snippet: r.content || r.snippet || '',
      source: 'web',
    }));
  } catch {
    return [];
  }
}

async function fetchAcademicResults(searchQuery: string): Promise<ResearchResult[]> {
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(searchQuery)}&per_page=5&select=title,doi,abstract_inverted_index,primary_location`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Dirgha-Writer/1.0 (dirgha.ai)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    return (data.results || []).map((r: any) => {
      // Reconstruct abstract from inverted index if available
      let snippet = '';
      if (r.abstract_inverted_index) {
        const wordPositions: { word: string; pos: number }[] = [];
        for (const [word, positions] of Object.entries(r.abstract_inverted_index as Record<string, number[]>)) {
          for (const pos of positions) {
            wordPositions.push({ word, pos });
          }
        }
        snippet = wordPositions
          .sort((a, b) => a.pos - b.pos)
          .slice(0, 60)
          .map((x) => x.word)
          .join(' ');
      }
      const doiUrl = r.doi ? `https://doi.org/${r.doi.replace('https://doi.org/', '')}` : undefined;
      return {
        title: r.title || 'Untitled',
        url: doiUrl,
        snippet: snippet || 'No abstract available.',
        source: 'academic',
      };
    });
  } catch {
    return [];
  }
}

async function fetchProjectResults(
  searchQuery: string,
  projectId: string
): Promise<ResearchResult[]> {
  try {
    const r = await neonQuery(
      `SELECT id, title, content
       FROM writing_project_items
       WHERE project_id = $1 AND content ILIKE $2
       LIMIT 5`,
      [projectId, `%${searchQuery}%`]
    );
    return r.rows.map((row: any) => ({
      title: row.title,
      snippet: (row.content || '').slice(0, 200),
      source: 'project',
    }));
  } catch {
    return [];
  }
}

// ── POST /projects/:projectId/items/:itemId/research/search ──────────────────

researchItemRoutes.post('/projects/:projectId/items/:itemId/research/search', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const projectId = c.req.param('projectId');
    const itemId = c.req.param('itemId');

    const owned = await checkOwnership(projectId, itemId, user.id).catch(() => false);
    if (!owned) return c.json({ error: 'Not found' }, 404);

    const rawBody = await c.req.json<{ query: string; sources?: string[] }>().catch(() => ({ query: '' }));
    const body: { query: string; sources?: string[] } = rawBody;
    const searchQuery = body.query?.trim();
    if (!searchQuery) return c.json({ error: 'query is required' }, 400);

    const billing = await checkBilling(user.id, DEFAULT_MODEL);
    if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

    const sources = body.sources && body.sources.length > 0
      ? body.sources
      : ['web'];

    // Fetch all requested sources in parallel; each is independently try/catched
    const [webResults, academicResults, projectResults] = await Promise.all([
      sources.includes('web') ? fetchWebResults(searchQuery) : Promise.resolve([]),
      sources.includes('academic') ? fetchAcademicResults(searchQuery) : Promise.resolve([]),
      sources.includes('project') ? fetchProjectResults(searchQuery, projectId) : Promise.resolve([]),
    ]);

    const results: ResearchResult[] = [...webResults, ...academicResults, ...projectResults];

    // Generate synthesis — don't block the response if AI fails
    let synthesis = '';
    if (results.length > 0) {
      try {
        const summary = results
          .slice(0, 8)
          .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`)
          .join('\n\n');
        const prompt = `Synthesize these research findings into a brief paragraph relevant to creative/academic writing:\n\n${summary}`;
        synthesis = await collectStream(
          streamChat([{ role: 'user', content: prompt }], DEFAULT_MODEL, undefined, {
            systemPrompt: 'You are a research assistant. Write a concise 2-3 sentence synthesis of the findings below.',
          })
        );
      } catch (e) {
        console.error('[research-items] synthesis failed:', e);
        synthesis = '';
      }
    }

    // Persist the note
    const nr = await neonQuery(
      `INSERT INTO writing_research_notes (item_id, project_id, query, source_type, results, synthesis)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [itemId, projectId, searchQuery, sources.join(','), JSON.stringify(results), synthesis]
    );

    return c.json({ noteId: nr.rows[0].id, results, synthesis }, 201);
  } catch (err) {
    console.error('[research-items/search] error:', err);
    return c.json({ error: 'Research search failed' }, 500);
  }
});

// ── GET /projects/:projectId/items/:itemId/research ──────────────────────────

researchItemRoutes.get('/projects/:projectId/items/:itemId/research', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const projectId = c.req.param('projectId');
    const itemId = c.req.param('itemId');

    const owned = await checkOwnership(projectId, itemId, user.id).catch(() => false);
    if (!owned) return c.json({ error: 'Not found' }, 404);

    const r = await neonQuery(
      `SELECT * FROM writing_research_notes
       WHERE item_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT 20`,
      [itemId, projectId]
    );

    return c.json({ notes: r.rows });
  } catch (err) {
    console.error('[research-items/list] error:', err);
    return c.json({ error: 'Failed to fetch research notes' }, 500);
  }
});

// ── DELETE /projects/:projectId/items/:itemId/research/:noteId ───────────────

researchItemRoutes.delete('/projects/:projectId/items/:itemId/research/:noteId', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const projectId = c.req.param('projectId');
    const itemId = c.req.param('itemId');
    const noteId = c.req.param('noteId');

    const owned = await checkOwnership(projectId, itemId, user.id).catch(() => false);
    if (!owned) return c.json({ error: 'Not found' }, 404);

    await neonQuery(
      `DELETE FROM writing_research_notes WHERE id = $1 AND item_id = $2 AND project_id = $3`,
      [noteId, itemId, projectId]
    );

    return c.json({ ok: true });
  } catch (err) {
    console.error('[research-items/delete] error:', err);
    return c.json({ error: 'Failed to delete research note' }, 500);
  }
});
