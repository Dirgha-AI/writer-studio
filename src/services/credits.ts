/**
 * credits.ts — AI credit management via direct SQL (replaces Supabase RPCs)
 */
import { query } from './neon'

export async function deductAiCredits(
  userId: string,
  amount: number,
  purpose: string
): Promise<{ success: boolean; remaining: number }> {
  const result = await query(
    `UPDATE profiles
     SET ai_credits = ai_credits - $2, updated_at = NOW()
     WHERE id = $1 AND ai_credits >= $2
     RETURNING ai_credits`,
    [userId, amount]
  )
  if (result.rows.length === 0) {
    return { success: false, remaining: 0 }
  }
  // Log the transaction
  await query(
    `INSERT INTO billing_transactions (user_id, amount, type, description, balance_after, created_at)
     VALUES ($1, $2, 'usage', $3, $4, NOW())`,
    [userId, -amount, purpose, result.rows[0].ai_credits]
  ).catch(() => {}) // fire-and-forget logging
  return { success: true, remaining: result.rows[0].ai_credits as number }
}

export async function addAiCredits(
  userId: string,
  amount: number,
  purpose: string
): Promise<{ success: boolean; balance: number }> {
  const result = await query(
    `UPDATE profiles
     SET ai_credits = ai_credits + $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ai_credits`,
    [userId, amount]
  )
  if (result.rows.length === 0) {
    return { success: false, balance: 0 }
  }
  await query(
    `INSERT INTO billing_transactions (user_id, amount, type, description, balance_after, created_at)
     VALUES ($1, $2, 'purchase', $3, $4, NOW())`,
    [userId, amount, purpose, result.rows[0].ai_credits]
  ).catch(() => {})
  return { success: true, balance: result.rows[0].ai_credits as number }
}

export async function getAiCredits(userId: string): Promise<number> {
  const result = await query(
    `SELECT ai_credits FROM profiles WHERE id = $1 LIMIT 1`,
    [userId]
  )
  return (result.rows[0]?.ai_credits as number) ?? 0
}
