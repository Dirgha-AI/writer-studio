/** Writer — Backlinks graph: wiki-link cross-references between documents and vault clips. */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { query as neonQuery } from '../services/neon';

export const backlinksRoutes = new Hono();

backlinksRoutes.get('/backlinks', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const docId = c.req.query('docId');
  if (!docId) return c.json({ nodes: [], links: [], backlinks: [] });

  let sourceRows: any[] = [];
  try {
    const r = await neonQuery(
      'SELECT title, content FROM writer_documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [docId, user.id]
    );
    sourceRows = r.rows || [];
  } catch { sourceRows = []; }

  if (sourceRows.length === 0) return c.json({ nodes: [], links: [], backlinks: [] });

  const sourceTitle = sourceRows[0].title;

  let linkedRows: any[] = [];
  try {
    const r = await neonQuery(
      'SELECT id, title, updated_at FROM writer_documents WHERE user_id = $1 AND deleted_at IS NULL AND content ILIKE $2 AND id != $3 ORDER BY updated_at DESC LIMIT 20',
      [user.id, '%[[' + sourceTitle + ']]%', docId]
    );
    linkedRows = r.rows || [];
  } catch { linkedRows = []; }

  let clipRows: any[] = [];
  try {
    const r = await neonQuery(
      'SELECT id, title, url FROM vault_clips WHERE user_id = $1 AND (title ILIKE $2 OR summary ILIKE $2) LIMIT 10',
      [user.id, '%' + sourceTitle + '%']
    );
    clipRows = r.rows || [];
  } catch { clipRows = []; }

  const nodes = [
    { id: 'current', label: sourceTitle, type: 'current' },
    ...linkedRows.map((d: any) => ({ id: d.id, label: d.title, type: 'doc' })),
    ...clipRows.map((cl: any) => ({ id: cl.id, label: cl.title, type: 'entity' })),
  ];

  const links = linkedRows.map((d: any) => ({ source: d.id, target: 'current' }));

  const backlinks = linkedRows.map((d: any) => ({
    title: d.title,
    linkedFrom: 1,
    documentId: d.id,
  }));

  return c.json({ nodes, links, backlinks });
});
