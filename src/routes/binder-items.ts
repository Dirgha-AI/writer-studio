/** Writer — Binder Item CRUD, move, and reorder. */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { query } from '../services/neon';

export const binderItemRoutes = new Hono();

const ALLOWED_UPDATES = [
  'title', 'content', 'status', 'word_count',
  'word_count_goal', 'compile', 'metadata',
];

/** Verify user owns the project. Returns project row or null. */
async function verifyOwnership(projectId: string, userId: string) {
  const { rows } = await query(
    'SELECT id FROM writing_projects WHERE id=$1 AND user_id=$2',
    [projectId, userId]
  );
  return rows[0] ?? null;
}

// POST /projects/:projectId/items — Create binder item
binderItemRoutes.post('/projects/:projectId/items', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const projectId = c.req.param('projectId');
    const project = await verifyOwnership(projectId, user.id).catch(() => null);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const { parent_id, item_type, title, content, sort_order, metadata } =
      await c.req.json();

    const r = await query(
      `INSERT INTO writing_project_items
         (project_id, parent_id, item_type, title, content, sort_order, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        projectId,
        parent_id ?? null,
        item_type ?? 'document',
        title ?? 'Untitled',
        content ?? null,
        sort_order ?? 0,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    return c.json({ item: r.rows[0] }, 201);
  } catch (err) {
    console.error('[binder-items/create] error:', err);
    return c.json({ error: 'Failed to create binder item' }, 500);
  }
});

// PATCH /projects/:projectId/items/:itemId — Update item
binderItemRoutes.patch('/projects/:projectId/items/:itemId', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const projectId = c.req.param('projectId');
    const itemId = c.req.param('itemId');
    const project = await verifyOwnership(projectId, user.id).catch(() => null);
    if (!project) return c.json({ error: 'Not found' }, 404);

    // Confirm item belongs to this project
    const own = await query(
      'SELECT id FROM writing_project_items WHERE id=$1 AND project_id=$2',
      [itemId, projectId]
    );
    if (!own.rows[0]) return c.json({ error: 'Not found' }, 404);

    const updates = await c.req.json();
    const sets: string[] = ['updated_at = NOW()'];
    const vals: unknown[] = [];
    let idx = 1;
    for (const key of ALLOWED_UPDATES) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = $${idx}`);
        vals.push(key === 'metadata' ? JSON.stringify(updates[key]) : updates[key]);
        idx++;
      }
    }
    vals.push(itemId);
    const r = await query(
      `UPDATE writing_project_items SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals
    );
    return c.json({ item: r.rows[0] });
  } catch (err) {
    console.error('[binder-items/update] error:', err);
    return c.json({ error: 'Failed to update binder item' }, 500);
  }
});

// DELETE /projects/:projectId/items/:itemId — Delete item (CASCADE handles children)
binderItemRoutes.delete('/projects/:projectId/items/:itemId', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const projectId = c.req.param('projectId');
    const itemId = c.req.param('itemId');
    const project = await verifyOwnership(projectId, user.id).catch(() => null);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const own = await query(
      'SELECT id FROM writing_project_items WHERE id=$1 AND project_id=$2',
      [itemId, projectId]
    );
    if (!own.rows[0]) return c.json({ error: 'Not found' }, 404);

    await query('DELETE FROM writing_project_items WHERE id=$1', [itemId]);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[binder-items/delete] error:', err);
    return c.json({ error: 'Failed to delete binder item' }, 500);
  }
});

// PATCH /projects/:projectId/items/:itemId/move — Move item to new parent
binderItemRoutes.patch('/projects/:projectId/items/:itemId/move', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const projectId = c.req.param('projectId');
    const itemId = c.req.param('itemId');
    const project = await verifyOwnership(projectId, user.id).catch(() => null);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const own = await query(
      'SELECT id FROM writing_project_items WHERE id=$1 AND project_id=$2',
      [itemId, projectId]
    );
    if (!own.rows[0]) return c.json({ error: 'Not found' }, 404);

    const { parent_id, sort_order } = await c.req.json();
    const r = await query(
      `UPDATE writing_project_items
       SET parent_id=$1, sort_order=$2, updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [parent_id ?? null, sort_order ?? 0, itemId]
    );
    return c.json({ item: r.rows[0] });
  } catch (err) {
    console.error('[binder-items/move] error:', err);
    return c.json({ error: 'Failed to move binder item' }, 500);
  }
});

// PATCH /projects/:projectId/items/reorder — Bulk reorder
binderItemRoutes.patch('/projects/:projectId/items/reorder', async (c) => {
  try {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const projectId = c.req.param('projectId');
    const project = await verifyOwnership(projectId, user.id).catch(() => null);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const { items } = await c.req.json() as { items: Array<{ id: string; sort_order: number }> };
    if (!Array.isArray(items)) return c.json({ error: 'items must be an array' }, 400);

    for (const { id, sort_order } of items) {
      await query(
        `UPDATE writing_project_items
         SET sort_order=$1, updated_at=NOW()
         WHERE id=$2 AND project_id=$3`,
        [sort_order, id, projectId]
      );
    }
    return c.json({ ok: true });
  } catch (err) {
    console.error('[binder-items/reorder] error:', err);
    return c.json({ error: 'Failed to reorder binder items' }, 500);
  }
});
