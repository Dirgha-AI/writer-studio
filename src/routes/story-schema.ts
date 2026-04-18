/** Writer Story Engine — shared schema init. */
import { query } from '../services/neon';

export const STORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS story_universes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL,
    title      TEXT NOT NULL,
    logline    TEXT,
    genre      TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS story_acts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    universe_id UUID NOT NULL REFERENCES story_universes(id) ON DELETE CASCADE,
    act_number  INT NOT NULL DEFAULT 1,
    title       TEXT,
    summary     TEXT,
    beat_sheet  JSONB DEFAULT '[]',
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS story_entities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    universe_id UUID NOT NULL REFERENCES story_universes(id) ON DELETE CASCADE,
    type        TEXT NOT NULL DEFAULT 'character',
    name        TEXT NOT NULL,
    attributes  JSONB DEFAULT '{}',
    arc         TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS story_scenes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    act_id     UUID NOT NULL REFERENCES story_acts(id) ON DELETE CASCADE,
    sequence   INT NOT NULL DEFAULT 1,
    location   TEXT,
    characters TEXT[] DEFAULT '{}',
    content    TEXT,
    notes      TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

let ready = false;
export async function ensureStorySchema(): Promise<void> {
  if (ready) return; ready = true;
  await query(STORY_SCHEMA).catch(() => {});
}
