# Git-backed portable context

Label: `wayfinder:map`

## Destination

A locked spec for ctxpipe as a **portable context manager**: an organisation's **portable semantic knowledge** lives in **Projects**, each linked to one GitHub repository, so derived stores can **hydrate from that git tree without invoking an LLM**. Project chat runs OpenCode inside an **isolated container** on a git worktree. The UI is a project-centric coding-agent workspace. This map is done when the tickets below are resolved — not while build-critical questions remain in fog.

## Notes

- **Domain:** context management; git as the portable source of truth; Project as the unit of context.
- **Skills every session:** `/grilling` and `/domain-modeling` on HITL tickets; `/research` on research tickets; `/prototype` on UI tickets; `/codebase-design` when a seam is in play.
- **Adversarial review:** before closing any ticket, run an adversarial review of the draft answer with **Sol** (`gpt-5.6-sol-xhigh`). Charting itself was Sol-reviewed; the DAG was redrawn from that review. Complexity must lose unless it earns its keep — we are a small project.
- **Plan, don't do:** this effort produces decisions, not the implementation.
- **Refer by name:** always wrap ticket links in the ticket title.
- **Simplicity:** smallest model that satisfies hydrate-from-git, one-commit ingest, and project-scoped chat. Do not add operator env vars unless a ticket proves they are required.
- **Docker sandbox** means an isolated container workload. It does **not** mean Docker-in-Docker unless a ticket proves DinD is the only honest option on a target.
- **Writes vs editor UI:** a file-edit / diff *panel* is later. What happens to OpenCode's writes (commit, push, discard, retain worktree) is **in this map**.
- **`main` vs default branch** is not silently substituted — it is decided on [Ingest-to-git write and concurrency protocol](issues/10-ingest-to-git-write-protocol.md).
- **Existing ADRs to reopen explicitly if contradicted:** [ADR-008](../../memory/decisions/ADR-008-codesearch-zoekt-orchestration.md) (separate codesearch), [ADR-018](../../memory/decisions/ADR-018-unified-connections-table.md), [ADR-022](../../memory/decisions/ADR-022-linear-connector-git-native-mirror.md) / [ADR-023](../../memory/decisions/ADR-023-notion-connector-git-native-mirror.md) (git-native connector mirrors already exist; this effort extends git-backing to *extracted* knowledge).
- **Language collisions to kill on sight:** product **Project** vs ingestion verb `project()` (FalkorDB projection) vs Linear **Project** vs prompt field `currentProjectName`. Resolved terms go in `.ai/memory/glossary.md`.
- **Current facts (not decisions):** no `projects` table. Objects/claims/evidence/embeddings are Postgres-canonical; FalkorDB is derived; git holds source plus connector mirrors, not extracted claims. Chat is LangGraph + Vercel AI SDK. Codesearch clones are ordinary checkouts under `/data/repo-cache`. Railway and ECS Fargate do not expose a Docker socket today. Only codesearch mounts persistent disk.

## Decisions so far

- [TanStack AI for product chat](issues/04-tanstack-ai-for-product-chat.md) — FE/BE transport exists (`0.x`); not a drop-in for LangGraph checkpoints; first-party path is `withSandbox` + `opencodeText` (no run journal; no Railway/Fargate provider).
- [OpenCode as the project chat runtime](issues/05-opencode-as-project-chat-runtime.md) — headless CLI/HTTP/SDK exist; `--dir` is cwd not a sandbox; wrap for isolation; transcripts in OpenCode SQLite.
- [Deployment storage and Docker-sandbox constraints](issues/06-deploy-storage-and-sandbox.md) — no target ships a sandbox today; Railway cannot share a volume across services; Fargate isolation is `RunTask`; Compose is the only one-host target.
- [Coding-agent desktop UI reference](issues/07-coding-agent-desktop-ui-reference.md) — project-grouped sessions + centre chat + pane-local right tabs; last-N and tree-collapse are not vendor rules.

## Not yet specified

- Whether MCP `ctx_advisor` becomes the same project-scoped OpenCode chat or stays a retrieval advisor.
- Production file-editor and diff-panel interaction (the *UI* for editing files — not whether agent writes must have a disposition).

## Out of scope

- Implementing the destination in this wayfinder effort — the map stops at a locked spec.
- Building the production file-edit and diff-of-current-changes panels.
- Manual per-tenant migrations — upgrade work is an OpenWorkflow job queued at version start, as with the SCIP migration.
- Keeping top-level Chat and Knowledge graph as primary nav destinations — they move onto the project page.
- The current UI/MCP conversation-source selector — it goes away.
