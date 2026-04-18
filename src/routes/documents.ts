/** Writer — Document CRUD (Neon direct queries, migrated from Supabase REST). */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { query as neonQuery } from '../services/neon';
import { indexUserDoc } from '../services/user-docs';

export const documentsRoutes = new Hono();

// Existing table uses: user_id (not user_id), doc_type (not doc_type), no deleted_at
const INIT_SQL = `
  ALTER TABLE writer_documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
`;
let ready = false;
async function ensureSchema() {
  if (ready) return;
  try { await neonQuery(INIT_SQL, []); } catch {}
  ready = true;
}

const normalise = (d: any) => ({
  id: d.id,
  title: d.title || 'Untitled',
  content: d.content || '',
  excerpt: d.content ? String(d.content).replace(/<[^>]*>/g, '').slice(0, 160) : '',
  type: d.metadata?.docType || 'other',
  status: d.metadata?.status || 'draft',
  word_count: d.metadata?.wordCount || 0,
  folder_id: d.metadata?.folderId || null,
  is_favorite: d.metadata?.isFavorite || false,
  created_at: d.created_at,
  updated_at: d.updated_at,
});

documentsRoutes.get('/documents', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const r = await neonQuery(
    `SELECT * FROM writer_documents WHERE user_id = $1 AND doc_type = 'tiptap' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100`,
    [user.id]
  ).catch(() => ({ rows: [] }));
  return c.json(r.rows.map(normalise));
});

documentsRoutes.get('/documents/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const r = await neonQuery(
    `SELECT * FROM writer_documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [c.req.param('id'), user.id]
  );
  if (!r.rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json(normalise(r.rows[0]));
});

documentsRoutes.post('/documents', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const { title, content, type, folder_id } = await c.req.json();
  const metadata = { docType: type || 'other', status: 'draft', isWriterDraft: true, folderId: folder_id || null, isFavorite: false };
  const r = await neonQuery(
    `INSERT INTO writer_documents (user_id, title, content, doc_type, metadata) VALUES ($1, $2, $3, 'tiptap', $4) RETURNING *`,
    [user.id, title || 'Untitled Document', content || '', JSON.stringify(metadata)]
  );
  const doc = r.rows[0]
  // Fire-and-forget: index new doc into user's private Qdrant collection
  if (doc && content) {
    indexUserDoc(user.id, doc.id, doc.title || 'Untitled Document', content).catch(() => {})
  }
  return c.json(normalise(doc), 201);
});

documentsRoutes.patch('/documents/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const id = c.req.param('id');
  const updates = await c.req.json();
  const sets: string[] = ['updated_at = NOW()'];
  const vals: any[] = [];
  let idx = 1;
  if (updates.title !== undefined) { sets.push(`title = $${idx}`); vals.push(updates.title); idx++; }
  if (updates.content !== undefined) { sets.push(`content = $${idx}`); vals.push(updates.content); idx++; }
  if (updates.type || updates.status || updates.is_favorite !== undefined || updates.word_count !== undefined) {
    const cur = await neonQuery(`SELECT metadata FROM writer_documents WHERE id = $1 AND user_id = $2`, [id, user.id]);
    const meta = cur.rows[0]?.metadata || {};
    if (updates.type) meta.docType = updates.type;
    if (updates.status) meta.status = updates.status;
    if (updates.is_favorite !== undefined) meta.isFavorite = updates.is_favorite;
    if (updates.word_count !== undefined) meta.wordCount = updates.word_count;
    sets.push(`metadata = $${idx}`); vals.push(JSON.stringify(meta)); idx++;
  }
  vals.push(id, user.id);
  const r = await neonQuery(
    `UPDATE writer_documents SET ${sets.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`,
    vals
  );
  if (!r.rows[0]) return c.json({ error: 'Not found' }, 404);
  const updated = r.rows[0]
  // Fire-and-forget: re-index if content changed
  if (updates.content !== undefined) {
    indexUserDoc(user.id, id, updated.title || 'Untitled', updates.content).catch(() => {})
  }
  return c.json({ ok: true, document: normalise(updated) });
});

documentsRoutes.delete('/documents/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  await neonQuery(
    `UPDATE writer_documents SET deleted_at = NOW() WHERE id = $1 AND user_id = $2`,
    [c.req.param('id'), user.id]
  );
  return c.json({ ok: true });
});

// PUT alias for PATCH — some clients use PUT for full updates
documentsRoutes.put('/documents/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const id = c.req.param('id');
  const updates = await c.req.json();
  const sets: string[] = ['updated_at = NOW()'];
  const vals: any[] = [];
  let idx = 1;
  if (updates.title !== undefined) { sets.push(`title = $${idx}`); vals.push(updates.title); idx++; }
  if (updates.content !== undefined) { sets.push(`content = $${idx}`); vals.push(updates.content); idx++; }
  if (updates.type || updates.status || updates.is_favorite !== undefined || updates.word_count !== undefined) {
    const cur = await neonQuery(`SELECT metadata FROM writer_documents WHERE id = $1 AND user_id = $2`, [id, user.id]);
    const meta = cur.rows[0]?.metadata || {};
    if (updates.type) meta.docType = updates.type;
    if (updates.status) meta.status = updates.status;
    if (updates.is_favorite !== undefined) meta.isFavorite = updates.is_favorite;
    if (updates.word_count !== undefined) meta.wordCount = updates.word_count;
    sets.push(`metadata = $${idx}`); vals.push(JSON.stringify(meta)); idx++;
  }
  vals.push(id, user.id);
  const r = await neonQuery(
    `UPDATE writer_documents SET ${sets.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`,
    vals
  );
  if (!r.rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true, document: normalise(r.rows[0]) });
});

// --- Block Store & Versioning (Sprint 2) ---

/** Save a new block (immutable) */
documentsRoutes.post('/documents/:id/blocks', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const docId = c.req.param('id');
  const { content, metadata } = await c.req.json();
  
  const r = await neonQuery(
    `INSERT INTO writer_blocks (document_id, content, metadata) VALUES ($1, $2, $3) RETURNING id`,
    [docId, content, JSON.stringify(metadata || {})]
  );
  return c.json({ id: r.rows[0].id }, 201);
});

/** Get all versions for a document */
documentsRoutes.get('/documents/:id/versions', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const docId = c.req.param('id');
  
  const r = await neonQuery(
    `SELECT * FROM writer_versions WHERE document_id = $1 ORDER BY version_number DESC`,
    [docId]
  );
  return c.json(r.rows);
});

/** Create a new version (multi-model draft) */
documentsRoutes.post('/documents/:id/versions', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const docId = c.req.param('id');
  const { version_number, model_id, block_ids, score } = await c.req.json();
  
  const r = await neonQuery(
    `INSERT INTO writer_versions (document_id, version_number, model_id, block_ids, score) 
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [docId, version_number, model_id, block_ids, JSON.stringify(score || {})]
  );
  return c.json(r.rows[0], 201);
});

