## Where agent instructions live

Agent instructions are **distributed**: this file covers repo-wide rules; apps and packages can have their own `AGENTS.md` with local instructions. When working in an app or package, read both the root AGENTS.md and that folder's AGENTS.md (if present).

- **Root** (this file): architecture, ADRs, code style.
- **apps/backend**: [apps/backend/AGENTS.md](apps/backend/AGENTS.md) — API, OpenAPI, MCP, Drizzle, TypeScript, etc.

**When feedback is given that should become a long-term instruction**: Save it into this structure. Repo-wide preferences and conventions go in this file (root AGENTS.md). Instructions that apply only to a specific app or package go in that folder's `AGENTS.md` (e.g. `apps/backend/AGENTS.md`); create the file if it doesn't exist. Add or update the list above when you create or change an app/package AGENTS.md so future agents know where to look.

## Architecture decisions & ADRs

- **Where ADRs live**: Cross-cutting decisions are in the root `adr/` directory. **App- and package-specific ADRs** live in their own `adr/` subfolder (e.g. `apps/backend/adr/`, `packages/foo/adr/`). Start with `adr/README.md` for naming, structure, and when to add an ADR.
- **When you change architecture**: Before making structural or architectural changes (adding/changing apps, packages, tooling, or cross-cutting patterns), read the relevant ADRs first (root and the app or package you’re changing).
- **Keeping ADRs up to date**: When you make a new architectural decision, add a new ADR in the right place (root `adr/` or the app’s/package’s `adr/`), using the template in `adr/template.md`, or create an ADR that explicitly supersedes an older one.
- **Agent workflow**: Treat ADRs as the source of truth for high-level decisions. If the code and ADRs disagree, prefer updating the ADRs (and then the code) so future agents can follow a consistent story.

## Local development

- **Root `pnpm dev`**: Runs **Docker Compose only** (`docker compose up`) — it does not run Turbo or other app dev servers. This brings up the default local stack (Postgres, Neo4j, and the backend in Bun dev mode). See [apps/backend/AGENTS.md](apps/backend/AGENTS.md) and [apps/backend/adr/0003-local-development-docker-compose.md](apps/backend/adr/0003-local-development-docker-compose.md) for backend dev options (Bun vs Wrangler) and env wiring.
- **Docker Compose**: The single `docker-compose.yml` at repo root defines Postgres, Neo4j, and two backend services (Bun dev default, Wrangler dev via `cloudflare` profile). Both backends listen on port **3000** so frontends and clients do not need to change when switching runtimes.

## Code style

- **Avoid pulling to globals**: Do not extract config or one-off values to module/global scope unless they are reused in more than one place. Inline them where they are used.

