/** Writer — Version history and AI Project Brief routes. */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { neon } from '../services/neon';

export const versionsRoutes = new Hono();

versionsRoutes.get('/documents/:id/versions', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    try {
        const { rows } = await neon.query(
            `SELECT id, version_num, title, word_count, author_id, message, created_at
             FROM writer_document_versions WHERE document_id = $1 AND user_id = $2 ORDER BY version_num DESC LIMIT 50`,
            [c.req.param('id'), user.id]
        );
        return c.json(rows);
    } catch (err) {
        console.error('[writer/versions] GET error:', err);
        return c.json({ error: 'Failed to fetch versions' }, 500);
    }
});

versionsRoutes.post('/documents/:id/versions', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const docId = c.req.param('id');
    const { title, content, word_count, message } = await c.req.json();
    if (!content) return c.json({ error: 'content is required' }, 400);
    try {
        // Verify the document belongs to the authenticated user before creating a version
        const { rows: docRows } = await neon.query(
            `SELECT id FROM writer_documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [docId, user.id]
        );
        if (docRows.length === 0) return c.json({ error: 'Document not found' }, 404);

        const { rows } = await neon.query(
            `INSERT INTO writer_document_versions (user_id, document_id, version_num, title, content, word_count, author_id, message)
             SELECT $1, $2, COALESCE(MAX(version_num), 0) + 1, $3, $4, $5, $6, $7
             FROM writer_document_versions WHERE document_id = $2
             RETURNING id, version_num, title, word_count, message, created_at`,
            [user.id, docId, title || 'Untitled', content, word_count || 0, user.id, message || null]
        );
        return c.json(rows[0], 201);
    } catch (err) {
        console.error('[writer/versions] POST error:', err);
        return c.json({ error: 'Failed to create version snapshot' }, 500);
    }
});

versionsRoutes.post('/documents/:id/versions/:versionId/restore', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const docId = c.req.param('id');
    const versionId = c.req.param('versionId');
    try {
        const { rows } = await neon.query(
            `SELECT title, content, word_count FROM writer_document_versions WHERE id = $1 AND document_id = $2 AND user_id = $3`,
            [versionId, docId, user.id]
        );
        if (rows.length === 0) return c.json({ error: 'Version not found' }, 404);
        const { rowCount } = await neon.query(
            `UPDATE writer_documents SET title = $1, content = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4`,
            [rows[0].title, rows[0].content, docId, user.id]
        );
        if (!rowCount) return c.json({ error: 'Document not found' }, 404);
        return c.json({ ok: true, restored: { title: rows[0].title, word_count: rows[0].word_count } });
    } catch (err) {
        console.error('[writer/versions/restore] error:', err);
        return c.json({ error: 'Failed to restore version' }, 500);
    }
});

versionsRoutes.post('/brief', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!ANTHROPIC_API_KEY) return c.json({ error: 'AI service not configured' }, 503);
    const { content, documentId } = await c.req.json();
    if (!content || String(content).replace(/<[^>]*>/g, '').trim().length < 30)
        return c.json({ error: 'Document needs more content to generate a brief' }, 400);
    const plainText = String(content).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const prompt = `You are a strategic writing advisor. Analyze the document below and produce a concise project brief.

Document:
${plainText}

Return ONLY a JSON object — no markdown, no code fences, no explanation:
{
  "format": "<one of: Research Paper, Review Article, Grant Proposal, Patent Application, Technical Report, Thesis Chapter, Essay, Blog Post, White Paper, Brainstorm>",
  "audience": "<who this is written for, one sentence>",
  "goal": "<what this document aims to achieve, one sentence>",
  "tone": "<tone descriptor, e.g. Academic, Technical, Persuasive, Conversational>",
  "keyPoints": ["<core argument or finding 1>", "<core argument or finding 2>", "<core argument or finding 3>"]
}`;
    try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
            signal: AbortSignal.timeout(30_000),
        });
        const aiData = await aiRes.json() as any;
        const rawText = aiData.content?.[0]?.text || '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return c.json({ error: 'Failed to parse AI response' }, 500);
        const brief = JSON.parse(jsonMatch[0]);
        if (documentId) {
            const { rows: docs } = await neon.query(`SELECT metadata FROM writer_documents WHERE id = $1 AND user_id = $2`, [documentId, user.id]);
            const meta = docs[0]?.metadata || {};
            await neon.query(
                `UPDATE writer_documents SET metadata = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
                [JSON.stringify({ ...meta, projectBrief: brief }), documentId, user.id]
            );
        }
        return c.json(brief);
    } catch (err) {
        console.error('[writer/brief] error:', err);
        return c.json({ error: 'Failed to generate brief' }, 500);
    }
});

versionsRoutes.patch('/documents/:id/brief', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    try {
        const id = c.req.param('id');
        const brief = await c.req.json();
        const { rows: docs } = await neon.query(`SELECT metadata FROM writer_documents WHERE id = $1 AND user_id = $2`, [id, user.id]);
        if (docs.length === 0) return c.json({ error: 'Document not found' }, 404);
        await neon.query(
            `UPDATE writer_documents SET metadata = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
            [JSON.stringify({ ...docs[0].metadata, projectBrief: brief }), id, user.id]
        );
        return c.json({ ok: true });
    } catch (err) {
        console.error('[writer/brief/update] error:', err);
        return c.json({ error: 'Failed to update brief' }, 500);
    }
});
