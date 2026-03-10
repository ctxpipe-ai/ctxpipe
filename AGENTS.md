## Where agent instructions live

Agent instructions are **distributed**: this file covers repo-wide rules; apps and packages can have their own `AGENTS.md` with local instructions. When working in an app or package, read both the root AGENTS.md and that folder's AGENTS.md (if present).

- **Root** (this file): architecture, ADRs, code style.
- **apps/backend**: [apps/backend/AGENTS.md](apps/backend/AGENTS.md) — API, OpenAPI, MCP, Drizzle, TypeScript, etc.
- **apps/codesearch**: [apps/codesearch/AGENTS.md](apps/codesearch/AGENTS.md) — Zoekt orchestration, read-only DB, OpenAPI + Zod.
- **apps/ui**: [apps/ui/AGENTS.md](apps/ui/AGENTS.md) — TanStack Start frontend, React Aria, Tailwind, Storybook, Vitest.
- **apps/docs**: [apps/docs/AGENTS.md](apps/docs/AGENTS.md) — Fumadocs documentation site (Next.js 15, Shiki, forced-dark, deploys to docs.ctxpipe.ai).

**When feedback is given that should become a long-term instruction**: Save it into this structure. Repo-wide preferences and conventions go in this file (root AGENTS.md). Instructions that apply only to a specific app or package go in that folder's `AGENTS.md` (e.g. `apps/backend/AGENTS.md`); create the file if it doesn't exist. Add or update the list above when you create or change an app/package AGENTS.md so future agents know where to look.

## Architecture decisions & ADRs

- **Where ADRs live**: All ADRs are in **ConKeeper memory**: `.ai/memory/decisions/`. Files are named `ADR-NNN-title-slug.md` (e.g. `ADR-001-frontend-ui-app-stack.md`). This is the single source of truth; there are no `adr/` directories in the repo.
- **When you change architecture**: Before making structural or architectural changes (adding/changing apps, packages, tooling, or cross-cutting patterns), read the relevant ADRs in `.ai/memory/decisions/` first.
- **Keeping ADRs up to date**: When you make a new architectural decision, add a new ADR in `.ai/memory/decisions/` with the next number (e.g. `ADR-010-new-decision.md`). Use the format: Status, Date, Tags; Context; Decision; Rationale/Consequences; Alternatives Considered; Notes. Create an ADR that explicitly supersedes an older one when reversing a decision.
- **Agent workflow**: Treat ADRs as the source of truth for high-level decisions. If the code and ADRs disagree, prefer updating the ADRs (and then the code) so future agents can follow a consistent story.

## Local development

- **Root `pnpm dev`**: Runs **Docker Compose only** (`docker compose up`) — it does not run Turbo or other app dev servers. This brings up the default local stack (Postgres, FalkorDB, and the backend in Bun dev mode). See [apps/backend/AGENTS.md](apps/backend/AGENTS.md) and [.ai/memory/decisions/ADR-004-local-development-docker-compose.md](.ai/memory/decisions/ADR-004-local-development-docker-compose.md) for backend dev and env wiring.
- **Docker Compose**: The single `docker-compose.yml` at repo root defines Postgres, FalkorDB, the backend (Bun, port **3000**), the ui app (Vite dev server, port **3002**), and optionally the codesearch service (Bun, port **3001**) and Zoekt webserver (internal).
- **Node modules cleanup (one-time)**: If containerized installs fail with workspace package read errors, remove host workspace install directories (`apps/*/node_modules`) once and restart `docker compose up` so per-service Docker volumes own dependency state.

## Code style

- **Avoid pulling to globals**: Do not extract config or one-off values to module/global scope unless they are reused in more than one place. Inline them where they are used.

<!-- ConKeeper Memory System -->

## Memory System

This project uses ConKeeper for persistent AI context management.

**Memory Location:** All memory related to this project is in `.ai/memory/`. 

**Available Workflows:** ConKeeper comes with the following skills that you should make use of to build up our memory bank of the project.

- **memory-init** - Initialize memory for this project
- **memory-sync** - Sync session state to memory files
- **session-handoff** - Generate handoff for new session
- **memory-search** - Search memory files by keyword or category
- **memory-reflect** - Session retrospection and improvement analysis
- **memory-insights** - Session friction trends and success pattern analysis

**Memory Files:**

- `active-context.md` - Context of the work in progress
- `product-context.md` - Project overview
- `progress.md` - Progress of current tasks being worked on. Update when you need to compact the conversations
- `decisions/` - Architecture Decision Records
- `sessions/` - Session summaries

**Usage:**

- Load memory at session start for non-trivial tasks
- Sync memory after significant progress
- Use handoff when context window fills

For full documentation: https://github.com/swannysec/context-keeper

<!-- /ConKeeper -->
