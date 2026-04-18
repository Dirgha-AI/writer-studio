# Contributing to Writer Studio

Thanks for helping. Writer Studio is open-source writing infrastructure.

## Before your first PR

Include in your PR description:
> I have read and agree to the Dirgha AI Contributor License Agreement
> at CLA.md, and I submit this Contribution under those terms.

## What belongs here

- New route files (new writing domains, export formats, integrations)
- AI provider adapters in `src/services/ai-router.ts`
- Database schema improvements
- Auth middleware implementations (Supabase, Better-auth, Clerk, etc.)
- Export format improvements (LaTeX, EPUB, HTML)

## Pull requests

- Branch from `main`
- `npm run typecheck` — zero TypeScript errors
- One PR per concern
- Document new environment variables in README

## Questions

- Issues: https://github.com/dirghaai/writer-studio/issues
- Security: security@dirgha.ai
- General: team@dirgha.ai
