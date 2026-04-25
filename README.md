# Writer Studio

**Long-form writing studio — science, fiction, screenplays, research. Outline, manuscript, voice, and agents in one workspace.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](./LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%99%A1-ec4899?style=flat-square)](https://dirgha.ai/contribute)

---

Writer Studio is one workspace for the long form: papers, novels, screenplays, research notes. Outline in a Binder, draft in a real editor, talk to a research agent, dictate a chapter, export clean to PDF, DOCX, or LaTeX.

Open-source. Self-hostable. Pluggable AI providers (Anthropic, OpenAI, Groq, NVIDIA). Part of the [Dirgha AI OS](https://github.com/Dirgha-AI/Rama-I-Dirgha-AI-OS).

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

## Sister projects in the Dirgha OS

This repo is one of several products under the [Dirgha AI OS](https://github.com/Dirgha-AI/Rama-I-Dirgha-AI-OS) umbrella. Each repo stands on its own; together they compose a full stack for builders.

| Repo | What it does | License |
|---|---|---|
| [`Rama-I-Dirgha-AI-OS`](https://github.com/Dirgha-AI/Rama-I-Dirgha-AI-OS) | Vision & roadmap for our agentic, sovereign AI operating system. | Apache-2.0 |
| [`dirgha-code`](https://github.com/Dirgha-AI/dirgha-code) | AI coding agent for your terminal. Your keys, your machine, any model. | FSL-1.1-MIT |
| [`creator-studio`](https://github.com/Dirgha-AI/creator-studio) | Creator workspace — agents for production, posting, monetization. | Apache-2.0 |
| [`abundance-protocol`](https://github.com/Dirgha-AI/abundance-protocol) | Decentralized compute and labor network. Rent GPUs, run agents, settle on Bitcoin. | Apache-2.0 |
| [`arniko`](https://github.com/Dirgha-AI/arniko) | AI security scanner. Every tool, one unified report. | Apache-2.0 |

Visit the umbrella org at [github.com/Dirgha-AI](https://github.com/Dirgha-AI) or the product site at [dirgha.ai](https://dirgha.ai).

## License

**Apache License 2.0** — free for any use: personal, commercial, research, hosted, redistributed. No hidden restrictions, no conversion clause. Full text in [`LICENSE`](./LICENSE).

**Dirgha LLC owns the “Dirgha” name, logo, and product family** as registered trademarks. The code is open — the brand isn't. Forks of this repository must rename the product and remove Dirgha branding before distribution. Reasonable nominative use (“a fork of Writer Studio”) is fine.

See [`LICENSE`](./LICENSE) and [`NOTICE.md`](./NOTICE.md) for the full legal text. Related documents:

- [`SECURITY.md`](./SECURITY.md) — vulnerability disclosure policy.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.
- [`SUPPORT.md`](./SUPPORT.md) — where to ask for help.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to send a PR.


## Contribute

- **Code** — fork, branch, PR against `main`. Recipes in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Bugs** — file an issue using the [bug template](https://github.com/dirghaai/writer-studio/issues/new?template=bug.md).
- **Features** — file an issue using the [feature template](https://github.com/dirghaai/writer-studio/issues/new?template=feature.md).
- **Questions** — open a [Discussion](https://github.com/dirghaai/writer-studio/discussions) rather than an issue.
- **Security** — email `security@dirgha.ai`. Do NOT file a public issue for vulnerabilities.
- **Sponsor** — [dirgha.ai/contribute](https://dirgha.ai/contribute) · Lightning, GitHub Sponsors, OpenCollective.
- **First-time contributor?** Your first PR will ask you to sign the CLA (see [`CLA.md`](./CLA.md)). Small doc fixes don't need one.

## Links

| | |
|---|---|
| Website | [https://dirgha.ai/writer](https://dirgha.ai/writer) |
| Repository | [github.com/dirghaai/writer-studio](https://github.com/dirghaai/writer-studio) |
| Issues | [github.com/dirghaai/writer-studio/issues](https://github.com/dirghaai/writer-studio/issues) |
| Discussions | [github.com/dirghaai/writer-studio/discussions](https://github.com/dirghaai/writer-studio/discussions) |
| Security | `security@dirgha.ai` |
| Enterprise | `enterprise@dirgha.ai` |
| Press / general | `hello@dirgha.ai` |

---

**Writer Studio** is part of the Dirgha OS — open-source infrastructure for builders, shipped by a small bootstrapped team.

Built by [Dirgha LLC](https://dirgha.ai) in India. Open to the world.

Released under **Apache-2.0** · Copyright © 2026 Dirgha LLC · All third-party trademarks are property of their owners.

---

## 🌐 The Dirgha Ecosystem

**[Dirgha AI OS](https://github.com/Dirgha-AI/Rama-I-Dirgha-AI-OS)** — the agentic operating system. *Accelerate Abundance.*

| Repo | What it does |
|---|---|
| [Rama-I-Dirgha-AI-OS](https://github.com/Dirgha-AI/Rama-I-Dirgha-AI-OS) | Vision & roadmap for our agentic, sovereign AI operating system |
| [dirgha-code](https://github.com/Dirgha-AI/dirgha-code) | AI coding agent for your terminal |
| [writer-studio](https://github.com/Dirgha-AI/writer-studio) | Long-form writing studio — science, fiction, screenplays, research |
| [creator-studio](https://github.com/Dirgha-AI/creator-studio) | Creator workspace — agents for production, posting, monetization |
| [abundance-protocol](https://github.com/Dirgha-AI/abundance-protocol) | Decentralized compute and labor network |
| [arniko](https://github.com/Dirgha-AI/arniko) | AI security scanner — every tool, one unified report |
| [.github](https://github.com/Dirgha-AI/.github) | Org profile and community configuration |

- **Live platform:** [dirgha.ai](https://dirgha.ai) — chat, IDE, writer, research, library, marketplace, creator, education, manufacturing
- **Organization:** [github.com/Dirgha-AI](https://github.com/Dirgha-AI)
- **Partnerships:** [partner@dirgha.ai](mailto:partner@dirgha.ai)

*Dirgha — Accelerate Abundance. Built in India, for the world.*
