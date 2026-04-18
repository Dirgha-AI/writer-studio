/**
 * Neon/Postgres — connection pool + query helper.
 *
 * Set NEON_DATABASE_URL or DATABASE_URL to connect.
 */
import { Pool } from 'pg';

const neonUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!neonUrl) {
  console.warn('[DB] No DATABASE_URL set — some endpoints will fail at runtime.');
}

const pool = neonUrl
  ? new Pool({
      connectionString: neonUrl.includes('sslmode=')
        ? neonUrl
        : neonUrl + (neonUrl.includes('?') ? '&' : '?') + 'sslmode=require',
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  : null;

export { pool };

export const query = (text: string, params: any[] = []) => {
  if (!pool) throw new Error('[DB] No database connection — set DATABASE_URL');
  return pool.query(text, params);
};

export async function queryAsUser(userId: string, text: string, params: any[] = []) {
  if (!pool) throw new Error('[DB] No database connection — set DATABASE_URL');
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

export const neon = { query };
