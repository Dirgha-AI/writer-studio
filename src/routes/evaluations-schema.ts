import { query } from '../services/neon';

export async function ensureEvaluationsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS writing_item_evaluations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id UUID NOT NULL REFERENCES writing_project_items(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
      composite_score DECIMAL(4,2),
      process_score DECIMAL(4,2),
      evaluators_run TEXT[] DEFAULT '{}',
      comments JSONB DEFAULT '[]',
      scores JSONB DEFAULT '[]',
      consensus JSONB DEFAULT '[]',
      full_results JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_wie_item ON writing_item_evaluations(item_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wie_project ON writing_item_evaluations(project_id)`);
}
