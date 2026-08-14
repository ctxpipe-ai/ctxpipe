# Git-backed portable context

Label: `wayfinder:map`

## Destination

A locked spec for ctxpipe as a **portable context manager**: an organisation's **portable semantic knowledge** lives in **Projects** (`proj_` id; each a context workspace with one **backing** git repository for knowledge + connectors, and zero or more **attached** repos for codesearch), so derived stores can **hydrate from that backing git tree without invoking an LLM**. Knowledge is **files** (path identity, links as relations); `AGENTS.md` maps folders; attached remotes are `repositories/*.md`. GitHub is the first-class backing UX (select/create); any git URL is valid. Project chat is TanStack AI `chat()` + `withSandbox` + `opencodeText` with an env-selected TanStack sandbox provider (Compose DinD, custom Railway, Fargate v1 unsandboxed) — not a homemade OpenCode process. Folder-map **ops** use TanStack `chat()` **without** sandbox. The UI is a project-centric coding-agent workspace. This map is done when the tickets below are resolved — not while build-critical questions remain in fog.

## Notes

- **Domain:** context management; git as the portable source of truth; Project as the unit of context.
- **Skills every session:** `/grilling` and `/domain-modeling` on HITL tickets; `/research` on research tickets; `/prototype` on UI tickets; `/codebase-design` when a seam is in play.
- **Adversarial review:** before closing any ticket, run an adversarial review of the draft answer with **Sol** (`gpt-5.6-sol-xhigh`). Charting itself was Sol-reviewed; the DAG was redrawn from that review. Complexity must lose unless it earns its keep — we are a small project.
- **Plan, don't do:** this effort produces decisions, not the implementation.
- **Refer by name:** always wrap ticket links in the ticket title.
- **Simplicity:** smallest model that satisfies hydrate-from-git, one-commit ingest, and project-scoped chat. Do not add operator env vars unless a ticket proves they are required.
- **Chat runtime (locked):** Client project chat is TanStack AI `chat()` + `withSandbox(defineSandbox(…))` + `opencodeText`. Isolation is a TanStack sandbox provider. Do **not** spawn `opencode serve`, `docker run` OpenCode, or host git worktrees as the chat isolation mechanism. See [Chat uses TanStack sandbox, not DIY OpenCode](issues/17-tanstack-sandbox-not-diy-opencode.md) and [Backend, codesearch, and sandbox-runner topology](issues/08-backend-codesearch-sandbox-topology.md). **Ops agents** use TanStack `chat()` **without** sandbox or harness.
- **Sandbox topology (locked):** backend ≠ codesearch (ADR-008). `SANDBOX_PROVIDER` locks a provider (fail closed); unset auto-detects `sbx` → Docker/DinD → unsandboxed `localProcessSandbox`. Compose template: DinD sidecar + `docker`. Railway: custom SandboxProvider + lock `railway`. CDK Fargate v1: unsandboxed. Workspace = shallow clone of the **backing** repo; project-level snapshot/fork is application-owned; `gh` is read-only on that Project’s GitHub remotes for one installation.
- **Writes vs editor UI:** a file-edit / diff *panel* is later. Agent writes live in the **TanStack sandbox working tree** (container clone), not a host git worktree. Disposition of those writes is still [Worktree and agent-change lifecycle](issues/14-worktree-and-agent-change-lifecycle.md) (rename pending that ticket).
- **`main` vs default branch** is not silently substituted — it is decided on [Ingest-to-git write and concurrency protocol](issues/10-ingest-to-git-write-protocol.md).
- **Existing ADRs to reopen explicitly if contradicted:** [ADR-008](../../memory/decisions/ADR-008-codesearch-zoekt-orchestration.md) (separate codesearch), [ADR-018](../../memory/decisions/ADR-018-unified-connections-table.md), [ADR-022](../../memory/decisions/ADR-022-linear-connector-git-native-mirror.md) / [ADR-023](../../memory/decisions/ADR-023-notion-connector-git-native-mirror.md) (git-native connector mirrors already exist; this effort extends git-backing to *extracted* knowledge).
- **Language collisions to kill on sight:** product **Project** vs ingestion verb `project()` (FalkorDB projection) vs Linear **Project** vs prompt field `currentProjectName`. Resolved terms go in `.ai/memory/glossary.md`.
- **Current facts (not decisions):** no `projects` table. Objects/claims/evidence/embeddings are Postgres-canonical; FalkorDB is derived; git holds source plus connector mirrors, not extracted claims. Chat is LangGraph + Vercel AI SDK. Codesearch clones are ordinary checkouts under `/data/repo-cache`. Railway and ECS Fargate do not expose a Docker socket today. Only codesearch mounts persistent disk.

