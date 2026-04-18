/**
 * Writer RAG — PDF / document chat pipeline
 *
 * POST /rag/upload         — ingest a PDF (or text file), chunk, embed, store in Qdrant
 * POST /rag/chat           — embed query, retrieve top-k chunks, stream answer via SSE
 * GET  /rag/documents      — list distinct document_ids stored for this user
 * DELETE /rag/documents/:documentId — remove all Qdrant points for a document
 *
 * Embeddings: text-embedding-3-small via LiteLLM (1536-dim, Qdrant collection: user_docs)
 * Chat: streamChat from ai-router with claude-sonnet-4-6
 *
 * @module writer/rag
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getUser } from '../middleware/auth';
import { streamChat, type ChatMessage } from '../services/ai-router';
import { checkBilling } from '../middleware/billing-guard';

export const ragRoutes = new Hono();

// ─── Config ──────────────────────────────────────────────────────────────────

const QDRANT_BASE = 'http://localhost:6333';
const QDRANT_COLLECTION = 'user_docs';

const LITELLM_BASE = process.env.LITELLM_API_BASE || 'http://localhost:4000';
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY || '';
const EMBED_MODEL = 'text-embedding-3-small';

const RAG_CHAT_MODEL = 'claude-sonnet-4-6';

/** Approximate token count: 1 token ≈ 4 characters */
const TOKENS_PER_CHUNK = 500;
const CHARS_PER_CHUNK = TOKENS_PER_CHUNK * 4; // 2000 chars
const CHUNK_OVERLAP = 200; // chars

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TOP_K = 5;

// ─── Qdrant helpers ──────────────────────────────────────────────────────────

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: {
    user_id: string;
    document_id: string;
    chunk_index: number;
    text: string;
    source: string;
  };
}

interface QdrantScoredPoint {
  id: string;
  score: number;
  payload: QdrantPoint['payload'];
}

async function qdrantUpsert(points: QdrantPoint[]): Promise<void> {
  const res = await fetch(`${QDRANT_BASE}/collections/${QDRANT_COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Qdrant upsert failed (${res.status}): ${detail}`);
  }
}

async function qdrantSearch(
  vector: number[],
  userId: string,
  documentId: string | undefined,
  limit: number,
): Promise<QdrantScoredPoint[]> {
  const mustFilters: any[] = [
    { key: 'user_id', match: { value: userId } },
  ];
  if (documentId) {
    mustFilters.push({ key: 'document_id', match: { value: documentId } });
  }

  const body: any = {
    vector,
    limit,
    with_payload: true,
    filter: { must: mustFilters },
  };

  const res = await fetch(`${QDRANT_BASE}/collections/${QDRANT_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Qdrant search failed (${res.status}): ${detail}`);
  }
  const data = await res.json() as { result: QdrantScoredPoint[] };
  return data.result ?? [];
}

/**
 * Scroll Qdrant to get all points for a user (for listing documents).
 * Uses pagination to handle large collections.
 */
async function qdrantScrollByUser(userId: string): Promise<Array<{ document_id: string; source: string }>> {
  const batchSize = 100;
  const seen = new Map<string, string>(); // document_id -> source
  let offset: string | number | null = null;

  while (true) {
    const body: any = {
      filter: { must: [{ key: 'user_id', match: { value: userId } }] },
      limit: batchSize,
      with_payload: ['document_id', 'source'],
      with_vector: false,
    };
    if (offset !== null) {
      body.offset = offset;
    }

    const res = await fetch(`${QDRANT_BASE}/collections/${QDRANT_COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Qdrant scroll failed (${res.status}): ${detail}`);
    }

    const data = await res.json() as { result: { points: Array<{ payload: any }>; next_page_offset: any } };
    const points = data.result?.points ?? [];

    for (const pt of points) {
      const docId = pt.payload?.document_id;
      const src = pt.payload?.source ?? '';
      if (docId && !seen.has(docId)) {
        seen.set(docId, src);
      }
    }

    offset = data.result?.next_page_offset ?? null;
    if (offset === null || points.length < batchSize) break;
  }

  return Array.from(seen.entries()).map(([document_id, source]) => ({ document_id, source }));
}

/** Delete all Qdrant points matching user_id + document_id */
async function qdrantDeleteDocument(userId: string, documentId: string): Promise<number> {
  const body = {
    filter: {
      must: [
        { key: 'user_id', match: { value: userId } },
        { key: 'document_id', match: { value: documentId } },
      ],
    },
  };

  const res = await fetch(`${QDRANT_BASE}/collections/${QDRANT_COLLECTION}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Qdrant delete failed (${res.status}): ${detail}`);
  }
  const data = await res.json() as { result?: { operation_id?: number } };
  return data.result?.operation_id ?? 0;
}