documentsRoutes.post('/documents/:id/favorite', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const id = c.req.param('id');
  // Atomic toggle — no SELECT-then-UPDATE race condition
  const r = await neonQuery(
    `UPDATE writer_documents SET metadata = jsonb_set(
      COALESCE(metadata::jsonb, '{}'),
      '{isFavorite}',
      CASE WHEN metadata->>'isFavorite' = 'true' THEN 'false'::jsonb ELSE 'true'::jsonb END
    )::json, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING metadata`,
    [id, user.id]
  );
  if (!r.rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true, is_favorite: r.rows[0].metadata?.isFavorite ?? true });
});

documentsRoutes.post('/documents/:id/sync', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const id = c.req.param('id');
  const { state, content } = await c.req.json();
  const sets = ['updated_at = NOW()'];
  const vals: any[] = [];
  let idx = 1;
  if (content !== undefined) { sets.push(`content = $${idx}`); vals.push(content); idx++; }
  const cur = await neonQuery(`SELECT metadata FROM writer_documents WHERE id = $1 AND user_id = $2`, [id, user.id]);
  const meta = cur.rows[0]?.metadata || {};
  if (state !== undefined) meta.yjsState = state;
  sets.push(`metadata = $${idx}`); vals.push(JSON.stringify(meta)); idx++;
  vals.push(id, user.id);
  await neonQuery(`UPDATE writer_documents SET ${sets.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1}`, vals);
  return c.json({ ok: true, synced: true });
});

// GET /folders - list user's folders
documentsRoutes.get('/folders', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const { rows } = await neonQuery('SELECT * FROM writer_folders WHERE user_id = $1 ORDER BY name ASC', [user.id]);
  return c.json(rows);
});

