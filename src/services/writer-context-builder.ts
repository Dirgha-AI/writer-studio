/**
 * WriterContextBuilder — assembles rich context for Writer AI calls.
 *
 * Pulls from:
 *   1. Active document (writer_documents)
 *   2. Project binder   (writing_projects + writing_project_items)
 *   3. Manuscript pipeline (manuscript_projects + manuscript_chapters)
 *   4. Story universe    (story_universes + story_entities)
 *   5. Vector similarity (Qdrant, if configured)
 *   6. User preferences  (profiles metadata)
 *
 * Each data source is independent — swap or disable any one without
 * affecting the others.  Every function catches its own errors and
 * returns an empty string on failure so the AI call always proceeds.
 *
 * @module services/writer-context-builder
 */

import { query } from './neon';
import { searchDocuments, formatRAGContext } from './qdrant';
import { searchUserDocs } from './user-docs';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WriterContextOpts {
  /** Authenticated user id (Firebase uid / Supabase id). */
  userId: string;
  /** The user's current prompt or the text around the cursor. */
  prompt: string;
  /** UUID of the active writer_documents row (standalone editor). */
  documentId?: string;
  /** UUID of a writing_projects row (Scrivener binder). */
  projectId?: string;
  /** UUID of a manuscript_projects row (manuscript pipeline). */
  manuscriptId?: string;
  /** UUID of a story_universes row (story engine). */
  universeId?: string;
  /** Approximate token budget for the assembled context. Default 4 000. */
  maxTokens?: number;
}

// ── Data Source 1: Active Document ───────────────────────────────────────────

async function getDocumentContext(
  docId: string,
  userId: string,
): Promise<string> {
  const { rows } = await query(
    `SELECT title, content
       FROM writer_documents
      WHERE id = $1
        AND user_id = $2
        AND deleted_at IS NULL
      LIMIT 1`,
    [docId, userId],
  );

  if (!rows[0]) return '';

  const title: string = rows[0].title || 'Untitled';
  const raw: string = rows[0].content || '';
  // Strip HTML tags for a clean text preview
  const plain = raw.replace(/<[^>]*>/g, '').trim();
  const truncated = plain.length > 2000 ? plain.slice(0, 2000) + '...' : plain;

  return `## Current Document\nTitle: ${title}\n\n${truncated}`;
}

// ── Data Source 2: Writing Project Binder ────────────────────────────────────

async function getProjectContext(
  projectId: string,
  userId: string,
): Promise<string> {
  // Fetch the project header
  const { rows: projRows } = await query(
    `SELECT title, project_type, description, word_count_goal, settings
       FROM writing_projects
      WHERE id = $1
        AND user_id = $2
      LIMIT 1`,
    [projectId, userId],
  );

  if (!projRows[0]) return '';

  const proj = projRows[0];

  // Fetch top-level binder items (up to 30) to give structure overview
  const { rows: items } = await query(
    `SELECT title, item_type, sort_order, word_count
       FROM writing_project_items
      WHERE project_id = $1
      ORDER BY sort_order
      LIMIT 30`,
    [projectId],
  );

  const itemList = items
    .map(
      (i: any) =>
        `- [${i.item_type}] ${i.title}${i.word_count ? ` (${i.word_count} words)` : ''}`,
    )
    .join('\n');

  const goalNote = proj.word_count_goal
    ? `\nWord-count goal: ${proj.word_count_goal}`
    : '';
  const descNote = proj.description ? `\nDescription: ${proj.description}` : '';

  return (
    `## Project Context\n` +
    `Project: ${proj.title} (${proj.project_type})` +
    descNote +
    goalNote +
    `\n\nBinder:\n${itemList || '(empty)'}`
  );
}

// ── Data Source 3: Manuscript Pipeline ───────────────────────────────────────

async function getManuscriptContext(
  manuscriptId: string,
  userId: string,
): Promise<string> {
  const { rows: projRows } = await query(
    `SELECT title, status, total_words, total_chapters, pipeline_state
       FROM manuscript_projects
      WHERE id = $1
        AND user_id = $2::uuid
      LIMIT 1`,
    [manuscriptId, userId],
  );

  if (!projRows[0]) return '';
  const mp = projRows[0];

  // Fetch chapter titles (up to 50)
  const { rows: chapters } = await query(
    `SELECT chapter_number, title, word_count, status, current_score
       FROM manuscript_chapters
      WHERE project_id = $1
      ORDER BY chapter_number
      LIMIT 50`,
    [manuscriptId],
  );

  const chapterList = chapters
    .map(
      (ch: any) =>
        `- Ch ${ch.chapter_number}: ${ch.title || 'Untitled'} ` +
        `[${ch.status}]` +
        (ch.word_count ? ` ${ch.word_count}w` : '') +
        (ch.current_score ? ` score:${ch.current_score}` : ''),
    )
    .join('\n');

  return (
    `## Manuscript\n` +
    `Title: ${mp.title} | Status: ${mp.status}\n` +
    `Words: ${mp.total_words || 0} | Chapters: ${mp.total_chapters || 0}\n` +
    `\n${chapterList || '(no chapters yet)'}`
  );
}

// ── Data Source 4: Story Universe ────────────────────────────────────────────

