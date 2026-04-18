/** Writer Story Engine — scene routes. */
import { Hono } from 'hono';
import { query } from '../services/neon';
import { getUser } from '../middleware/auth';
import { ensureStorySchema } from './story-schema';

export const storyScenesRoutes = new Hono();

const OWN_ACT = `SELECT sa.id FROM story_acts sa JOIN story_universes su ON su.id=sa.universe_id WHERE sa.id=$1 AND su.user_id=$2`;

// POST /story/acts/:actId/scenes
storyScenesRoutes.post('/story/acts/:actId/scenes', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await ensureStorySchema();
    const { rows: [a] } = await query(OWN_ACT, [c.req.param('actId'), user.id]);
    if (!a) return c.json({ error: 'Act not found' }, 404);
    const { sequence = 1, location, characters = [], content, notes } = await c.req.json<any>();
    if (typeof sequence !== 'number' || sequence < 0) {
      return c.json({ error: 'sequence must be a number >= 0' }, 400);
    }
    const { rows: [s] } = await query(
      `INSERT INTO story_scenes (act_id, sequence, location, characters, content, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [a.id, sequence, location ?? null, characters, content ?? null, notes ?? null]
    );
    return c.json({ scene: s }, 201);
  } catch (err) {
    console.error('[story-scenes/create] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

// PATCH /story/scenes/:sceneId
storyScenesRoutes.patch('/story/scenes/:sceneId', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const { sequence, location, characters, content, notes } = await c.req.json<any>();
    const { rows: [s] } = await query(
      `UPDATE story_scenes SET
         sequence=COALESCE($1,sequence), location=COALESCE($2,location),
         characters=COALESCE($3,characters), content=COALESCE($4,content),
         notes=COALESCE($5,notes), updated_at=NOW()
       WHERE id=$6 AND act_id IN (
         SELECT sa.id FROM story_acts sa JOIN story_universes su ON su.id=sa.universe_id WHERE su.user_id=$7
       ) RETURNING *`,
      [sequence ?? null, location ?? null, characters ?? null, content ?? null,
       notes ?? null, c.req.param('sceneId'), user.id]
    );
    if (!s) return c.json({ error: 'Not found' }, 404);
    return c.json({ scene: s });
  } catch (err) {
    console.error('[story-scenes/update] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});

// DELETE /story/scenes/:sceneId
storyScenesRoutes.delete('/story/scenes/:sceneId', async (c) => {
  try {
    const user = await getUser(c); if (!user) return c.json({ error: 'Unauthorized' }, 401);
    await query(
      `DELETE FROM story_scenes WHERE id=$1 AND act_id IN (
         SELECT sa.id FROM story_acts sa JOIN story_universes su ON su.id=sa.universe_id WHERE su.user_id=$2
       )`,
      [c.req.param('sceneId'), user.id]
    );
    return c.json({ success: true });
  } catch (err) {
    console.error('[story-scenes/delete] error:', err);
    return c.json({ error: 'Operation failed' }, 500);
  }
});