// POST /folders - create folder
documentsRoutes.post('/folders', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const { name, parent_id } = await c.req.json();
  const { rows } = await neonQuery(
    'INSERT INTO writer_folders (user_id, name, parent_id) VALUES ($1, $2, $3) RETURNING *',
    [user.id, name || 'Untitled Folder', parent_id || null]
  );
  return c.json(rows[0]);
});

// PUT /folders/:id - rename folder
documentsRoutes.put('/folders/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const { name } = await c.req.json();
  const { rows } = await neonQuery(
    'UPDATE writer_folders SET name = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
    [name, c.req.param('id'), user.id]
  );
  if (rows.length === 0) return c.json({ error: 'Folder not found' }, 404);
  return c.json(rows[0]);
});

// DELETE /folders/:id - delete folder
documentsRoutes.delete('/folders/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const { rowCount } = await neonQuery(
    'DELETE FROM writer_folders WHERE id = $1 AND user_id = $2',
    [c.req.param('id'), user.id]
  );
  if (rowCount === 0) return c.json({ error: 'Folder not found' }, 404);
  return c.json({ ok: true });
});

// POST /sync - batch sync pending offline changes
documentsRoutes.post('/sync', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const { changes } = await c.req.json();
    if (!Array.isArray(changes) || changes.length === 0) {
      return c.json({ error: 'changes array required' }, 400);
    }
    if (changes.length > 50) {
      return c.json({ error: 'Max 50 changes per sync' }, 400);
    }
    const results = [];
    for (const change of changes) {
      try {
        if (change.operation === 'update' && change.documentId) {
          await neonQuery(
            `UPDATE writer_documents SET content = $1, title = COALESCE($2, title), updated_at = NOW() WHERE id = $3 AND user_id = $4`,
            [change.data?.content || '', change.data?.title, change.documentId, user.id]
          );
          results.push({ id: change.id, ok: true });
        } else if (change.operation === 'create') {
          const { rows } = await neonQuery(
            `INSERT INTO writer_documents (user_id, title, content, doc_type, metadata) VALUES ($1, $2, $3, 'tiptap', $4) RETURNING id`,
            [user.id, change.data?.title || 'Untitled', change.data?.content || '', JSON.stringify({ status: 'draft', isWriterDraft: true })]
          );
          results.push({ id: change.id, ok: true, serverId: rows[0]?.id });
        } else if (change.operation === 'delete' && change.documentId) {
          await neonQuery(
            `UPDATE writer_documents SET deleted_at = NOW() WHERE id = $1 AND user_id = $2`,
            [change.documentId, user.id]
          );
          results.push({ id: change.id, ok: true });
        } else {
          results.push({ id: change.id, ok: false, error: 'Invalid operation' });
        }
      } catch (err: any) {
        results.push({ id: change.id, ok: false, error: err.message || 'Failed' });
      }
    }
    return c.json({ synced: results });
  } catch (err) {
    console.error('[writer/sync] error:', err);
    return c.json({ error: 'Sync failed' }, 500);
  }
});

// GET /documents/search?q=... — semantic search across user's indexed docs
documentsRoutes.get('/documents/search', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'q is required' }, 400)
  const { searchUserDocs } = await import('../services/user-docs')
  const results = await searchUserDocs(user.id, q, 8)
  return c.json({ results })
});