async function getUniverseContext(
  universeId: string,
  userId: string,
): Promise<string> {
  const { rows: uRows } = await query(
    `SELECT title, logline, genre
       FROM story_universes
      WHERE id = $1
        AND user_id = $2::uuid
      LIMIT 1`,
    [universeId, userId],
  );

  if (!uRows[0]) return '';
  const u = uRows[0];

  // Characters + key entities (up to 20)
  const { rows: entities } = await query(
    `SELECT name, type, arc
       FROM story_entities
      WHERE universe_id = $1
      ORDER BY type, name
      LIMIT 20`,
    [universeId],
  );

  const entityList = entities
    .map(
      (e: any) =>
        `- [${e.type}] ${e.name}${e.arc ? ` — ${e.arc}` : ''}`,
    )
    .join('\n');

  const genreStr = Array.isArray(u.genre) ? u.genre.join(', ') : '';

  return (
    `## Story Universe\n` +
    `Title: ${u.title}\n` +
    (u.logline ? `Logline: ${u.logline}\n` : '') +
    (genreStr ? `Genre: ${genreStr}\n` : '') +
    (entityList ? `\nEntities:\n${entityList}` : '')
  );
}

// ── Data Source 5: Vector Similarity (Qdrant) ────────────────────────────────

async function getSimilarContent(
  queryText: string,
  userId: string,
  limit: number,
): Promise<string> {
  // Dual search: Search both global documents and user's private docs
  const [globalResults, userResults] = await Promise.all([
    searchDocuments(queryText, userId, limit).catch(() => []),
    searchUserDocs(userId, queryText, limit).catch(() => []),
  ]);

  if (globalResults.length === 0 && userResults.length === 0) return '';

  let context = '## Related Content\n';
  
  if (globalResults.length > 0) {
    context += `### Research Library\n${formatRAGContext(globalResults)}\n`;
  }
  
  if (userResults.length > 0) {
    context += `### Your Private Documents\n`;
    userResults.forEach(res => {
      context += `--- ${res.title} ---\n${res.text}\n\n`;
    });
  }

  return context;
}

// ── Data Source 6: User Preferences ──────────────────────────────────────────

async function getUserPreferences(userId: string): Promise<string> {
  // profiles lives in Supabase, but we can read it via Neon if both point at
  // the same Postgres — or just try and fail gracefully.  Some installs have
  // a `user_preferences` table; others store prefs in profiles.metadata.
  try {
    const { rows } = await query(
      `SELECT metadata FROM profiles WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows[0]?.metadata) return '';

    const meta = typeof rows[0].metadata === 'string'
      ? JSON.parse(rows[0].metadata)
      : rows[0].metadata;

    const parts: string[] = [];
    if (meta.preferred_model)   parts.push(`Model: ${meta.preferred_model}`);
    if (meta.writing_tone)      parts.push(`Tone: ${meta.writing_tone}`);
    if (meta.writing_style)     parts.push(`Style: ${meta.writing_style}`);
    if (meta.language)          parts.push(`Language: ${meta.language}`);

    return parts.length > 0
      ? `## User Preferences\n${parts.join('\n')}`
      : '';
  } catch {
    // profiles table may not exist in Neon — that is fine
    return '';
  }
}

// ── Token Estimation ─────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build complete context for a Writer AI call.
 *
 * Every data source is fetched in parallel.  Each catches its own errors
 * and returns an empty string on failure, so the outer call never throws
 * and the AI request always proceeds (with whatever context was available).
 *
 * @returns Assembled context string ready to inject into a system prompt
 *          or as `additionalContext` in `streamChat()`.
 */
export async function buildWriterContext(
  opts: WriterContextOpts,
): Promise<string> {
  const {
    userId,
    prompt,
    documentId,
    projectId,
    manuscriptId,
    universeId,
    maxTokens = 4000,
  } = opts;

  // Fire all data sources in parallel — each handles its own failures
  const [docCtx, projCtx, msCtx, uniCtx, simCtx, prefCtx] =
    await Promise.all([
      documentId
        ? getDocumentContext(documentId, userId).catch(() => '')
        : Promise.resolve(''),
      projectId
        ? getProjectContext(projectId, userId).catch(() => '')
        : Promise.resolve(''),
      manuscriptId
        ? getManuscriptContext(manuscriptId, userId).catch(() => '')
        : Promise.resolve(''),
      universeId
        ? getUniverseContext(universeId, userId).catch(() => '')
        : Promise.resolve(''),
      getSimilarContent(prompt, userId, 3).catch(() => ''),
      getUserPreferences(userId).catch(() => ''),
    ]);

  // Assemble in priority order: doc > project > manuscript > universe > similar > prefs
  const parts = [docCtx, projCtx, msCtx, uniCtx, simCtx, prefCtx].filter(
    Boolean,
  );
  let context = parts.join('\n\n');

  // Truncate to token budget (rough: 4 chars per token)
  const charLimit = maxTokens * 4;
  if (context.length > charLimit) {
    context = context.slice(0, charLimit) + '\n[...context truncated]';
  }

  return context;
}

/**
 * Convenience: returns a token-estimate alongside the context.
 * Useful when the caller needs to decide whether to trim messages.
 */
export async function buildWriterContextWithMeta(
  opts: WriterContextOpts,
): Promise<{ context: string; tokenEstimate: number }> {
  const context = await buildWriterContext(opts);
  return { context, tokenEstimate: estimateTokens(context) };
}
