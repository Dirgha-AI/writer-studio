/**
 * Writer — OpenAlex Reference Search
 *
 * GET /references/openalex?query=X&page=1&per_page=20
 *   → Proxy to https://api.openalex.org/works, flatten inverted-index abstracts,
 *     and return a normalised reference list.
 *
 * Caching: 5-minute in-memory cache keyed on normalised query+page+per_page.
 * No API key required for OpenAlex (polite pool via User-Agent header).
 *
 * @module writer/openalex
 */

import { Hono } from 'hono';
import { getUser } from '../middleware/auth';

export const openAlexRoutes = new Hono();

// ─── In-memory cache ─────────────────────────────────────────────────────────

interface CacheEntry {
  data: OpenAlexResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

function getCacheKey(query: string, page: number, perPage: number): string {
  return `${query.toLowerCase().trim()}|${page}|${perPage}`;
}

function getCached(key: string): OpenAlexResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: OpenAlexResponse): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Periodically evict expired entries so the map does not grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (now > v.expiresAt) cache.delete(k);
  }
}, CACHE_TTL_MS);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Reference {
  id: string;
  title: string;
  authors: string[];
  publication_year: number | null;
  doi: string | null;
  abstract: string | null;
  open_alex_url: string;
}

interface OpenAlexResponse {
  results: Reference[];
  total: number;
  page: number;
  per_page: number;
}

// ─── Abstract inversion helper ────────────────────────────────────────────────

/**
 * OpenAlex stores abstracts as an inverted index:
 *   { "The": [0, 5], "cat": [1], "sat": [2], ... }
 * This function reconstructs the plain-text abstract from that structure.
 * Returns null if the index is null/empty/malformed.
 */
function invertAbstract(invertedIndex: Record<string, number[]> | null | undefined): string | null {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;

  const entries = Object.entries(invertedIndex);
  if (entries.length === 0) return null;

  // Build a position-to-word map
  const positionMap = new Map<number, string>();
  for (const [word, positions] of entries) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === 'number') {
        positionMap.set(pos, word);
      }
    }
  }

  if (positionMap.size === 0) return null;

  const maxPos = Math.max(...positionMap.keys());
  const words: string[] = [];
  for (let i = 0; i <= maxPos; i++) {
    words.push(positionMap.get(i) ?? '');
  }

  return words.join(' ').trim() || null;
}

// ─── Route: GET /references/openalex ─────────────────────────────────────────

openAlexRoutes.get('/references/openalex', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const rawQuery = (c.req.query('query') ?? c.req.query('q') ?? '').trim();
  const query = rawQuery;
  if (!query) return c.json({ error: '"query" or "q" parameter is required' }, 400);

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const perPage = Math.max(1, Math.min(50, parseInt(c.req.query('per_page') ?? '20', 10) || 20));

  // ── Cache check ────────────────────────────────────────────────────────────
  const cacheKey = getCacheKey(query, page, perPage);
  const cached = getCached(cacheKey);
  if (cached) {
    return c.json({ ...cached, cached: true });
  }

  // ── Build OpenAlex request ─────────────────────────────────────────────────
  const selectedFields = [
    'id',
    'title',
    'authorships',
    'publication_year',
    'doi',
    'abstract_inverted_index',
  ].join(',');

  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('select', selectedFields);

  let rawData: any;
  try {
    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Dirgha/1.0 (https://dirgha.ai)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[openalex] Upstream error ${res.status}:`, detail.slice(0, 200));
      return c.json({ error: `OpenAlex returned status ${res.status}` }, 502);
    }

    rawData = await res.json();
  } catch (err: any) {
    console.error('[openalex] Fetch error:', err?.message || err);
    return c.json({ error: 'Failed to reach OpenAlex API', detail: err?.message }, 502);
  }

  // ── Transform response ─────────────────────────────────────────────────────
  const meta = rawData?.meta ?? {};
  const total: number = meta.count ?? 0;

  const works: any[] = Array.isArray(rawData?.results) ? rawData.results : [];

  const results: Reference[] = works.map((work: any) => {
    // Authors: flatten from authorships array
    const authors: string[] = [];
    if (Array.isArray(work.authorships)) {
      for (const authorship of work.authorships) {
        const displayName = authorship?.author?.display_name;
        if (displayName && typeof displayName === 'string') {
          authors.push(displayName);
        }
      }
    }

    // DOI: strip URL prefix to return bare DOI
    let doi: string | null = null;
    if (work.doi && typeof work.doi === 'string') {
      doi = work.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim() || null;
    }

    // Abstract: reconstruct from inverted index
    const abstract = invertAbstract(work.abstract_inverted_index);

    // OpenAlex canonical URL
    const openAlexUrl: string = typeof work.id === 'string' ? work.id : '';

    return {
      id: openAlexUrl,
      title: typeof work.title === 'string' ? work.title : 'Untitled',
      authors,
      publication_year: typeof work.publication_year === 'number' ? work.publication_year : null,
      doi,
      abstract,
      open_alex_url: openAlexUrl,
    };
  });

  const response: OpenAlexResponse = { results, total, page, per_page: perPage };

  // ── Cache and return ───────────────────────────────────────────────────────
  setCache(cacheKey, response);

  console.log(`[openalex] user=${user.id} query="${query}" page=${page} hits=${results.length}/${total}`);
  return c.json(response);
});