const TEMPLATES = [
  // ── Academic ──────────────────────────────────────────────────────────────
  { id: 'academic-paper', name: 'Academic Paper', description: 'Standard academic paper with abstract, introduction, methods, results, conclusion.', category: 'academic', preview: '', content: '<h1>Title of Your Paper</h1><p><em>Author Name, Institution</em></p><h2>Abstract</h2><p>Summarize your research in 150–300 words. State the problem, methods, key findings, and conclusions.</p><h2>1. Introduction</h2><p>Introduce the research problem and its significance. Review relevant literature and state your hypothesis or research questions.</p><h2>2. Methods</h2><p>Describe your research methodology, data collection, and analysis approach.</p><h2>3. Results</h2><p>Present your findings with supporting data, tables, or figures.</p><h2>4. Discussion</h2><p>Interpret your results. Compare with existing literature. Discuss limitations and implications.</p><h2>5. Conclusion</h2><p>Summarize key findings and suggest directions for future research.</p><h2>References</h2><p>List your references in the appropriate citation style.</p>', icon: 'GraduationCap', is_featured: true, usage_count: 0 },
  { id: 'thesis-chapter', name: 'Thesis Chapter', description: 'PhD/Master thesis chapter template with LaTeX-compatible structure.', category: 'academic', preview: '', content: '<h1>Chapter Title</h1><h2>1.1 Overview</h2><p>Introduce the chapter\'s focus and how it fits within the broader thesis argument.</p><h2>1.2 Literature Review</h2><p>Survey the key works and theoretical frameworks relevant to this chapter.</p><h2>1.3 Methodology</h2><p>Detail the specific methods applied in this chapter\'s analysis.</p><h2>1.4 Analysis</h2><p>Present your analysis, findings, and interpretation of the data.</p><h2>1.5 Summary</h2><p>Recap the chapter\'s contributions and transition to the next chapter.</p>', icon: 'BookOpen', is_featured: true, usage_count: 0 },
  { id: 'research-report', name: 'Research Report', description: 'Industry research report with executive summary, data analysis, recommendations.', category: 'academic', preview: '', content: '<h1>Research Report Title</h1><p><em>Prepared by: [Author] | Date: [Date]</em></p><h2>Executive Summary</h2><p>High-level overview of objectives, methodology, key findings, and recommendations.</p><h2>Background</h2><p>Describe the context and motivation for this research.</p><h2>Methodology</h2><p>Outline the research approach, data sources, and analytical framework.</p><h2>Key Findings</h2><ul><li>Finding 1: [Description]</li><li>Finding 2: [Description]</li><li>Finding 3: [Description]</li></ul><h2>Recommendations</h2><p>Based on the findings, recommend specific actions or next steps.</p><h2>Appendix</h2><p>Include supplementary data, charts, or detailed methodology notes.</p>', icon: 'ChartBar', is_featured: false, usage_count: 0 },
  { id: 'grant-proposal', name: 'Grant Proposal', description: 'NIH/NSF-style grant proposal with specific aims, research plan, budget justification.', category: 'academic', preview: '', content: '<h1>Grant Proposal: [Project Title]</h1><p><em>Principal Investigator: [Name] | Institution: [Institution]</em></p><h2>Specific Aims</h2><p>State the overall goals and specific objectives of the proposed research. Explain the significance and innovation.</p><h2>Research Strategy</h2><h3>Significance</h3><p>Explain why this research matters and what gap it fills in the field.</p><h3>Innovation</h3><p>Describe what is novel about your approach, methods, or expected outcomes.</p><h3>Approach</h3><p>Detail your research plan, experimental design, and timeline.</p><h2>Budget Justification</h2><p>Explain the resources requested and why each is necessary for the project.</p><h2>Timeline</h2><p>Provide a month-by-month or phase-by-phase plan for the project duration.</p>', icon: 'Trophy', is_featured: true, usage_count: 0 },
  { id: 'literature-review', name: 'Literature Review', description: 'Systematic review of existing research on a topic.', category: 'academic', preview: '', content: '<h1>Literature Review: [Topic]</h1><p><em>Author: [Name] | Course/Journal: [Context]</em></p><h2>Introduction</h2><p>Define the scope and purpose of this literature review. Explain your search strategy and inclusion criteria.</p><h2>Thematic Analysis</h2><h3>Theme 1: [Name]</h3><p>Summarize key studies and their contributions to this theme.</p><h3>Theme 2: [Name]</h3><p>Summarize key studies and their contributions to this theme.</p><h3>Theme 3: [Name]</h3><p>Summarize key studies and their contributions to this theme.</p><h2>Synthesis and Gaps</h2><p>Identify patterns, contradictions, and gaps in the existing literature.</p><h2>Conclusion</h2><p>Summarize key takeaways and implications for future research.</p><h2>References</h2>', icon: 'Books', is_featured: false, usage_count: 0 },
  { id: 'case-study', name: 'Case Study', description: 'In-depth analysis of a specific instance, event, or organization.', category: 'academic', preview: '', content: '<h1>Case Study: [Subject]</h1><h2>Executive Summary</h2><p>Brief overview of the case, key findings, and recommendations in 2–3 sentences.</p><h2>Background</h2><p>Provide context: who, what, where, when.</p><h2>Problem Statement</h2><p>Clearly articulate the core challenge or question being investigated.</p><h2>Analysis</h2><h3>Key Factor 1</h3><p>Analysis of this dimension of the case.</p><h3>Key Factor 2</h3><p>Analysis of this dimension of the case.</p><h2>Solutions / Recommendations</h2><ul><li>Recommendation 1: [Description + rationale]</li><li>Recommendation 2: [Description + rationale]</li></ul><h2>Conclusion</h2><p>Lessons learned and broader implications.</p>', icon: 'Magnify', is_featured: false, usage_count: 0 },
  // ── Journal Formats ───────────────────────────────────────────────────────
  { id: 'nature-paper', name: 'Nature Paper', description: 'Nature journal format: Results-first with Methods at end.', category: 'academic', preview: '', content: '<h1>[Title]</h1><p><em>[Authors] | [Affiliations]</em></p><h2>Abstract</h2><p>One paragraph, max 150 words. State the question, approach, key result, and significance.</p><h2>Introduction</h2><p>Establish context and significance. State the question and approach. Last paragraph should state what was done.</p><h2>Results</h2><p>Present findings in logical order. Each paragraph should have a topic sentence summarizing the key result.</p><h2>Discussion</h2><p>Interpret findings. Compare with prior work. Acknowledge limitations. State broader implications.</p><h2>Methods</h2><p>Detailed methods enabling reproducibility. Subheadings for each experimental approach.</p><h2>References</h2>', icon: 'Flask', is_featured: true, usage_count: 0 },
  { id: 'ieee-paper', name: 'IEEE Paper', description: 'IEEE conference/journal format for engineering and technology.', category: 'academic', preview: '', content: '<h1>[Paper Title]</h1><p><em>[Author 1, Author 2] — [Department, University, City, Country]</em></p><h2>Abstract</h2><p>Concise summary (150–200 words): problem, approach, results, significance.</p><p><strong>Index Terms</strong> — keyword1, keyword2, keyword3</p><h2>I. Introduction</h2><p>Motivation, problem statement, related work overview, paper contributions, and organization.</p><h2>II. Related Work</h2><p>Survey of relevant prior work with comparison to proposed approach.</p><h2>III. System Design / Methodology</h2><p>Describe architecture, algorithms, and implementation details.</p><h2>IV. Experimental Results</h2><p>Setup, metrics, baselines, and comparative results.</p><h2>V. Conclusion</h2><p>Summary of contributions, limitations, and future work.</p><h2>References</h2>', icon: 'Cpu', is_featured: false, usage_count: 0 },
  // ── Technical ─────────────────────────────────────────────────────────────
  { id: 'technical-doc', name: 'Technical Documentation', description: 'API docs or technical specification template.', category: 'technical', preview: '', content: '<h1>Technical Documentation: [Feature/API Name]</h1><h2>Overview</h2><p>Briefly describe what this component or API does and who it\'s for.</p><h2>Getting Started</h2><p>Prerequisites, installation steps, and initial configuration.</p><h2>API Reference</h2><h3>Endpoint / Method 1</h3><p><code>GET /api/resource</code> — Description of what this endpoint does.</p><h3>Endpoint / Method 2</h3><p><code>POST /api/resource</code> — Description of what this endpoint does.</p><h2>Examples</h2><p>Show practical usage examples with code snippets.</p><h2>Troubleshooting</h2><p>Common issues and their solutions.</p>', icon: 'Code', is_featured: false, usage_count: 0 },
  { id: 'design-doc', name: 'Design Document', description: 'Software design spec: problem, requirements, architecture, trade-offs.', category: 'technical', preview: '', content: '<h1>Design Document: [Feature / System Name]</h1><p><em>Author: [Name] | Status: Draft | Date: [Date]</em></p><h2>Problem Statement</h2><p>What problem does this solve? Who are the users? What are the current pain points?</p><h2>Goals and Non-Goals</h2><h3>Goals</h3><ul><li>Goal 1</li><li>Goal 2</li></ul><h3>Non-Goals</h3><ul><li>Out of scope item 1</li></ul><h2>Proposed Solution</h2><p>High-level description of the approach. Include architecture diagram if relevant.</p><h2>Detailed Design</h2><p>Component breakdown, data models, APIs, state management.</p><h2>Alternatives Considered</h2><p>Other approaches evaluated and why they were rejected.</p><h2>Open Questions</h2><ul><li>Question 1</li></ul>', icon: 'Blueprint', is_featured: true, usage_count: 0 },
  { id: 'post-mortem', name: 'Incident Post-Mortem', description: 'Root-cause analysis and lessons learned after an incident.', category: 'technical', preview: '', content: '<h1>Post-Mortem: [Incident Name]</h1><p><em>Date: [Date] | Severity: [P1/P2/P3] | Duration: [X hours]</em></p><h2>Executive Summary</h2><p>One paragraph: what happened, user impact, and what was done to resolve it.</p><h2>Timeline</h2><ul><li>[HH:MM] — Event description</li><li>[HH:MM] — Event description</li><li>[HH:MM] — Incident resolved</li></ul><h2>Root Cause</h2><p>Describe the underlying technical cause(s). Distinguish between root cause and contributing factors.</p><h2>Contributing Factors</h2><ul><li>Factor 1</li><li>Factor 2</li></ul><h2>Impact</h2><p>Users affected, revenue impact, SLA impact.</p><h2>Action Items</h2><ul><li>[ ] Action 1 — Owner: [Name] — Due: [Date]</li><li>[ ] Action 2 — Owner: [Name] — Due: [Date]</li></ul><h2>Lessons Learned</h2><p>What did we learn? What would we do differently?</p>', icon: 'Warning', is_featured: false, usage_count: 0 },
  // ── Creative ──────────────────────────────────────────────────────────────
  { id: 'blog-post', name: 'Blog Post', description: 'Engaging blog post template with headline, intro, sections, CTA.', category: 'creative', preview: '', content: '<h1>Your Blog Post Title</h1><p><em>A compelling subtitle that hooks the reader</em></p><p>Open with a strong hook — a surprising fact, a question, or a bold statement that draws the reader in.</p><h2>The Problem</h2><p>Describe the challenge or topic you\'re addressing. Why should the reader care?</p><h2>The Solution</h2><p>Share your insights, steps, or framework. Use concrete examples and evidence.</p><h2>Key Takeaways</h2><ul><li>Takeaway 1</li><li>Takeaway 2</li><li>Takeaway 3</li></ul><h2>What\'s Next?</h2><p>End with a call to action. What should the reader do, think, or explore after reading this?</p>', icon: 'PencilSimple', is_featured: false, usage_count: 0 },
  { id: 'short-story', name: 'Short Story', description: 'Three-act structure for fiction: setup, confrontation, resolution.', category: 'creative', preview: '', content: '<h1>[Story Title]</h1><p><em>By [Author]</em></p><h2>Act I — Setup</h2><p>Introduce your protagonist, the world, and the inciting incident that sets the story in motion. End Act I with the protagonist committing to a goal or being thrust into conflict.</p><h2>Act II — Confrontation</h2><p>The protagonist pursues their goal, encountering escalating obstacles. Raise the stakes. Midpoint reversal or revelation. The lowest point — the moment everything seems lost.</p><h2>Act III — Resolution</h2><p>The climax: protagonist faces the central conflict head-on. Resolution shows how the protagonist has changed. Leave the reader with an emotional resonance.</p>', icon: 'Book', is_featured: false, usage_count: 0 },
  { id: 'essay', name: 'Analytical Essay', description: 'Five-paragraph essay structure with thesis, evidence, and conclusion.', category: 'creative', preview: '', content: '<h1>[Essay Title]</h1><h2>Introduction</h2><p>Open with a hook. Provide context. End with a clear thesis statement that makes an arguable claim.</p><p><strong>Thesis:</strong> [Your central argument in one sentence.]</p><h2>Body Paragraph 1</h2><p><strong>Topic sentence:</strong> [First supporting point]</p><p>Evidence: [Quote, data, or example]</p><p>Analysis: [Explain how this evidence supports your thesis]</p><h2>Body Paragraph 2</h2><p><strong>Topic sentence:</strong> [Second supporting point]</p><p>Evidence: [Quote, data, or example]</p><p>Analysis: [Explain how this evidence supports your thesis]</p><h2>Body Paragraph 3</h2><p><strong>Topic sentence:</strong> [Third supporting point or counterargument refutation]</p><p>Evidence: [Quote, data, or example]</p><p>Analysis: [Explain how this evidence supports your thesis]</p><h2>Conclusion</h2><p>Restate thesis in fresh language. Synthesize key points. End with a broader implication or call to reflection.</p>', icon: 'PenNib', is_featured: false, usage_count: 0 },
  // ── Professional ──────────────────────────────────────────────────────────
  { id: 'press-release', name: 'Press Release', description: 'Standard press release format for announcements.', category: 'professional', preview: '', content: '<p><strong>FOR IMMEDIATE RELEASE</strong></p><p>[City, Date] — <strong>[Company/Organization Name]</strong> today announced [brief description of the announcement in one sentence].</p><h2>[Headline: Active Verb + Company + Announcement]</h2><p><strong>[Subheadline that adds context or key benefit]</strong></p><p>[Opening paragraph: who, what, when, where, why — the most newsworthy angle first.]</p><p>[Second paragraph: more detail, context, or background.]</p><blockquote><p>"[Quote from spokesperson]," said [Name], [Title] at [Company]. "[Second sentence of quote that adds perspective.]"</p></blockquote><p>[Additional detail, statistics, or context.]</p><h2>About [Company]</h2><p>[2–3 sentence boilerplate about the company.]</p><p><strong>Media Contact:</strong><br/>[Name]<br/>[Email]<br/>[Phone]</p>', icon: 'Megaphone', is_featured: false, usage_count: 0 },
  { id: 'business-plan', name: 'Business Plan', description: 'One-page business plan covering market, product, and financials.', category: 'professional', preview: '', content: '<h1>[Company Name] — Business Plan</h1><p><em>Date: [Date] | Prepared by: [Founder Name]</em></p><h2>Executive Summary</h2><p>One paragraph: what we do, who it\'s for, why now, and the ask (if any).</p><h2>Problem</h2><p>Describe the pain point. Who experiences it? How do they currently solve it? What are the limitations of current solutions?</p><h2>Solution</h2><p>What do you build? What makes it better? What is the core value proposition?</p><h2>Market</h2><p>Total addressable market (TAM), serviceable addressable market (SAM), target segment.</p><h2>Business Model</h2><p>How do you make money? Pricing, unit economics, key metrics.</p><h2>Traction</h2><p>What have you proven so far? Customers, revenue, partnerships, pilots.</p><h2>Team</h2><p>Who are the founders and key hires? Why are you the right team?</p><h2>Financial Projections</h2><p>3-year revenue projection. Key assumptions. Burn rate and runway.</p>', icon: 'Briefcase', is_featured: true, usage_count: 0 },
  { id: 'meeting-notes', name: 'Meeting Notes', description: 'Structured meeting notes with agenda, decisions, and action items.', category: 'professional', preview: '', content: '<h1>Meeting Notes: [Meeting Title]</h1><p><strong>Date:</strong> [Date] | <strong>Time:</strong> [Start] – [End]<br/><strong>Location / Link:</strong> [In-person / Zoom link]<br/><strong>Attendees:</strong> [Name 1, Name 2, Name 3]<br/><strong>Facilitator:</strong> [Name] | <strong>Note-taker:</strong> [Name]</p><h2>Agenda</h2><ol><li>Agenda item 1</li><li>Agenda item 2</li><li>Agenda item 3</li></ol><h2>Discussion Notes</h2><h3>Item 1: [Topic]</h3><p>[Summary of discussion, key points raised, perspectives shared.]</p><h3>Item 2: [Topic]</h3><p>[Summary of discussion.]</p><h2>Decisions Made</h2><ul><li>Decision 1: [What was decided and why]</li><li>Decision 2: [What was decided and why]</li></ul><h2>Action Items</h2><ul><li>[ ] [Action description] — Owner: [Name] — Due: [Date]</li><li>[ ] [Action description] — Owner: [Name] — Due: [Date]</li></ul><h2>Next Meeting</h2><p>Date: [Date] | Topics: [Preview of next agenda]</p>', icon: 'Calendar', is_featured: false, usage_count: 0 },
  { id: 'project-proposal', name: 'Project Proposal', description: 'Internal project proposal with goals, scope, timeline, and resources.', category: 'professional', preview: '', content: '<h1>Project Proposal: [Project Name]</h1><p><em>Proposed by: [Name] | Department: [Dept] | Date: [Date]</em></p><h2>Problem / Opportunity</h2><p>What situation or problem does this project address? Why does it matter now?</p><h2>Proposed Solution</h2><p>Brief description of the project. What will be built or done?</p><h2>Objectives</h2><ul><li>Objective 1 (measurable)</li><li>Objective 2 (measurable)</li></ul><h2>Scope</h2><h3>In Scope</h3><ul><li>Deliverable 1</li><li>Deliverable 2</li></ul><h3>Out of Scope</h3><ul><li>Item excluded and why</li></ul><h2>Timeline</h2><ul><li><strong>Phase 1 (Week 1–2):</strong> [Description]</li><li><strong>Phase 2 (Week 3–6):</strong> [Description]</li><li><strong>Phase 3 (Week 7–8):</strong> [Description]</li></ul><h2>Resources Required</h2><p>Team, budget, tools, external dependencies.</p><h2>Risks and Mitigations</h2><ul><li>Risk 1: [Description] → Mitigation: [Plan]</li></ul><h2>Success Metrics</h2><ul><li>KPI 1: [Metric and target]</li></ul>', icon: 'Rocket', is_featured: true, usage_count: 0 },
  // ── Patent ────────────────────────────────────────────────────────────────
  { id: 'patent-application', name: 'Patent Application', description: 'Provisional patent application structure with claims and abstract.', category: 'academic', preview: '', content: '<h1>Patent Application: [Title of Invention]</h1><p><em>Inventor(s): [Names] | Filing Date: [Date]</em></p><h2>Field of the Invention</h2><p>Brief statement of the technical field to which the invention relates.</p><h2>Background</h2><p>Describe existing solutions and their limitations. Establish the need for the invention.</p><h2>Summary of the Invention</h2><p>Concise statement of what the invention is and its key advantage over the prior art.</p><h2>Brief Description of Drawings</h2><p>Figure 1 shows [description]. Figure 2 shows [description].</p><h2>Detailed Description</h2><p>Full description of the preferred embodiment(s). Reference figures. Enable a person skilled in the art to practice the invention.</p><h2>Claims</h2><ol><li>An apparatus comprising: [element A]; [element B]; wherein [relationship].</li><li>The apparatus of claim 1, wherein [additional limitation].</li></ol><h2>Abstract</h2><p>One paragraph (150 words max) summarizing the disclosure.</p>', icon: 'Certificate', is_featured: false, usage_count: 0 },
];

