import { query } from '../services/neon';

export async function ensureDraftsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS writing_item_drafts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id UUID NOT NULL REFERENCES writing_project_items(id) ON DELETE CASCADE,
      parent_draft_id UUID REFERENCES writing_item_drafts(id) ON DELETE SET NULL,
      branch_name TEXT DEFAULT 'main',
      content TEXT DEFAULT '',
      word_count INT DEFAULT 0,
      model_source TEXT DEFAULT 'human',
      generation_prompt TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      score DECIMAL(4,2),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_wid_item ON writing_item_drafts(item_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wid_parent ON writing_item_drafts(parent_draft_id)`);
}
