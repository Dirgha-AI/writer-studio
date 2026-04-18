import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';

import { documentsRoutes } from './routes/documents';
import { projectRoutes } from './routes/projects';
import { binderItemRoutes } from './routes/binder-items';
import { draftRoutes } from './routes/drafts';
import { evaluationRoutes } from './routes/evaluations';
import { versionsRoutes } from './routes/versions';
import { exportRoutes } from './routes/export';
import { ragRoutes } from './routes/rag';
import { referencesRoutes } from './routes/references';
import { researchItemRoutes } from './routes/research-items';
import { autocompleteRoutes } from './routes/autocomplete';
import { worldbuildingRoutes } from './routes/worldbuilding';
import { storyUniverseRoutes } from './routes/story-universes';
import { storyScenesRoutes } from './routes/story-scenes';
import { storyAiRoutes } from './routes/story-ai';
import { scientistRoutes } from './routes/scientist';
import { ocrRoutes } from './routes/ocr';
import { openAlexRoutes } from './routes/openalex';
import { backlinksRoutes } from './routes/backlinks';
import { rbacRoutes } from './routes/rbac';
import { plagiarismRoutes } from './routes/plagiarism';
import { transcribeRoutes } from './routes/transcribe';
import { podcastRoutes } from './routes/podcast';
import { filmStudioRoutes } from './routes/film-studio';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: process.env.CORS_ORIGIN || '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-User-Id'],
}));

app.get('/api/health', (c) => c.json({ status: 'ok', service: 'writer-studio', version: '0.1.0' }));

app.route('/api/writer/documents', documentsRoutes);
app.route('/api/writer/projects', projectRoutes);
app.route('/api/writer/binder-items', binderItemRoutes);
app.route('/api/writer/drafts', draftRoutes);
app.route('/api/writer/evaluations', evaluationRoutes);
app.route('/api/writer/versions', versionsRoutes);
app.route('/api/writer/export', exportRoutes);
app.route('/api/writer/rag', ragRoutes);
app.route('/api/writer/references', referencesRoutes);
app.route('/api/writer/research-items', researchItemRoutes);
app.route('/api/writer/autocomplete', autocompleteRoutes);
app.route('/api/writer/worldbuilding', worldbuildingRoutes);
app.route('/api/writer/story-universes', storyUniverseRoutes);
app.route('/api/writer/story-scenes', storyScenesRoutes);
app.route('/api/writer/story-ai', storyAiRoutes);
app.route('/api/writer/scientist', scientistRoutes);
app.route('/api/writer/ocr', ocrRoutes);
app.route('/api/writer/openalex', openAlexRoutes);
app.route('/api/writer/backlinks', backlinksRoutes);
app.route('/api/writer/rbac', rbacRoutes);
app.route('/api/writer/plagiarism', plagiarismRoutes);
app.route('/api/writer/transcribe', transcribeRoutes);
app.route('/api/writer/podcast', podcastRoutes);
app.route('/api/writer/film-studio', filmStudioRoutes);

const port = parseInt(process.env.PORT || '3011', 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Writer Studio API running on port ${port}`);
});