documentsRoutes.get('/templates', async (c) => c.json(TEMPLATES));

documentsRoutes.post('/templates/:templateId/use', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const templateId = c.req.param('templateId');
  // Auto-generate title from template name
  const titleMap: Record<string, string> = Object.fromEntries(
    TEMPLATES.map(t => [t.id, `New ${t.name}`])
  );
  const template = TEMPLATES.find(t => t.id === templateId);
  const metadata = { docType: template?.category || 'other', status: 'draft', isWriterDraft: true, templateId };
  const r = await neonQuery(
    `INSERT INTO writer_documents (user_id, title, content, doc_type, metadata) VALUES ($1, $2, $3, 'tiptap', $4) RETURNING *`,
    [user.id, titleMap[templateId] || 'New Document', template?.content || '', JSON.stringify(metadata)]
  );
  return c.json(normalise(r.rows[0]), 201);
});

// Legacy /drafts compat — map to writer_documents
documentsRoutes.get('/drafts', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const r = await neonQuery(
    `SELECT * FROM writer_documents WHERE user_id = $1 AND doc_type = 'tiptap' ORDER BY updated_at DESC LIMIT 50`,
    [user.id]
  ).catch(() => ({ rows: [] }));
  return c.json({ drafts: r.rows });
});

documentsRoutes.get('/drafts/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const r = await neonQuery(`SELECT * FROM writer_documents WHERE id = $1 AND user_id = $2`, [c.req.param('id'), user.id]);
  if (!r.rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ draft: r.rows[0] });
});

