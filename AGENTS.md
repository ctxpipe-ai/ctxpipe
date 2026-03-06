## Where agent instructions live

Agent instructions are **distributed**: this file covers repo-wide rules; apps and packages can have their own `AGENTS.md` with local instructions. When working in an app or package, read both the root AGENTS.md and that folder's AGENTS.md (if present).

- **Root** (this file): architecture, ADRs, code style.
- **apps/backend**: [apps/backend/AGENTS.md](apps/backend/AGENTS.md) — API, OpenAPI, MCP, Drizzle, TypeScript, etc.
- **apps/codesearch**: [apps/codesearch/AGENTS.md](apps/codesearch/AGENTS.md) — Zoekt orchestration, read-only DB, OpenAPI + Zod.
- **apps/ui**: [apps/ui/AGENTS.md](apps/ui/AGENTS.md) — TanStack Start frontend, React Aria, Tailwind, Storybook, Vitest.

**When feedback is given that should become a long-term instruction**: Save it into this structure. Repo-wide preferences and conventions go in this file (root AGENTS.md). Instructions that apply only to a specific app or package go in that folder's `AGENTS.md` (e.g. `apps/backend/AGENTS.md`); create the file if it doesn't exist. Add or update the list above when you create or change an app/package AGENTS.md so future agents know where to look.

## Architecture decisions & ADRs

- **Where ADRs live**: Cross-cutting decisions are in the root `adr/` directory. **App- and package-specific ADRs** live in their own `adr/` subfolder (e.g. `apps/backend/adr/`, `packages/foo/adr/`). Start with `adr/README.md` for naming, structure, and when to add an ADR.
- **When you change architecture**: Before making structural or architectural changes (adding/changing apps, packages, tooling, or cross-cutting patterns), read the relevant ADRs first (root and the app or package you’re changing).
- **Keeping ADRs up to date**: When you make a new architectural decision, add a new ADR in the right place (root `adr/` or the app’s/package’s `adr/`), using the template in `adr/template.md`, or create an ADR that explicitly supersedes an older one.
- **Agent workflow**: Treat ADRs as the source of truth for high-level decisions. If the code and ADRs disagree, prefer updating the ADRs (and then the code) so future agents can follow a consistent story.

## Local development

- **Root `pnpm dev`**: Runs **Docker Compose only** (`docker compose up`) — it does not run Turbo or other app dev servers. This brings up the default local stack (Postgres, Neo4j, and the backend in Bun dev mode). See [apps/backend/AGENTS.md](apps/backend/AGENTS.md) and [apps/backend/adr/0003-local-development-docker-compose.md](apps/backend/adr/0003-local-development-docker-compose.md) for backend dev and env wiring.
- **Docker Compose**: The single `docker-compose.yml` at repo root defines Postgres, Neo4j, the backend (Bun, port **3000**), the ui app (Vite dev server, port **3002**), and optionally the codesearch service (Bun, port **3001**) and Zoekt webserver (internal).
- **Node modules cleanup (one-time)**: If containerized installs fail with workspace package read errors, remove host workspace install directories (`apps/*/node_modules`) once and restart `docker compose up` so per-service Docker volumes own dependency state.

## Code style

- **Avoid pulling to globals**: Do not extract config or one-off values to module/global scope unless they are reused in more than one place. Inline them where they are used.


<!-- ConKeeper Memory System -->
## Memory System

This project uses ConKeeper for persistent AI context management.

**Memory Location:** `.claude/memory/` (or `.ai/memory/`)

**Available Workflows:**
- **memory-init** - Initialize memory for this project
- **memory-sync** - Sync session state to memory files
- **session-handoff** - Generate handoff for new session
- **memory-search** - Search memory files by keyword or category
- **memory-reflect** - Session retrospection and improvement analysis
- **memory-insights** - Session friction trends and success pattern analysis

**Memory Files:**
- `active-context.md` - Current focus and state
- `product-context.md` - Project overview
- `progress.md` - Task tracking
- `decisions/` - Architecture Decision Records
- `sessions/` - Session summaries

**Usage:**
- Load memory at session start for non-trivial tasks
- Sync memory after significant progress
- Use handoff when context window fills

For full documentation: https://github.com/swannysec/context-keeper
<!-- /ConKeeper -->
