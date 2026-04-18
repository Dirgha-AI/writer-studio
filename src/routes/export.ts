/** Writer — Export, Share, and Document-Reference link routes. */
import { Hono } from 'hono';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { getUser } from '../middleware/auth';
import { neon } from '../services/neon';

export const exportRoutes = new Hono();

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BRANDING_FOOTER_HTML = `<footer style="margin-top:40px;padding-top:12px;border-top:1px solid #e5e7eb;text-align:center;font-family:Inter,sans-serif;font-size:11px;color:#6b7280">
  Created with <a href="https://dirgha.ai/?ref=artifact&type=doc" style="color:#0F62FE;text-decoration:none;font-weight:600">Dirgha AI</a> · dirgha.ai
</footer>`;

exportRoutes.post('/documents/:id/export/:format', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const docId = c.req.param('id');
    const format = c.req.param('format') as 'pdf' | 'docx' | 'markdown' | 'html' | 'latex';
    const { rows } = await neon.query(`SELECT title, content FROM writer_documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [docId, user.id]);
    if (rows.length === 0) return c.json({ error: 'Document not found' }, 404);
    const { title, content } = rows[0];
    const safeTitle = title.replace(/[^a-z0-9\s]/gi, '_').replace(/\s+/g, '_');
    try {
        if (format === 'markdown') {
            const md = String(content)
                .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n').replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n').replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
                .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**').replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
                .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*').replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
                .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`').replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
                .replace(/<br\s*\/?>/gi, '\n').replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n').replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
                .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '> $1\n\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
            return c.body(new TextEncoder().encode(`# ${title}\n\n${md}`), 200, { 'Content-Type': 'text/markdown', 'Content-Disposition': `attachment; filename="${safeTitle}.md"` });
        }
        if (format === 'html') {
            const safeHtmlTitle = escapeHtml(title);
            const html = `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><title>${safeHtmlTitle}</title></head>\n<body>\n<h1>${safeHtmlTitle}</h1>\n${content}\n${BRANDING_FOOTER_HTML}\n</body>\n</html>`;
            return c.body(new TextEncoder().encode(html), 200, { 'Content-Type': 'text/html', 'Content-Disposition': `attachment; filename="${safeTitle}.html"` });
        }
        if (format === 'pdf') {
            const res = await fetch(`http://localhost:${process.env.API_PORT || 3001}/api/export/pdf`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: `<h1>${escapeHtml(title)}</h1>${content}${BRANDING_FOOTER_HTML}`, title }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) return c.json({ error: 'PDF generation failed' }, 502);
            return c.body(await res.arrayBuffer(), 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${safeTitle}.pdf"` });
        }
        if (format === 'docx') {
            // Parse HTML content into paragraphs
            const paragraphs: Paragraph[] = [];

            // Add title
            paragraphs.push(new Paragraph({
                text: title,
                heading: HeadingLevel.TITLE,
                spacing: { after: 200 },
            }));

            // Simple HTML-to-docx: split by block tags, preserve headings and basic formatting
            const blocks = String(content)
                .replace(/\r\n/g, '\n')
                .split(/(?=<h[1-6][^>]*>)|(?=<p[^>]*>)|(?=<li[^>]*>)|(?=<blockquote[^>]*>)|(?<=<\/h[1-6]>)|(?<=<\/p>)|(?<=<\/li>)|(?<=<\/blockquote>)/)
                .filter(b => b.trim());

            for (const block of blocks) {
                const trimmed = block.trim();
                if (!trimmed) continue;

                // Detect heading level
                const headingMatch = trimmed.match(/^<h([1-6])[^>]*>(.*?)<\/h[1-6]>$/is);
                if (headingMatch) {
                    const level = parseInt(headingMatch[1]);
                    const hText = headingMatch[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                    const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
                    paragraphs.push(new Paragraph({
                        text: hText,
                        heading: headingLevels[level - 1] || HeadingLevel.HEADING_1,
                        spacing: { before: 240, after: 120 },
                    }));
                    continue;
                }

                // Detect list items
                const liMatch = trimmed.match(/^<li[^>]*>(.*?)<\/li>$/is);
                if (liMatch) {
                    const liText = liMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                    paragraphs.push(new Paragraph({
                        text: `  \u2022  ${liText}`,
                        spacing: { before: 40, after: 40 },
                    }));
                    continue;
                }

                // Regular paragraph: strip tags, handle as TextRun
                const plainText = trimmed.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
                if (plainText) {
                    paragraphs.push(new Paragraph({
                        children: [new TextRun({ text: plainText, size: 24 })],
                        spacing: { after: 120 },
                    }));
                }
            }

            // Add branding footer
            paragraphs.push(new Paragraph({ spacing: { before: 400 } }));
            paragraphs.push(new Paragraph({
                children: [
                    new TextRun({ text: 'Created with Dirgha AI', italics: true, size: 18, color: '6b7280' }),
                    new TextRun({ text: ' \u2014 dirgha.ai', italics: true, size: 18, color: '6b7280' }),
                ],
                alignment: AlignmentType.CENTER,
            }));

            const doc = new Document({
                sections: [{ properties: {}, children: paragraphs }],
            });

            const buffer = await Packer.toBuffer(doc);
            return c.body(new Uint8Array(buffer), 200, {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'Content-Disposition': `attachment; filename="${safeTitle}.docx"`,
            });
        }
        return c.json({ error: `Unknown format: ${format}` }, 400);
    } catch (err: any) {
        console.error(`[writer/export/${format}] error:`, err);
        return c.json({ error: 'Export failed' }, 500);
    }
});