documentsRoutes.post('/drafts', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const { title, content, docType } = await c.req.json();
  const metadata = { docType: docType || 'general', isWriterDraft: true };
  const r = await neonQuery(
    `INSERT INTO writer_documents (user_id, title, content, doc_type, metadata) VALUES ($1, $2, $3, 'tiptap', $4) RETURNING *`,
    [user.id, title || 'Untitled Document', content || '', JSON.stringify(metadata)]
  );
  return c.json({ ok: true, draft: r.rows[0] });
});

documentsRoutes.put('/drafts/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  const id = c.req.param('id');
  const { title, content, docType } = await c.req.json();
  const sets = ['updated_at = NOW()'];
  const vals: any[] = [];
  let idx = 1;
  if (title !== undefined) { sets.push(`title = $${idx}`); vals.push(title); idx++; }
  if (content !== undefined) { sets.push(`content = $${idx}`); vals.push(content); idx++; }
  if (docType !== undefined) { sets.push(`metadata = $${idx}`); vals.push(JSON.stringify({ docType })); idx++; }
  vals.push(id, user.id);
  const r = await neonQuery(`UPDATE writer_documents SET ${sets.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`, vals);
  if (!r.rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true, draft: r.rows[0] });
});

documentsRoutes.delete('/drafts/:id', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await ensureSchema();
  await neonQuery(`UPDATE writer_documents SET deleted_at = NOW() WHERE id = $1 AND user_id = $2`, [c.req.param('id'), user.id]);
  return c.json({ ok: true });
});