// ─── Embedding helper ─────────────────────────────────────────────────────────

/**
 * Embed one or more text strings via LiteLLM → text-embedding-3-small.
 * Returns an array of float vectors, one per input string.
 */
async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const res = await fetch(`${LITELLM_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LITELLM_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Embedding request failed (${res.status}): ${detail}`);
  }

  const data = await res.json() as { data: Array<{ embedding: number[]; index: number }> };
  if (!Array.isArray(data.data) || data.data.length === 0) {
    throw new Error('Embedding API returned no vectors');
  }

  // Sort by index to preserve order
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

// ─── Text chunking ────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks of ~CHARS_PER_CHUNK characters.
 * Splits at paragraph or sentence boundaries when possible.
 */
function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= CHARS_PER_CHUNK) return [normalized];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < normalized.length) {
    const end = Math.min(pos + CHARS_PER_CHUNK, normalized.length);
    let slice = normalized.slice(pos, end);

    // If not at the very end, try to break at a paragraph or sentence boundary
    if (end < normalized.length) {
      const paraBreak = slice.lastIndexOf('\n\n');
      const sentBreak = slice.search(/[.!?]\s+[A-Z]/);
      const newlineBreak = slice.lastIndexOf('\n');

      if (paraBreak > CHARS_PER_CHUNK * 0.5) {
        slice = normalized.slice(pos, pos + paraBreak + 2);
      } else if (sentBreak > CHARS_PER_CHUNK * 0.5) {
        slice = normalized.slice(pos, pos + sentBreak + 2);
      } else if (newlineBreak > CHARS_PER_CHUNK * 0.5) {
        slice = normalized.slice(pos, pos + newlineBreak + 1);
      }
    }

    const trimmed = slice.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }

    // Advance with overlap so consecutive chunks share context
    const advance = Math.max(slice.length - CHUNK_OVERLAP, 1);
    pos += advance;
  }

  return chunks;
}

// ─── PDF text extraction ──────────────────────────────────────────────────────

/**
 * Extract plain text from a file buffer.
 * Attempts pdf-parse for PDF files; falls back to UTF-8 text decode for others.
 */
async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const isPdf =
    filename.toLowerCase().endsWith('.pdf') ||
    (buffer.length >= 5 && buffer.slice(0, 5).toString('ascii') === '%PDF-');

  if (isPdf) {
    try {
      // pdf-parse is an optional dependency — import dynamically so non-PDF paths don't error
      const pdfParse = (await import('pdf-parse')).default;
      const parsed = await pdfParse(buffer);
      return parsed.text ?? '';
    } catch (err: any) {
      console.warn('[writer/rag] pdf-parse failed, falling back to UTF-8 decode:', err?.message);
    }
  }

  // For text-based files (markdown, txt, etc.) or pdf-parse failure
  return buffer.toString('utf-8');
}

// ─── Route 1: POST /rag/upload ────────────────────────────────────────────────

ragRoutes.post('/rag/upload', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch (err: any) {
    return c.json({ error: 'Failed to parse multipart body', detail: err?.message }, 400);
  }

  const file = body['file'];
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Missing or invalid "file" field in multipart body' }, 400);
  }

  if (file.size > MAX_FILE_BYTES) {
    return c.json({ error: `File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)` }, 413);
  }

  // Use provided document_id or derive from filename + timestamp
  const documentId: string =
    (typeof body['document_id'] === 'string' && body['document_id'].trim())
      ? body['document_id'].trim()
      : `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  const source = file.name;

  try {
    // 1. Read file buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 2. Extract text
    const text = await extractText(buffer, file.name);
    if (!text || text.trim().length < 10) {
      return c.json({ error: 'Could not extract meaningful text from the file' }, 422);
    }

    // 3. Chunk text
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return c.json({ error: 'Document produced no text chunks' }, 422);
    }

    // 4. Embed in batches of 20 to avoid request size limits
    const BATCH_SIZE = 20;
    const allVectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const vecs = await embedTexts(batch);
      allVectors.push(...vecs);
    }

    if (allVectors.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${allVectors.length}`);
    }

    // 5. Build Qdrant points
    const points: QdrantPoint[] = chunks.map((text, idx) => ({
      id: crypto.randomUUID(),
      vector: allVectors[idx],
      payload: {
        user_id: user.id,
        document_id: documentId,
        chunk_index: idx,
        text,
        source,
      },
    }));

    // 6. Upsert into Qdrant
    await qdrantUpsert(points);

    console.log(`[writer/rag/upload] user=${user.id} doc=${documentId} chunks=${chunks.length}`);
    return c.json({ ok: true, document_id: documentId, chunks_stored: chunks.length });
  } catch (err: any) {
    console.error('[writer/rag/upload] Error:', err?.message || err);
    return c.json({ error: 'Upload and indexing failed', detail: err?.message }, 500);
  }
});

