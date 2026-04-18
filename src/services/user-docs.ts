/**
 * user-docs.ts — per-user document indexing and search via local Qdrant.
 *
 * This is the user-facing equivalent of QMD.
 * QMD = admin/dev tool (Salik's 2,296 internal docs, never exposed to users)
 * user-docs = every user's private document search (Writer saves, uploads)
 *
 * Architecture:
 *   - Single Qdrant collection: "user_docs"
 *   - Each point has payload: { user_id, doc_id, title, chunk_index, source }
 *   - All searches filter by user_id — complete isolation
 *   - Embeddings: mem0's local model (BAAI/bge-small-en-v1.5, 384-dim)
 *     via mem0's embedding endpoint, or OpenRouter fallback
 */

import { randomUUID } from 'node:crypto'

const QDRANT_URL = process.env.QDRANT_LOCAL_URL ?? 'http://localhost:6333'
const MEM0_URL = process.env.MEM0_URL ?? 'http://localhost:8002'
const COLLECTION = 'user_docs'
const CHUNK_SIZE = 500   // characters per chunk
const CHUNK_OVERLAP = 50 // overlap between chunks

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[] | null> {
  // Try mem0's embedding endpoint first (local, free, 384-dim)
  try {
    const r = await fetch(`${MEM0_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    })
    if (r.ok) {
      const data = await r.json()
      if (Array.isArray(data.embedding)) return data.embedding
    }
  } catch {}

  // Fallback: OpenRouter text-embedding-3-small (1536-dim — won't match 384)
  // Only use if mem0 embed is unavailable AND you update collection to 1536-dim
  const openrouterKey = process.env.OPENROUTER_API_KEY
  if (!openrouterKey) return null
  try {
    const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openrouterKey}`,
      },
      body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: text }),
      signal: AbortSignal.timeout(10000),
    })
    if (r.ok) {
      const data = await r.json()
      return data.data?.[0]?.embedding ?? null
    }
  } catch {}
  return null
}

// ── Chunking ──────────────────────────────────────────────────────────────────

function chunkText(text: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE))
    start += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return chunks.filter(c => c.trim().length > 20)
}

// ── Index a document ──────────────────────────────────────────────────────────

export async function indexUserDoc(
  userId: string,
  docId: string,
  title: string,
  content: string,
  source: 'writer' | 'upload' | 'research' = 'writer'
): Promise<{ indexed: number; skipped: number }> {
  const chunks = chunkText(content)
  const points: any[] = []

  for (let i = 0; i < chunks.length; i++) {
    const vector = await embed(chunks[i])
    if (!vector) continue
    points.push({
      id: randomUUID(),
      vector,
      payload: {
        user_id: userId,
        doc_id: docId,
        title,
        chunk_index: i,
        chunk_total: chunks.length,
        text: chunks[i],
        source,
        indexed_at: new Date().toISOString(),
      },
    })
  }

  if (!points.length) return { indexed: 0, skipped: chunks.length }

  // Delete old chunks for this doc before re-indexing (handles updates)
  await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: {
        must: [
          { key: 'user_id', match: { value: userId } },
          { key: 'doc_id', match: { value: docId } },
        ],
      },
    }),
  }).catch(() => {})

  // Upsert new chunks
  const r = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
  })

  return { indexed: points.length, skipped: chunks.length - points.length }
}

// ── Search a user's documents ─────────────────────────────────────────────────

export interface UserDocResult {
  doc_id: string
  title: string
  text: string
  score: number
  source: string
}

export async function searchUserDocs(
  userId: string,
  query: string,
  limit = 5
): Promise<UserDocResult[]> {
  const vector = await embed(query)
  if (!vector) return []

  const r = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vector,
      limit,
      filter: {
        must: [{ key: 'user_id', match: { value: userId } }],
      },
      with_payload: true,
    }),
    signal: AbortSignal.timeout(5000),
  })

  if (!r.ok) return []
  const data = await r.json()
  return (data.result ?? []).map((p: any) => ({
    doc_id: p.payload.doc_id,
    title: p.payload.title,
    text: p.payload.text,
    score: p.score,
    source: p.payload.source,
  }))
}

// ── Delete a single document from the index ──────────────────────────────────

export async function deleteUserDoc(userId: string, docId: string): Promise<void> {
  await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: {
        must: [
          { key: 'user_id', match: { value: userId } },
          { key: 'doc_id', match: { value: docId } },
        ],
      },
    }),
  }).catch(() => {})
}

// ── Delete all docs for a user (account deletion / GDPR) ─────────��───────────

export async function deleteUserDocs(userId: string): Promise<void> {
  await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { must: [{ key: 'user_id', match: { value: userId } }] },
    }),
  }).catch(() => {})
}
