import { query } from '../services/neon';

export async function ensureWritingProjectSchema() {
  // Main project table
  await query(`
    CREATE TABLE IF NOT EXISTS writing_projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled Project',
      project_type TEXT NOT NULL DEFAULT 'general',
      description TEXT DEFAULT '',
      settings JSONB DEFAULT '{}',
      word_count_goal INT DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Binder tree items (self-referencing for hierarchy)
  await query(`
    CREATE TABLE IF NOT EXISTS writing_project_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES writing_project_items(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL DEFAULT 'document',
      title TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT DEFAULT '',
      sort_order INT DEFAULT 0,
      status TEXT DEFAULT 'draft',
      word_count INT DEFAULT 0,
      word_count_goal INT DEFAULT 0,
      compile BOOLEAN DEFAULT true,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_wp_user ON writing_projects(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wpi_project ON writing_project_items(project_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wpi_parent ON writing_project_items(parent_id)`);
}