## Decisions so far

- [TanStack AI for product chat](issues/04-tanstack-ai-for-product-chat.md) — FE/BE transport exists (`0.x`); not a drop-in for LangGraph checkpoints; first-party path is `withSandbox` + `opencodeText` (no run journal; no Railway/Fargate provider).
- [OpenCode as the project chat runtime](issues/05-opencode-as-project-chat-runtime.md) — headless CLI/HTTP/SDK exist; `--dir` is cwd not a sandbox; wrap for isolation; transcripts in OpenCode SQLite.
- [Chat uses TanStack sandbox, not DIY OpenCode](issues/17-tanstack-sandbox-not-diy-opencode.md) — product chat is `withSandbox` + `dockerSandbox` (or another TanStack provider) + `opencodeText`; no homemade OpenCode lifecycle.
- [Deployment storage and Docker-sandbox constraints](issues/06-deploy-storage-and-sandbox.md) — no target ships a sandbox today; Railway cannot share a volume across services; Fargate isolation is `RunTask`; Compose is the only one-host target.
- [Coding-agent desktop UI reference](issues/07-coding-agent-desktop-ui-reference.md) — project-grouped sessions + centre chat + pane-local right tabs; last-N and tree-collapse are not vendor rules.
- [What is a Project](issues/01-what-is-a-project.md) — a context workspace with one backing git repo (knowledge + connectors) and zero or more attached repos (codesearch); not one-repo-equals-one-Project.
- [Project identity and invariants](issues/18-project-identity-and-invariants.md) — `proj_` row; many per org; display name defaults to repo name and is editable; no draft (create = link backing); any git URL, GitHub UX first; backing unique and implicitly searchable; other Projects may attach that URL for search; unlinked repos exist; migration attaches non-target ingested repos to the first connector-target Project (or they stay unlinked until the create-project prompt auto-attaches them).
- [Git-canonical knowledge and deterministic hydrate](issues/02-hydration-contract.md) — files are canonical (path identity; layer-1 links + layer-2 `claims:`); hydrate is read-only, no extract LLM; maintenance job writes repairs; skip-all-malformed; clone-from-declaration; Project-scoped knowledge **and** indexes; file confidence is a per-signal max; recall uses `[valid_from, valid_to)` decay then damped combine (`α=0.25`).
- [Knowledge Markdown and front-matter layout](issues/03-knowledge-file-layout.md) — `knowledge/<area>/<unit>.md` greenfield default, any depth if the tree already has it; `repositories/*.md` with checkoutable `git` URL; `claims[].to` file-relative; almost all keys optional; one semantic folder-structure section in `AGENTS.md`; skill at `.agents/skills/ctxpipe-knowledge`.
- [Backend, codesearch, and sandbox-runner topology](issues/08-backend-codesearch-sandbox-topology.md) — keep codesearch separate; `SANDBOX_PROVIDER` + native creds; Compose DinD; custom Railway provider; Fargate v1 unsandboxed; backing-repo clone; app-owned project snapshot then per-thread fork; Postgres instance store.

## Not yet specified

- Whether MCP `ctx_advisor` becomes the same project-scoped OpenCode chat or stays a retrieval advisor.
- Production file-editor and diff-panel interaction (the *UI* for editing files — not whether agent writes must have a disposition).

## Out of scope

- Implementing the destination in this wayfinder effort — the map stops at a locked spec.
- Building the production file-edit and diff-of-current-changes panels.
- Manual per-tenant migrations — upgrade work is an OpenWorkflow job queued at version start, as with the SCIP migration.
- Keeping top-level Chat and Knowledge graph as primary nav destinations — they move onto the project page.
- The current UI/MCP conversation-source selector — it goes away.
- Homemade OpenCode process/container lifecycle for product chat — TanStack `withSandbox` is the integration.
- First-class GitLab (or other non-GitHub) picker/create UX — any git URL still works; GitHub keeps the select-existing / create-new flow for now.
