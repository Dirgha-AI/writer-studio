/**
 * Writer Workspace RBAC — enterprise team collaboration
 *
 * Routes (all under /api/writer/*):
 *
 *   POST   /workspaces                              — create workspace
 *   GET    /workspaces                              — list user's workspaces
 *   POST   /workspaces/:workspaceId/members         — add member by email
 *   GET    /workspaces/:workspaceId/members         — list members
 *   DELETE /workspaces/:workspaceId/members/:userId — remove member (owner only)
 *   GET    /workspaces/:workspaceId/documents       — list documents shared in workspace
 *
 * Schema tables are created on first request if they do not exist.
 *
 * @module writer/rbac
 */

import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { query } from '../services/neon';

export const rbacRoutes = new Hono();

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;

  await query(`
    CREATE TABLE IF NOT EXISTS writing_workspaces (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT        NOT NULL,
      owner_id   TEXT        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS writing_workspace_members (
      workspace_id UUID  NOT NULL REFERENCES writing_workspaces(id) ON DELETE CASCADE,
      user_id      TEXT  NOT NULL,
      role         TEXT  NOT NULL DEFAULT 'editor'
                         CHECK (role IN ('owner','admin','editor','viewer')),
      added_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (workspace_id, user_id)
    )
  `);

  schemaReady = true;
}

// ─── Guard: verify caller is a member with a required minimum role ─────────────

const ROLE_RANK: Record<string, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

async function getMembership(workspaceId: string, userId: string) {
  const { rows } = await query(
    `SELECT role FROM writing_workspace_members
     WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  return rows[0] ?? null;
}

function hasRole(memberRole: string, required: string): boolean {
  return (ROLE_RANK[memberRole] ?? 0) >= (ROLE_RANK[required] ?? 999);
}

// ─── POST /workspaces — create workspace ──────────────────────────────────────

rbacRoutes.post('/workspaces', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { name?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = body.name?.trim();
  if (!name) return c.json({ error: '"name" is required' }, 400);
  if (name.length > 120) return c.json({ error: '"name" must be 120 characters or fewer' }, 400);

  try {
    await ensureSchema();

    const { rows: [workspace] } = await query(
      `INSERT INTO writing_workspaces (name, owner_id)
       VALUES ($1, $2)
       RETURNING *`,
      [name, user.id],
    );

    // Add creator as owner member
    await query(
      `INSERT INTO writing_workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspace.id, user.id],
    );

    console.log(`[rbac] created workspace id=${workspace.id} owner=${user.id}`);
    return c.json({ workspace }, 201);
  } catch (err: any) {
    console.error('[rbac/create-workspace] error:', err?.message || err);
    return c.json({ error: 'Failed to create workspace', detail: err?.message }, 500);
  }
});

// ─── GET /workspaces — list workspaces the user belongs to ────────────────────

rbacRoutes.get('/workspaces', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  try {
    await ensureSchema();

    const { rows } = await query(
      `SELECT w.id, w.name, w.owner_id, w.created_at, m.role
       FROM writing_workspaces w
       JOIN writing_workspace_members m
         ON m.workspace_id = w.id AND m.user_id = $1
       ORDER BY w.created_at DESC`,
      [user.id],
    );

    return c.json({ workspaces: rows });
  } catch (err: any) {
    console.error('[rbac/list-workspaces] error:', err?.message || err);
    return c.json({ error: 'Failed to list workspaces', detail: err?.message }, 500);
  }
});

// ─── POST /workspaces/:workspaceId/members — add member by email ───────────────

rbacRoutes.post('/workspaces/:workspaceId/members', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const workspaceId = c.req.param('workspaceId');

  let body: { user_email?: string; role?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const email = body.user_email?.trim().toLowerCase();
  if (!email) return c.json({ error: '"user_email" is required' }, 400);

  const role = body.role ?? 'editor';
  if (!['admin', 'editor', 'viewer'].includes(role)) {
    return c.json({ error: '"role" must be one of: admin, editor, viewer' }, 400);
  }

  try {
    await ensureSchema();

    // Verify caller is at least admin in this workspace
    const membership = await getMembership(workspaceId, user.id);
    if (!membership) return c.json({ error: 'Workspace not found or access denied' }, 404);
    if (!hasRole(membership.role, 'admin')) {
      return c.json({ error: 'Only admins and owners can add members' }, 403);
    }

    // Resolve user_id from profiles table by email
    const { rows: profileRows } = await query(
      `SELECT id FROM profiles WHERE LOWER(email) = $1 LIMIT 1`,
      [email],
    );

    if (profileRows.length === 0) {
      return c.json({ error: `No user found with email "${email}"` }, 404);
    }

    const targetUserId: string = profileRows[0].id;

    // Add (or update role) for the target user
    const { rows: [member] } = await query(
      `INSERT INTO writing_workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, added_at = NOW()
       RETURNING *`,
      [workspaceId, targetUserId, role],
    );

    console.log(`[rbac] added member user=${targetUserId} role=${role} workspace=${workspaceId} by=${user.id}`);
    return c.json({ member }, 201);
  } catch (err: any) {
    console.error('[rbac/add-member] error:', err?.message || err);
    return c.json({ error: 'Failed to add member', detail: err?.message }, 500);
  }
});