exportRoutes.post('/documents/:id/share', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const docId = c.req.param('id');
    const { rows } = await neon.query(`SELECT id, title, metadata FROM writer_documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [docId, user.id]);
    if (rows.length === 0) return c.json({ error: 'Document not found' }, 404);
    const meta = rows[0].metadata || {};
    if (!meta.shareToken) {
        meta.shareToken = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
        meta.shareCreatedAt = new Date().toISOString();
        await neon.query(`UPDATE writer_documents SET metadata = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`, [JSON.stringify(meta), docId, user.id]);
    }
    return c.json({ shareToken: meta.shareToken, shareUrl: `${process.env.APP_URL || 'https://app.dirgha.ai'}/shared/${meta.shareToken}`, createdAt: meta.shareCreatedAt });
});

exportRoutes.delete('/documents/:id/share', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const docId = c.req.param('id');
    const { rows } = await neon.query(`SELECT metadata FROM writer_documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [docId, user.id]);
    if (rows.length === 0) return c.json({ error: 'Document not found' }, 404);
    const meta = rows[0]?.metadata || {};
    delete meta.shareToken; delete meta.shareCreatedAt;
    await neon.query(`UPDATE writer_documents SET metadata = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`, [JSON.stringify(meta), docId, user.id]);
    return c.json({ ok: true });
});

exportRoutes.get('/shared/:token', async (c) => {
    const token = c.req.param('token');
    if (!token || token.length < 16) return c.json({ error: 'Invalid token' }, 400);
    const { rows } = await neon.query(
        `SELECT id, title, content, created_at, updated_at FROM writer_documents WHERE metadata->>'shareToken' = $1 AND deleted_at IS NULL LIMIT 1`,
        [token]
    );
    if (rows.length === 0) return c.json({ error: 'Shared document not found' }, 404);
    return c.json(rows[0]);
});

exportRoutes.get('/documents/:id/references', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    try {
        const { rows } = await neon.query(
            `SELECT r.* FROM writer_references r JOIN writer_document_references dr ON dr.reference_id = r.id WHERE dr.document_id = $1 AND r.user_id = $2 ORDER BY dr.created_at ASC`,
            [c.req.param('id'), user.id]
        );
        return c.json(rows);
    } catch (err) {
        console.error('[writer/documents/:id/references] GET error:', err);
        return c.json({ error: 'Failed to fetch document references' }, 500);
    }
});

exportRoutes.post('/documents/:id/references', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const docId = c.req.param('id');
    const { reference_id } = await c.req.json();
    if (!reference_id) return c.json({ error: 'reference_id is required' }, 400);
    try {
        // Verify the document belongs to the authenticated user
        const { rows: docRows } = await neon.query(
            `SELECT id FROM writer_documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [docId, user.id]
        );
        if (docRows.length === 0) return c.json({ error: 'Document not found' }, 404);

        // Verify the reference belongs to the authenticated user (IDOR guard)
        const { rows: refRows } = await neon.query(
            `SELECT id FROM writer_references WHERE id = $1 AND user_id = $2`,
            [reference_id, user.id]
        );
        if (refRows.length === 0) return c.json({ error: 'Reference not found' }, 404);

        await neon.query(
            `INSERT INTO writer_document_references (user_id, document_id, reference_id) VALUES ($1,$2,$3) ON CONFLICT (document_id, reference_id) DO UPDATE SET citation_count = writer_document_references.citation_count + 1`,
            [user.id, docId, reference_id]
        );
        return c.json({ ok: true });
    } catch (err) {
        console.error('[writer/documents/:id/references] POST error:', err);
        return c.json({ error: 'Failed to link reference' }, 500);
    }
});
