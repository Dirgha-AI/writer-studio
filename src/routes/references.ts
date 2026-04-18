/** Writer — References (Citations) routes via Neon DB. */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { neon } from '../services/neon';

export const referencesRoutes = new Hono();

referencesRoutes.get('/references', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    try {
        const { rows } = await neon.query(
            `SELECT id, type, title, authors, year, publication, volume, issue,
                    pages, url, doi, abstract, citation_count, notes, tags, source,
                    created_at, updated_at
             FROM writer_references WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`,
            [user.id]
        );
        return c.json(rows);
    } catch (err) {
        console.error('[writer/references] GET error:', err);
        return c.json({ error: 'Failed to fetch references' }, 500);
    }
});

referencesRoutes.post('/references', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const { type = 'article', title, authors = [], year, publication, volume, issue, pages, url, doi, abstract, notes, tags = [], source = 'internal' } = await c.req.json();
    if (!title) return c.json({ error: 'title is required' }, 400);
    try {
        const { rows } = await neon.query(
            `INSERT INTO writer_references (user_id, type, title, authors, year, publication, volume, issue, pages, url, doi, abstract, notes, tags, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [user.id, type, title, authors, year || null, publication || null, volume || null, issue || null, pages || null, url || null, doi || null, abstract || null, notes || null, tags, source]
        );
        return c.json(rows[0], 201);
    } catch (err: any) {
        if (err?.code === '23505') return c.json({ error: 'A reference with this DOI already exists in your library' }, 409);
        console.error('[writer/references] POST error:', err);
        return c.json({ error: 'Failed to create reference' }, 500);
    }
});

referencesRoutes.patch('/references/:id', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const updates = await c.req.json();
    const allowed = ['type', 'title', 'authors', 'year', 'publication', 'volume', 'issue', 'pages', 'url', 'doi', 'abstract', 'notes', 'tags', 'citation_count', 'source'];
    const setClauses: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const key of allowed) {
        if (updates[key] !== undefined) { setClauses.push(`${key} = $${idx++}`); params.push(updates[key]); }
    }
    if (setClauses.length === 0) return c.json({ error: 'No valid fields to update' }, 400);
    params.push(id, user.id);
    try {
        const { rows } = await neon.query(
            `UPDATE writer_references SET ${setClauses.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
            params
        );
        if (rows.length === 0) return c.json({ error: 'Not found' }, 404);
        return c.json(rows[0]);
    } catch (err) {
        console.error('[writer/references] PATCH error:', err);
        return c.json({ error: 'Failed to update reference' }, 500);
    }
});

referencesRoutes.delete('/references/:id', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    try {
        const { rowCount } = await neon.query(
            `DELETE FROM writer_references WHERE id = $1 AND user_id = $2`, [c.req.param('id'), user.id]
        );
        if (rowCount === 0) return c.json({ error: 'Not found' }, 404);
        return c.json({ ok: true });
    } catch (err) {
        console.error('[writer/references] DELETE error:', err);
        return c.json({ error: 'Failed to delete reference' }, 500);
    }
});

referencesRoutes.post('/references/doi', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const { doi } = await c.req.json();
    if (!doi) return c.json({ error: 'doi is required' }, 400);
    try {
        const cleaned = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
        const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(cleaned)}`, {
            headers: { 'User-Agent': 'Dirgha OS/1.0 (mailto:api@dirgha.ai)' },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return c.json({ error: 'DOI not found in Crossref' }, 404);
        const json: any = await res.json();
        const w = json?.message;
        if (!w) return c.json({ error: 'Invalid Crossref response' }, 502);
        const authors = (w.author || []).map((a: any) => {
            const given = a.given || ''; const family = a.family || '';
            return given ? `${given} ${family}`.trim() : family;
        });
        const year = w.published?.['date-parts']?.[0]?.[0] || w['published-print']?.['date-parts']?.[0]?.[0] || w['published-online']?.['date-parts']?.[0]?.[0];
        return c.json({
            type: w.type === 'journal-article' ? 'article' : 'other',
            title: Array.isArray(w.title) ? w.title[0] : (w.title || ''),
            authors, year: year ? String(year) : null,
            publication: w['container-title']?.[0] || null,
            volume: w.volume || null, issue: w.issue || null, pages: w.page || null,
            doi: cleaned, url: w.URL || `https://doi.org/${cleaned}`,
            abstract: w.abstract ? w.abstract.replace(/<[^>]*>/g, '').trim() : null,
            citation_count: w['is-referenced-by-count'] || 0, source: 'crossref',
        });
    } catch (err) {
        console.error('[writer/references/doi] error:', err);
        return c.json({ error: 'DOI lookup failed' }, 500);
    }
});

referencesRoutes.post('/references/import/bibtex', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const { bibtex } = await c.req.json();
    if (!bibtex) return c.json({ error: 'bibtex string is required' }, 400);
    const entries: any[] = [];
    const entryRegex = /@(\w+)\s*\{([^,]+),\s*([\s\S]*?)\n\}/g;
    let match;
    while ((match = entryRegex.exec(bibtex)) !== null) {
        const [, entryType, , fields] = match;
        if (['string', 'preamble'].includes(entryType.toLowerCase())) continue;
        const entry: Record<string, string> = {};
        const fieldRegex = /(\w+)\s*=\s*(?:\{([\s\S]*?)\}|"([\s\S]*?)"|\b(\d+)\b)/g;
        let fm;
        while ((fm = fieldRegex.exec(fields)) !== null) entry[fm[1].toLowerCase()] = fm[2] ?? fm[3] ?? fm[4] ?? '';
        const type = entryType.toLowerCase() === 'article' ? 'article' : ['book'].includes(entryType.toLowerCase()) ? 'book' : 'other';
        const authors = (entry.author || '').split(/\s+and\s+/i).map((a: string) => a.replace(/\{|\}/g, '').trim()).filter(Boolean);
        entries.push({ type, title: entry.title?.replace(/\{|\}/g, '') || 'Untitled', authors, year: entry.year || null, publication: entry.journal || entry.booktitle || entry.publisher || null, volume: entry.volume || null, issue: entry.number || null, pages: entry.pages || null, url: entry.url || null, doi: entry.doi || null, abstract: entry.abstract || null, notes: null, tags: [], source: 'bibtex' });
    }
    if (entries.length === 0) return c.json({ error: 'No valid BibTeX entries found', imported: 0 }, 400);
    let imported = 0; let skipped = 0; const results: any[] = [];
    for (const ref of entries) {
        try {
            const { rows } = await neon.query(
                `INSERT INTO writer_references (user_id, type, title, authors, year, publication, volume, issue, pages, url, doi, abstract, notes, tags, source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                 ON CONFLICT (user_id, doi) WHERE doi IS NOT NULL AND doi != '' DO NOTHING RETURNING *`,
                [user.id, ref.type, ref.title, ref.authors, ref.year, ref.publication, ref.volume, ref.issue, ref.pages, ref.url, ref.doi, ref.abstract, ref.notes, ref.tags, ref.source]
            );
            if (rows.length > 0) { imported++; results.push(rows[0]); } else skipped++;
        } catch { skipped++; }
    }
    return c.json({ ok: true, imported, skipped, references: results });
});
