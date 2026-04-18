# Writer Studio

**Open-source writing API for science, fiction, screenplays, and research.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](./LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%99%A1-ec4899?style=flat-square)](https://dirgha.ai/contribute)

---

Writer Studio is the backend API for the Dirgha OS writing environment. 30 route
files, 31 endpoints, all driven by a Hono server backed by Postgres (Neon) and
pluggable AI providers (Anthropic, OpenAI, Groq, NVIDIA).

It handles the complete writing lifecycle: create documents, manage projects,
organize chapters in a Binder, run AI research, generate academic content, produce
podcasts, render film scenes, and export to PDF/DOCX/LaTeX.

## What it does

| Module | Endpoints | Description |
|--------|-----------|-------------|
| **Documents** | `/api/writer/documents` | CRUD, semantic search, backlinks |
| **Projects** | `/api/writer/projects` | Writing project lifecycle (novel, paper, script) |
| **Binder** | `/api/writer/binder-items` | Scrivener-style nested chapter/scene tree |
| **Drafts** | `/api/writer/drafts` | Saved AI drafts per document |
| **Evaluations** | `/api/writer/evaluations` | AI manuscript evaluation + revision suggestions |
| **Versions** | `/api/writer/versions` | Document version history |
| **Export** | `/api/writer/export` | PDF, DOCX, Markdown, LaTeX, EPUB |
| **RAG** | `/api/writer/rag` | PDF upload + Qdrant vector search + AI chat over docs |
| **References** | `/api/writer/references` | Citation manager (BibTeX import, DOI fetch) |
| **Research Items** | `/api/writer/research-items` | Web search, source analysis, AI synthesis |
| **Autocomplete** | `/api/writer/autocomplete` | Ghost-text AI completions (800ms debounce) |
| **Worldbuilding** | `/api/writer/worldbuilding` | Entity extraction + behavior simulation |
| **Story Universes** | `/api/writer/story-universes` | Story universe CRUD |
| **Story Scenes** | `/api/writer/story-scenes` | Scene management + AI generation |
| **Story AI** | `/api/writer/story-ai` | PlotEmergence AI narrative engine |
| **Scientist** | `/api/writer/scientist` | Academic paper outline + methodology generation |
| **OCR** | `/api/writer/ocr` | Math OCR (photo → LaTeX), document OCR |
| **OpenAlex** | `/api/writer/openalex` | Academic paper search via OpenAlex API |
| **Backlinks** | `/api/writer/backlinks` | Document backlink graph |
| **RBAC** | `/api/writer/rbac` | Role-based access control per project |
| **Plagiarism** | `/api/writer/plagiarism` | Similarity detection |
| **Transcribe** | `/api/writer/transcribe` | Audio transcription (Whisper) |
| **Podcast** | `/api/writer/podcast` | Document-to-podcast generation (TTS) |
| **Film Studio** | `/api/writer/film-studio` | Script analysis + shot decomposition + render |

## Quick start

```bash
git clone https://github.com/dirghaai/writer-studio.git
cd writer-studio
npm install

# Required
export DATABASE_URL=postgres://user:pass@host:5432/writer

# AI providers (at least one)
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export GROQ_API_KEY=...
export NVIDIA_API_KEY=...

# Auth
export WRITER_API_KEYS=key1,key2   # comma-separated allowlist
# or: WRITER_OPEN=true             # open mode (no auth, dev only)

npm run dev
```

Server starts on port 3011 (override with `PORT=...`).

## Configuration

```bash
# Database
DATABASE_URL=postgres://...          # required

# AI providers
ANTHROPIC_API_KEY=...                # claude-* models
OPENAI_API_KEY=...                   # gpt-* models + TTS
GROQ_API_KEY=...                     # llama-* + mixtral models  
NVIDIA_API_KEY=...                   # minimax-m2.7 + kimi-k2 models

# Auth
WRITER_API_KEYS=key1,key2,key3       # Bearer token allowlist
WRITER_OPEN=true                     # disable auth (dev only)

# Optional integrations
QDRANT_URL=http://localhost:6333     # semantic search
QDRANT_API_KEY=...
S3_BUCKET=my-bucket                  # file uploads
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
ELEVENLABS_API_KEY=...               # podcast TTS (ElevenLabs)
CARTESIA_API_KEY=...                 # podcast TTS (Cartesia)
MIROFISH_URL=http://localhost:8400   # worldbuilding simulation (AGPL service)
CORS_ORIGIN=https://your-app.com    # CORS whitelist
PORT=3011                            # default port
```

## Auth

Default auth reads `WRITER_API_KEYS`. Each request must include:

```http
Authorization: Bearer <api-key>
```

Or bypass with `WRITER_OPEN=true` (for local dev only).

Replace `src/middleware/auth.ts` to wire in Supabase, Firebase, Better-auth,
or any other system. The interface is minimal:

```typescript
export async function getUser(c: Context): Promise<AuthUser | null>
```

## AI provider routing

`src/services/ai-router.ts` dispatches to providers based on model name prefix:
- `claude-*` → Anthropic
- `gpt-*` → OpenAI  
- `llama-*`, `mixtral-*`, `gemma-*` → Groq
- `minimaxai/*`, `kimi-*`, `deepseek-*` → NVIDIA

Call any endpoint with `model=claude-3-5-haiku-20241022` or `model=llama-3.3-70b-versatile`
and the router picks the right provider automatically.

## Database

Writer Studio uses Postgres for document storage. The route files issue raw SQL
against the following tables:

```sql
writer_documents          -- document CRUD
writing_projects          -- project metadata
writing_project_items     -- binder tree nodes
writer_drafts             -- AI draft storage
manuscript_projects       -- academic manuscripts
manuscript_chapters       -- chapter nodes
writer_versions           -- version snapshots
writer_references         -- citation library
writer_research_items     -- research notes
story_universes           -- story world definitions
story_scenes              -- scene library
```

Tables are created by the route files on first use (each has an `ensureSchema()` call).
Or run `npm run migrate` to initialize all tables upfront (script in `scripts/`).

## Source structure

```
src/
├── server.ts           # Hono server + route registration
├── config.ts           # Environment config
├── routes/             # 30 route files (one per domain)
│   ├── documents.ts    # Document CRUD + search
│   ├── projects.ts     # Project management
│   ├── binder-items.ts # Nested chapter/scene tree
│   ├── rag.ts          # RAG pipeline (PDF → Qdrant → AI chat)
│   ├── scientist.ts    # Academic writing assistance
│   ├── film-studio.ts  # Script analysis + shot render
│   └── ...             # 24 more
├── services/
│   ├── neon.ts         # Postgres connection pool
│   ├── ai-router.ts    # Multi-provider AI streaming
│   ├── user-docs.ts    # Per-user document indexing
│   ├── writer-context-builder.ts  # Context assembly for AI calls
│   ├── exif-strip.ts   # EXIF metadata removal
│   ├── credits.ts      # Credit deduction hooks
│   └── qdrant.ts       # Vector search client
└── middleware/
    ├── auth.ts          # Auth (replace with your system)
    └── billing-guard.ts # Billing (replace with your system)
```

## MiroFish (worldbuilding simulation)

MiroFish is a separate AGPL-3.0 service that runs entity behavior simulation for
the worldbuilding module. It communicates over HTTP only. When `MIROFISH_URL` is
not set, the worldbuilding endpoints fall back to direct AI simulation.

Never import MiroFish code directly — AGPL propagation applies to derivative works
that run as a network service. The bridge file (`src/routes/worldbuilding-mirofish.ts`)
communicates via HTTP only and is Apache-2.0 licensed.

## Development

```bash
npm install
npm run dev          # tsx watch src/server.ts (hot-reload)
npm run build        # tsc → dist/
npm run typecheck    # 0 errors
```

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md). New route adapters (integrations,
export formats, AI providers) are especially welcome.

## License

**Apache License 2.0.** Full text in [`LICENSE`](./LICENSE).

Commercial support, managed hosting, enterprise auth integrations:
email `sales@dirgha.ai`.

## Security

Found a vulnerability? Email `security@dirgha.ai`. Do NOT open a public issue.

---

Built by Dirgha LLC. Part of the Dirgha OS writing platform.

Website: https://dirgha.ai/writer  
Issues: https://github.com/dirghaai/writer-studio/issues

Copyright 2026 Dirgha LLC.
