/** Writer Story Engine — universe + act + entity routes. */
import { Hono } from 'hono';
import { query } from '../services/neon';
import { getUser } from '../middleware/auth';
import { ensureStorySchema } from './story-schema';

export const storyUniverseRoutes = new Hono();

// ── Universes ──────────────────────────────────────────────────────────────────

storyUniverseRoutes.post('/story/universes', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await ensureStorySchema();
    const { title, logline, genre = [] } = await c.req.json<any>();
    if (!title || typeof title !== 'string' || !title.trim()) {
      return c.json({ error: 'title is required' }, 400);
    }
    const { rows: [u] } = await query(
      `INSERT INTO story_universes (user_id, title, logline, genre) VALUES ($1,$2,$3,$4) RETURNING *`,
      [user.id, title, logline ?? null, genre]
    );
    return c.json({ universe: u }, 201);
  } catch (err) {
    console.error('[story-universes/create] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

storyUniverseRoutes.get('/story/universes', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await ensureStorySchema();
    const { rows } = await query(
      `SELECT id, title, logline, genre, created_at, updated_at FROM story_universes WHERE user_id=$1 ORDER BY updated_at DESC`,
      [user.id]
    );
    return c.json({ universes: rows });
  } catch (err) {
    console.error('[story-universes/list] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

storyUniverseRoutes.get('/story/universes/:id', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await ensureStorySchema();
    const id = c.req.param('id');
    const { rows: [u] } = await query(`SELECT * FROM story_universes WHERE id=$1 AND user_id=$2`, [id, user.id]);
    if (!u) return c.json({ error: 'Universe not found' }, 404);
    const { rows: acts } = await query(`SELECT * FROM story_acts WHERE universe_id=$1 ORDER BY act_number`, [id]);
    const { rows: entities } = await query(`SELECT * FROM story_entities WHERE universe_id=$1 ORDER BY type, name`, [id]);
    const actIds = acts.map((a: any) => a.id);
    const scenes = actIds.length
      ? (await query(`SELECT * FROM story_scenes WHERE act_id = ANY($1) ORDER BY sequence`, [actIds])).rows
      : [];
    const actsWithScenes = acts.map((a: any) => ({ ...a, scenes: scenes.filter((s: any) => s.act_id === a.id) }));
    return c.json({ universe: u, acts: actsWithScenes, entities });
  } catch (err) {
    console.error('[story-universes/get] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

storyUniverseRoutes.patch('/story/universes/:id', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const updates = await c.req.json<any>();
    const sets: string[] = []; const vals: any[] = [];
    for (const k of ['title', 'logline', 'genre']) {
      if (k in updates) { sets.push(`${k} = $${sets.length + 1}`); vals.push(updates[k]); }
    }
    if (!sets.length) return c.json({ error: 'No valid fields' }, 400);
    sets.push(`updated_at = NOW()`); vals.push(c.req.param('id'), user.id);
    const { rows: [u] } = await query(
      `UPDATE story_universes SET ${sets.join(',')} WHERE id=$${vals.length - 1} AND user_id=$${vals.length} RETURNING *`, vals
    );
    if (!u) return c.json({ error: 'Not found' }, 404);
    return c.json({ universe: u });
  } catch (err) {
    console.error('[story-universes/update] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

storyUniverseRoutes.delete('/story/universes/:id', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await query(`DELETE FROM story_universes WHERE id=$1 AND user_id=$2`, [c.req.param('id'), user.id]);
    return c.json({ success: true });
  } catch (err) {
    console.error('[story-universes/delete] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

// ── Acts ───────────────────────────────────────────────────────────────────────

storyUniverseRoutes.post('/story/universes/:id/acts', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await ensureStorySchema();
    const { rows: [u] } = await query(`SELECT id FROM story_universes WHERE id=$1 AND user_id=$2`, [c.req.param('id'), user.id]);
    if (!u) return c.json({ error: 'Universe not found' }, 404);
    const { act_number = 1, title, summary, beat_sheet = [] } = await c.req.json<any>();
    if (!title || typeof title !== 'string' || !title.trim()) {
      return c.json({ error: 'title is required' }, 400);
    }
    const { rows: [a] } = await query(
      `INSERT INTO story_acts (universe_id, act_number, title, summary, beat_sheet) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [u.id, act_number, title ?? null, summary ?? null, JSON.stringify(beat_sheet)]
    );
    return c.json({ act: a }, 201);
  } catch (err) {
    console.error('[story-acts/create] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

storyUniverseRoutes.patch('/story/acts/:actId', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const { act_number, title, summary, beat_sheet } = await c.req.json<any>();
    const { rows: [a] } = await query(
      `UPDATE story_acts SET act_number=COALESCE($1,act_number), title=COALESCE($2,title),
       summary=COALESCE($3,summary), beat_sheet=COALESCE($4,beat_sheet)
       WHERE id=$5 AND universe_id IN (SELECT id FROM story_universes WHERE user_id=$6) RETURNING *`,
      [act_number ?? null, title ?? null, summary ?? null,
       beat_sheet ? JSON.stringify(beat_sheet) : null, c.req.param('actId'), user.id]
    );
    if (!a) return c.json({ error: 'Not found' }, 404);
    return c.json({ act: a });
  } catch (err) {
    console.error('[story-acts/update] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

storyUniverseRoutes.delete('/story/acts/:actId', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await query(
      `DELETE FROM story_acts WHERE id=$1 AND universe_id IN (SELECT id FROM story_universes WHERE user_id=$2)`,
      [c.req.param('actId'), user.id]
    );
    return c.json({ success: true });
  } catch (err) {
    console.error('[story-acts/delete] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

// ── Entities ───────────────────────────────────────────────────────────────────

storyUniverseRoutes.post('/story/universes/:id/entities', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await ensureStorySchema();
    const { rows: [u] } = await query(`SELECT id FROM story_universes WHERE id=$1 AND user_id=$2`, [c.req.param('id'), user.id]);
    if (!u) return c.json({ error: 'Universe not found' }, 404);
    const { type = 'character', name, attributes = {}, arc } = await c.req.json<any>();
    if (!name || typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'name is required' }, 400);
    }
    const { rows: [e] } = await query(
      `INSERT INTO story_entities (universe_id, type, name, attributes, arc) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [u.id, type, name, JSON.stringify(attributes), arc ?? null]
    );
    return c.json({ entity: e }, 201);
  } catch (err) {
    console.error('[story-entities/create] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

storyUniverseRoutes.patch('/story/entities/:entityId', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const { type, name, attributes, arc } = await c.req.json<any>();
    const { rows: [e] } = await query(
      `UPDATE story_entities SET type=COALESCE($1,type), name=COALESCE($2,name),
       attributes=COALESCE($3,attributes), arc=COALESCE($4,arc), updated_at=NOW()
       WHERE id=$5 AND universe_id IN (SELECT id FROM story_universes WHERE user_id=$6) RETURNING *`,
      [type ?? null, name ?? null, attributes ? JSON.stringify(attributes) : null,
       arc ?? null, c.req.param('entityId'), user.id]
    );
    if (!e) return c.json({ error: 'Not found' }, 404);
    return c.json({ entity: e });
  } catch (err) {
    console.error('[story-entities/update] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

storyUniverseRoutes.delete('/story/entities/:entityId', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await query(
      `DELETE FROM story_entities WHERE id=$1 AND universe_id IN (SELECT id FROM story_universes WHERE user_id=$2)`,
      [c.req.param('entityId'), user.id]
    );
    return c.json({ success: true });
  } catch (err) {
    console.error('[story-entities/delete] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});
