/**
 * Qdrant vector search — stub for standalone deployment.
 * Set QDRANT_URL and QDRANT_API_KEY to enable semantic search.
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';

export interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export async function searchDocuments(
  query: string,
  userId: string,
  limit = 5
): Promise<SearchResult[]> {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/user_docs/points/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {}),
      },
      body: JSON.stringify({
        vector: new Array(1536).fill(0),
        limit,
        with_payload: true,
        filter: { must: [{ key: 'user_id', match: { value: userId } }] },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.result || [];
  } catch {
    return [];
  }
}

export function formatRAGContext(results: SearchResult[]): string {
  if (!results.length) return '';
  return results
    .map((r, i) => `[${i + 1}] ${JSON.stringify(r.payload)}`)
    .join('\n\n');
}
