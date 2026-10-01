# Git-backed Workspaces

Status: accepted (2026-10-02). Consolidates the wayfinder decisions in [`.ai/scratchpad/git-backed-projects/`](../../scratchpad/git-backed-projects/map.md) (history) with the 2026-10-01 release decisions. Items marked *(ticket NN)* are decided but still being implemented on PR 280; see [`.ai/scratchpad/pr-280-release/`](../../scratchpad/pr-280-release/board.md).

## Product

ctxpipe is a job engine over **Workspaces**. An organization's portable knowledge lives in git; ctxpipe keeps it current (jobs) and makes it searchable (projection). Turn ctxpipe off and the knowledge stays in the repository.

- A **Workspace** (`ws_`) has exactly one **workspace repository** (knowledge + connector mirrors) and zero or more **linked repositories** (code to search). Many per organization. Creating a Workspace *is* linking its workspace repository; there is no draft.
- Any git URL can be a workspace repository; GitHub has the first-class select / create (`github.com/new`) flow. A URL is the workspace repository of at most one Workspace per organization; other Workspaces may link it for search.
- Display name comes from `AGENTS.md` front matter (`name`), defaulting to the repository name. The URL slug is DB-only, unique per organization.

## Knowledge in git

- Files are canonical. A Markdown file is a knowledge unit; its path is its identity (rename = new identity). Layout: `knowledge/<area>/<unit>.md` on an empty tree, otherwise follow the existing tree. Linked repositories are declared as `repositories/<name>.md` (`git` required, `branch` optional). Connector mirrors live under `linear/`, `notion/`, `slack/`, `confluence/`, `pagerduty/`, `github/`.
- Two graph layers: relative Markdown links (`LINKS_TO`) and optional `claims:` front matter (`to`, `predicate`, `confidence`, `valid_from`, `valid_to`, `source`). Optional `kind` front matter carries the graph ontology (ADR-033).
- Confidence is a per-signal maximum in the file; recall decays each signal inside `[valid_from, valid_to)` and damped-combines (`α = 0.25`). Missing `valid_from` is the introducing commit's time.

## Projection (hydrate)

- **Hydrate** reads one immutable revision (`WorkspaceRevision`: workspace, generation, remote, default branch, SHA) and rebuilds the **projection**: Postgres knowledge units, FalkorDB/Neptune graph, embeddings, codesearch (Zoekt + SCIP). It never writes git and never calls an extraction model.
- Activation is one compare-and-set on generation + URL + SHA; the previous projection keeps serving until the new one is active. Malformed files are skipped. Derived stores (graph, embeddings, search) report their own freshness and retry independently.
- Search and chat read only the active projection and the Workspace's linked set. Indexes are per Workspace.

## Jobs (writes to the workspace repository)

- Every write to the default branch is a typed OpenWorkflow job (bootstrap, migration export, extraction, connector mirror, claims upgrade, rename rewrite, `valid_from` persist, semantic merge, folder map, link/unlink, file edit). One job → at most one commit, with a model-written subject (template fallback).
- Jobs run deterministic transforms on captured git data. Only the broker push step holds a write credential; it pushes fast-forward only and never force-pushes the default branch. A non-fast-forward is rebased and, on overlap, merged by an isolated semantic-merge step.
- Writes are GitHub-only in v1. If ctxpipe cannot push, the Workspace is **read-only**: hydrate, search and chat continue; jobs for that repository pause and resume when access returns.
- Connectors fetch provider content, then hand it to a typed mirror job that commits it. Provider config (`<connector>/config.yaml`) changes go through PRs.

## Workspace chat

- Stock TanStack AI: `useChat` ↔ WebSocket ↔ `chat()` with `withPersistence` + `withSandbox` + `opencodeText`. Transcripts are Postgres (TanStack persistence), not git. Models: only the configured fast/medium/high tiers through the app's model proxy (default fast).
- One sandbox per conversation. **The conversation's durable state is its git session branch**: every turn that changes files is committed and pushed to `ctxpipe/chat/<conversation>/<n>` by the backend broker *(ticket 02)*. Sandboxes are disposable; a lost sandbox is recreated from the branch. While a sandbox lives, a moved default branch is merged in place before the next turn *(ticket 01, option D)*.
- Publishing is **Create PR** (squashes the turn commits) and **Show PR**; there is no separate Commit+Push *(ticket 02)*. Chat never pushes the default branch.
- Sandboxes get read credentials and per-run model/git capabilities only; no GitHub write credential, App key, or provider key enters a sandbox. Tool calls follow `acceptEdits` plus a fast-model judge after hard denies.
- Retrieval tools (knowledge, graph, codesearch) run on the backend against the active projection.
- `ctx_advisor` (MCP) is a deprecated shim: one Workspace chat turn on the organization's first Workspace per call, hidden from the UI list.

## Sandboxes

- **Hosted:** Cloudflare Sandboxes behind a gateway Worker; instance type `basic` to start *(ticket 02)*.
- **Self-host:** stock TanStack `dockerSandbox` — Compose uses a DinD sidecar; AWS CDK creates a small Graviton EC2 Docker host (always on, no opt-out) *(ticket 03)*. Containers and snapshot images are cleaned up so the host never fills its disk.
- **Isolation** is what stock TanStack sandbox policy supports (`commands`, `capabilities.fileWrite/network`, `default`). No custom quotas, egress proxy, or patched providers *(ticket 01)*.
- **Unsandboxed** runs only when explicitly locked (`SANDBOX_PROVIDER=unsandboxed`); it is never a default or a recommendation.

## UI

- Navigation: Home, Search (palette), Connectors, then Workspace rows (last 5 conversations each). No org-wide Chat, Repositories, or Knowledge graph pages.
- `/$orgSlug/ws/$workspaceSlug` composes; the first message creates the conversation at `/$orgSlug/ws/$workspaceSlug/$conversationId`. Right pane tabs: Files (Pierre tree/diff/editor), Graph (this Workspace's projection), Settings (name, slug, repository, linked repositories with index health).
- Add Workspace lives in org settings and in the zero-Workspace gate *(ticket 11: org settings entry is missing)*.

## Out of scope for this release

- Fine-grained MCP tools replacing `ctx_advisor`.
- First-class non-GitHub write support (other hosts are read-only Workspaces).
- Operator control of sandbox egress allowlists.