// ─── Route 2: POST /rag/chat (SSE stream) ────────────────────────────────────

ragRoutes.post('/rag/chat', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const billing = await checkBilling(user.id, RAG_CHAT_MODEL);
  if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

  let body: { query?: string; document_id?: string; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const query = body.query?.trim();
  if (!query) return c.json({ error: '"query" is required' }, 400);

  const documentId = body.document_id?.trim() || undefined;
  const limit = Math.min(Math.max(body.limit ?? DEFAULT_TOP_K, 1), 20);

  return streamSSE(c, async (stream) => {
    try {
      // 1. Embed the query
      const [queryVector] = await embedTexts([query]);

      // 2. Retrieve top-k chunks from Qdrant
      const hits = await qdrantSearch(queryVector, user.id, documentId, limit);

      if (hits.length === 0) {
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({
            type: 'error',
            content: documentId
              ? `No indexed content found for document "${documentId}". Please upload the document first.`
              : 'No indexed documents found for your account. Please upload a document first.',
          }),
        });
        return;
      }

      // 3. Build context from retrieved chunks
      const contextBlocks = hits
        .map((hit, idx) => {
          const src = hit.payload?.source ?? 'document';
          const chunkIdx = hit.payload?.chunk_index ?? idx;
          const score = hit.score.toFixed(3);
          const text = hit.payload?.text ?? '';
          return `[Source: ${src}, chunk ${chunkIdx}, relevance: ${score}]\n${text}`;
        })
        .join('\n\n---\n\n');

      const systemPrompt = `You are a knowledgeable research assistant. You answer questions based strictly on the provided document excerpts.

Rules:
- Answer only from the provided context. If the context doesn't contain enough information, say so clearly.
- Quote or reference specific parts of the context when relevant.
- Be concise and precise.
- If the user asks something unrelated to the context, politely redirect them to ask about the document content.

Document context:
---
${contextBlocks}
---`;

      const messages: ChatMessage[] = [
        { role: 'user', content: query },
      ];

      // 4. Stream the answer
      const gen = streamChat(messages, RAG_CHAT_MODEL, undefined, {
        systemPrompt,
        temperature: 0.3,
      });

      // Send source chunks metadata first so the client can render citations
      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify({
          type: 'sources',
          sources: hits.map((h) => ({
            document_id: h.payload?.document_id,
            source: h.payload?.source,
            chunk_index: h.payload?.chunk_index,
            score: h.score,
            excerpt: (h.payload?.text ?? '').slice(0, 200),
          })),
        }),
      });

      for await (const chunk of gen) {
        if (chunk.type === 'text' || chunk.type === 'content_block_delta') {
          const text = chunk.content || (chunk as any).delta?.text || '';
          if (text) {
            await stream.writeSSE({
              event: 'message',
              data: JSON.stringify({ type: 'text', content: text }),
            });
          }
        } else if (chunk.type === 'error') {
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify({ type: 'error', content: chunk.content }),
          });
          break;
        } else if (chunk.type === 'done') {
          break;
        }
      }

      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify({ type: 'done' }),
      });
    } catch (err: any) {
      console.error('[writer/rag/chat] Stream error:', err?.message || err);
      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify({ type: 'error', content: err?.message || 'RAG chat failed' }),
      });
    }
  });
});

// ─── Route 3: GET /rag/documents ─────────────────────────────────────────────

ragRoutes.get('/rag/documents', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const documents = await qdrantScrollByUser(user.id);
    return c.json({ documents });
  } catch (err: any) {
    console.error('[writer/rag/documents] Error:', err?.message || err);
    return c.json({ error: 'Failed to list documents', detail: err?.message }, 500);
  }
});

// ─── Route 4: DELETE /rag/documents/:documentId ───────────────────────────────

ragRoutes.delete('/rag/documents/:documentId', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const documentId = c.req.param('documentId');
  if (!documentId || documentId.trim().length === 0) {
    return c.json({ error: 'documentId path parameter is required' }, 400);
  }

  try {
    await qdrantDeleteDocument(user.id, documentId.trim());
    console.log(`[writer/rag/delete] user=${user.id} doc=${documentId}`);
    return c.json({ ok: true, deleted_document_id: documentId });
  } catch (err: any) {
    console.error('[writer/rag/delete] Error:', err?.message || err);
    return c.json({ error: 'Failed to delete document', detail: err?.message }, 500);
  }
});
