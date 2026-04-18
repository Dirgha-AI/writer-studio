import { query } from '../services/neon';

export async function ensureResearchNotesSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS writing_research_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id UUID NOT NULL REFERENCES writing_project_items(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      source_type TEXT DEFAULT 'web',
      results JSONB DEFAULT '[]',
      synthesis TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_wrn_item ON writing_research_notes(item_id)`);
}
