/** Writer — Project CRUD with default binder seeding. */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { query as neonQuery } from '../services/neon';

export const projectRoutes = new Hono();

type ProjectType = 'novel' | 'screenplay' | 'paper' | 'poetry' | 'general';

interface BinderItem {
  item_type: 'folder' | 'chapter' | 'document';
  title: string;
  sort_order: number;
  parent_id?: string | null;
}

async function seedDefaultBinder(projectId: string, type: ProjectType) {
  const insert = async (item: BinderItem, parentId: string | null = null) => {
    const r = await neonQuery(
      `INSERT INTO writing_project_items (project_id, parent_id, item_type, title, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [projectId, parentId, item.item_type, item.title, item.sort_order]
    );
    return r.rows[0].id as string;
  };

  if (type === 'novel') {
    const ms = await insert({ item_type: 'folder', title: 'Manuscript', sort_order: 0 });
    await insert({ item_type: 'chapter', title: 'Chapter 1', sort_order: 0 }, ms);
    await insert({ item_type: 'folder', title: 'Characters', sort_order: 1 });
    await insert({ item_type: 'folder', title: 'World Bible', sort_order: 2 });
    await insert({ item_type: 'folder', title: 'Research', sort_order: 3 });
  } else if (type === 'screenplay') {
    const sc = await insert({ item_type: 'folder', title: 'Script', sort_order: 0 });
    await insert({ item_type: 'folder', title: 'Act 1', sort_order: 0 }, sc);
    await insert({ item_type: 'folder', title: 'Act 2', sort_order: 1 }, sc);
    await insert({ item_type: 'folder', title: 'Act 3', sort_order: 2 }, sc);
    await insert({ item_type: 'folder', title: 'Characters', sort_order: 1 });
    await insert({ item_type: 'folder', title: 'Locations', sort_order: 2 });
    await insert({ item_type: 'folder', title: 'Research', sort_order: 3 });
  } else if (type === 'paper') {
    await insert({ item_type: 'document', title: 'Introduction', sort_order: 0 });
    await insert({ item_type: 'document', title: 'Literature Review', sort_order: 1 });
    await insert({ item_type: 'document', title: 'Methods', sort_order: 2 });
    await insert({ item_type: 'document', title: 'Results', sort_order: 3 });
    await insert({ item_type: 'document', title: 'Discussion', sort_order: 4 });
    await insert({ item_type: 'folder', title: 'References', sort_order: 5 });
    await insert({ item_type: 'folder', title: 'Data & Figures', sort_order: 6 });
  } else if (type === 'poetry') {
    const poems = await insert({ item_type: 'folder', title: 'Poems', sort_order: 0 });
    await insert({ item_type: 'document', title: 'Untitled Poem', sort_order: 0 }, poems);
  } else {
    // general
    await insert({ item_type: 'document', title: 'Untitled', sort_order: 0 });
  }
}

// GET /projects
projectRoutes.get('/projects', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const r = await neonQuery(
      `SELECT * FROM writing_projects WHERE user_id = $1 ORDER BY updated_at DESC`,
      [user.id]
    ).catch(() => ({ rows: [] }));
    return c.json({ projects: r.rows });
  } catch (err) {
    console.error('[projects/list] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

// GET /projects/:id
projectRoutes.get('/projects/:id', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const pr = await neonQuery(
      `SELECT * FROM writing_projects WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );
    if (!pr.rows[0]) return c.json({ error: 'Not found' }, 404);
    const items = await neonQuery(
      `SELECT * FROM writing_project_items WHERE project_id = $1 ORDER BY sort_order`,
      [id]
    ).catch(() => ({ rows: [] }));
    return c.json({ project: pr.rows[0], items: items.rows });
  } catch (err) {
    console.error('[projects/get] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

// POST /projects
projectRoutes.post('/projects', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const { title, project_type, description } = await c.req.json();
    const type: ProjectType = (['novel', 'screenplay', 'paper', 'poetry', 'general'].includes(project_type)
      ? project_type
      : 'general') as ProjectType;
    const pr = await neonQuery(
      `INSERT INTO writing_projects (user_id, title, project_type, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [user.id, title || 'Untitled Project', type, description || '']
    );
    const project = pr.rows[0];
    await seedDefaultBinder(project.id, type).catch((e) =>
      console.error('[projects] seedDefaultBinder failed:', e)
    );
    const items = await neonQuery(
      `SELECT * FROM writing_project_items WHERE project_id = $1 ORDER BY sort_order`,
      [project.id]
    ).catch(() => ({ rows: [] }));
    return c.json({ project, items: items.rows }, 201);
  } catch (err) {
    console.error('[projects/create] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

// PATCH /projects/:id
projectRoutes.patch('/projects/:id', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const own = await neonQuery(
      `SELECT id FROM writing_projects WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );
    if (!own.rows[0]) return c.json({ error: 'Not found' }, 404);
    const updates = await c.req.json();
    const ALLOWED = ['title', 'description', 'settings', 'status', 'word_count_goal'];
    const sets: string[] = ['updated_at = NOW()'];
    const vals: any[] = [];
    let idx = 1;
    for (const key of ALLOWED) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = $${idx}`);
        vals.push(key === 'settings' ? JSON.stringify(updates[key]) : updates[key]);
        idx++;
      }
    }
    vals.push(id);
    const r = await neonQuery(
      `UPDATE writing_projects SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals
    );
    return c.json({ project: r.rows[0] });
  } catch (err) {
    console.error('[projects/update] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

// DELETE /projects/:id
projectRoutes.delete('/projects/:id', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const own = await neonQuery(
      `SELECT id FROM writing_projects WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );
    if (!own.rows[0]) return c.json({ error: 'Not found' }, 404);
    await neonQuery(`DELETE FROM writing_projects WHERE id = $1`, [id]);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[projects/delete] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});
