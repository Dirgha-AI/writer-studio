/** Writer — Draft management CRUD (writing_item_drafts table). */
import { Hono } from 'hono'
import { query } from '../services/neon'
import { getUser } from '../middleware/auth'
import { ensureDraftsSchema } from './drafts-schema'

// Initialize schema (fire-and-forget, idempotent)
ensureDraftsSchema().catch(() => {})

async function verifyItemOwnership(itemId: string, userId: string) {
  const { rows } = await query(
    `SELECT wpi.id FROM writing_project_items wpi
       JOIN writing_projects wp ON wp.id = wpi.project_id
      WHERE wpi.id=$1 AND wp.user_id=$2`,
    [itemId, userId]
  )
  return rows[0] ?? null
}

function computeWordCount(content: string): number {
  return content.split(/\s+/).filter(Boolean).length
}

export const draftRoutes = new Hono()

// POST /items/:itemId/drafts
draftRoutes.post('/items/:itemId/drafts', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const itemId = c.req.param('itemId')
  const item = await verifyItemOwnership(itemId, user.id)
  if (!item) return c.json({ error: 'Item not found' }, 404)
  const { content = '', branch_name = 'main', model_source = 'human', generation_prompt = '', parent_draft_id } = await c.req.json()
  const word_count = computeWordCount(content)
  const { rows } = await query(
    `INSERT INTO writing_item_drafts (item_id, parent_draft_id, branch_name, content, word_count, model_source, generation_prompt)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [itemId, parent_draft_id || null, branch_name, content, word_count, model_source, generation_prompt]
  )
  return c.json(rows[0], 201)
})

// GET /items/:itemId/drafts?branch=main&limit=20&offset=0
draftRoutes.get('/items/:itemId/drafts', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const itemId = c.req.param('itemId')
  const item = await verifyItemOwnership(itemId, user.id)
  if (!item) return c.json({ error: 'Item not found' }, 404)
  const branch = c.req.query('branch') || 'main'
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  const offset = parseInt(c.req.query('offset') || '0')
  const { rows } = await query(
    `SELECT id, branch_name, word_count, model_source, status, score, created_at
     FROM writing_item_drafts WHERE item_id=$1 AND branch_name=$2
     ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [itemId, branch, limit, offset]
  )
  return c.json(rows)
})

// GET /items/:itemId/drafts/:draftId
draftRoutes.get('/items/:itemId/drafts/:draftId', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const itemId = c.req.param('itemId')
  const draftId = c.req.param('draftId')
  const item = await verifyItemOwnership(itemId, user.id)
  if (!item) return c.json({ error: 'Item not found' }, 404)
  const { rows } = await query(
    `SELECT * FROM writing_item_drafts WHERE id=$1 AND item_id=$2`,
    [draftId, itemId]
  )
  if (rows.length === 0) return c.json({ error: 'Draft not found' }, 404)
  return c.json(rows[0])
})

// PATCH /items/:itemId/drafts/:draftId
draftRoutes.patch('/items/:itemId/drafts/:draftId', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const itemId = c.req.param('itemId')
  const draftId = c.req.param('draftId')
  const item = await verifyItemOwnership(itemId, user.id)
  if (!item) return c.json({ error: 'Item not found' }, 404)
  const body = await c.req.json()
  const sets: string[] = []
  const vals: any[] = []
  let n = 0
  if (body.status !== undefined) { sets.push(`status=$${++n}`); vals.push(body.status) }
  if (body.score !== undefined) { sets.push(`score=$${++n}`); vals.push(body.score) }
  if (body.branch_name !== undefined) { sets.push(`branch_name=$${++n}`); vals.push(body.branch_name) }
  if (body.content !== undefined) {
    sets.push(`content=$${++n}`); vals.push(body.content)
    sets.push(`word_count=$${++n}`); vals.push(computeWordCount(body.content))
  }
  if (sets.length === 0) return c.json({ error: 'No valid fields to update' }, 400)
  vals.push(draftId, itemId)
  const { rows } = await query(
    `UPDATE writing_item_drafts SET ${sets.join(', ')} WHERE id=$${++n} AND item_id=$${++n} RETURNING *`,
    vals
  )
  if (rows.length === 0) return c.json({ error: 'Draft not found' }, 404)
  return c.json(rows[0])
})

// DELETE /items/:itemId/drafts/:draftId
draftRoutes.delete('/items/:itemId/drafts/:draftId', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const itemId = c.req.param('itemId')
  const draftId = c.req.param('draftId')
  const item = await verifyItemOwnership(itemId, user.id)
  if (!item) return c.json({ error: 'Item not found' }, 404)
  const { rowCount } = await query(
    `DELETE FROM writing_item_drafts WHERE id=$1 AND item_id=$2`,
    [draftId, itemId]
  )
  if ((rowCount ?? 0) === 0) return c.json({ error: 'Draft not found' }, 404)
  return c.body(null, 204)
})