// ─── GET /workspaces/:workspaceId/members — list members ──────────────────────

rbacRoutes.get('/workspaces/:workspaceId/members', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const workspaceId = c.req.param('workspaceId');

  try {
    await ensureSchema();

    // Verify caller is a member (any role)
    const membership = await getMembership(workspaceId, user.id);
    if (!membership) return c.json({ error: 'Workspace not found or access denied' }, 404);

    const { rows } = await query(
      `SELECT m.workspace_id, m.user_id, m.role, m.added_at,
              p.email, p.full_name, p.avatar_url
       FROM writing_workspace_members m
       LEFT JOIN profiles p ON p.id = m.user_id
       WHERE m.workspace_id = $1
       ORDER BY m.added_at ASC`,
      [workspaceId],
    );

    return c.json({ members: rows });
  } catch (err: any) {
    console.error('[rbac/list-members] error:', err?.message || err);
    return c.json({ error: 'Failed to list members', detail: err?.message }, 500);
  }
});

// ─── DELETE /workspaces/:workspaceId/members/:userId — remove member ──────────

rbacRoutes.delete('/workspaces/:workspaceId/members/:userId', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const workspaceId = c.req.param('workspaceId');
  const targetUserId = c.req.param('userId');

  try {
    await ensureSchema();

    // Only owners may remove members
    const membership = await getMembership(workspaceId, user.id);
    if (!membership) return c.json({ error: 'Workspace not found or access denied' }, 404);
    if (!hasRole(membership.role, 'owner')) {
      return c.json({ error: 'Only workspace owners can remove members' }, 403);
    }

    // Prevent the owner from removing themselves (must transfer ownership first)
    if (targetUserId === user.id) {
      return c.json({ error: 'Cannot remove yourself as owner. Transfer ownership first.' }, 400);
    }

    const { rowCount } = await query(
      `DELETE FROM writing_workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, targetUserId],
    );

    if ((rowCount ?? 0) === 0) {
      return c.json({ error: 'Member not found in this workspace' }, 404);
    }

    console.log(`[rbac] removed member user=${targetUserId} from workspace=${workspaceId} by=${user.id}`);
    return c.json({ ok: true });
  } catch (err: any) {
    console.error('[rbac/remove-member] error:', err?.message || err);
    return c.json({ error: 'Failed to remove member', detail: err?.message }, 500);
  }
});

// ─── GET /workspaces/:workspaceId/documents — list documents in workspace ─────

rbacRoutes.get('/workspaces/:workspaceId/documents', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const workspaceId = c.req.param('workspaceId');

  try {
    await ensureSchema();

    // Verify caller is a member (any role)
    const membership = await getMembership(workspaceId, user.id);
    if (!membership) return c.json({ error: 'Workspace not found or access denied' }, 404);

    // Join writing_project_items with the workspace via the items' project owner being a workspace member.
    // For a workspace, "shared documents" are all writing_project_items belonging to any member of
    // this workspace — this is the natural team-document-sharing model.
    const { rows } = await query(
      `SELECT
         i.id,
         i.title,
         i.type,
         i.status,
         i.word_count,
         i.created_at,
         i.updated_at,
         p.id           AS project_id,
         p.name         AS project_name,
         m.user_id      AS author_id,
         pr.full_name   AS author_name
       FROM writing_project_items i
       JOIN writing_projects p
         ON p.id = i.project_id
       JOIN writing_workspace_members m
         ON m.workspace_id = $1 AND m.user_id = p.user_id
       LEFT JOIN profiles pr
         ON pr.id = p.user_id
       ORDER BY i.updated_at DESC
       LIMIT 200`,
      [workspaceId],
    );

    return c.json({ documents: rows, workspace_id: workspaceId });
  } catch (err: any) {
    console.error('[rbac/workspace-documents] error:', err?.message || err);
    return c.json({ error: 'Failed to list workspace documents', detail: err?.message }, 500);
  }
});
