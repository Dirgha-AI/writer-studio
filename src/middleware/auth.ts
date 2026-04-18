/**
 * Auth middleware — simplified for standalone deployment.
 *
 * Supports three strategies:
 *   1. Bearer token matched against WRITER_API_KEYS env var (comma-separated)
 *   2. X-User-Id header (for trusted internal callers)
 *   3. Open mode (set WRITER_OPEN=true)
 *
 * Replace with your own auth (Supabase, Firebase, Better-auth, etc.)
 */
import type { Context } from 'hono';

export interface AuthUser {
  id: string;
  email: string;
  role?: string;
  plan?: string;
}

const API_KEYS = new Set(
  (process.env.WRITER_API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
);

const OPEN_MODE = process.env.WRITER_OPEN === 'true';

export async function getUser(c: Context): Promise<AuthUser | null> {
  if (OPEN_MODE) {
    return { id: 'anonymous', email: 'anonymous@local', role: 'user', plan: 'free' };
  }

  const userId = c.req.header('x-user-id');
  if (userId) {
    return { id: userId, email: `${userId}@internal`, role: 'user', plan: 'pro' };
  }

  const authHeader = c.req.header('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token || (API_KEYS.size > 0 && !API_KEYS.has(token))) {
    return null;
  }

  return { id: token.slice(0, 16), email: 'api@dirgha.ai', role: 'api', plan: 'pro' };
}

export function requireUser(c: Context, user: AuthUser | null): AuthUser {
  if (!user) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }
  return user;
}
