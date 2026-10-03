# Git-canonical knowledge and deterministic hydrate

Type: grilling
Status: resolved
Blocked by: 01

## Question

What does **fully hydrate from git without invoking any LLM** mean, store by store — including deletion, idempotency, and failure?

Today: git is source + connector mirrors; Postgres objects/claims/evidence (with embeddings) are canonical semantic knowledge; FalkorDB is derived from Postgres; Zoekt/SCIP are derived from a checkout; conversations live in LangGraph checkpoints.

New rule: portable semantic knowledge is git-backed. Database content for that knowledge updates **only** from the project repository.

Settle:

- Which artefacts **must** live in git? (claims, objects, evidence, connector mirrors, project settings — **not** blindly "everything in the organisation")
- Which artefacts are **derived** and rebuilt on hydrate? Embeddings, FalkorDB, Zoekt, SCIP — each yes/no.
- Is an **embedding model** call during hydrate allowed, or does "no LLM" ban every model call?
- Byte-identical Postgres rows (stable ids in front matter) vs "same graph of facts"?
- After hydrate, is Postgres a serving cache, or do runtime reads hit git files?
- Deleted files in git: corresponding DB rows/graph edges must go. How, and is hydrate atomic (replace a revision) or patchy?
- Malformed files: refuse the import, skip the file, or fail the Workspace?
- Stable-id collisions across files or across Workspaces.
- Idempotency: hydrate of the same git SHA twice is a no-op.
- Which Postgres tables stay **operational** (auth, connections secrets, OpenWorkflow, conversations) and are **not** git-canonical?

Recommend: git holds reviewable facts with stable ids; hydrate rebuilds the serving stores without extractors; embeddings/Zoekt/SCIP stay derived. Confirm or replace, table by table.

## Answer

Human lock, 2026-08-14 (rounds 1–6; Sol refused twice until Q25/Q26). **Git-canonical knowledge is the files in the workspace tree**, not an export of today’s `objects` / `claims` / `claim_evidence` tables. Serving stores are a **Workspace-scoped** projection of one git SHA. **Hydrate never runs an extract/chat LLM** and never writes git.

**Files, path identity, two-layer graph.**

- A markdown file (or an existing connector-mirror file) is a knowledge unit. Foreign agents create files without a ctxpipe-minted `obj_`. Serving ids are a **pure function of Workspace + path**. Move/rename is a new id.
- **Layer 1 (permanent):** a relative markdown link is a `LINKS_TO` edge. Unresolved links are skipped.
- **Layer 2 (permanent):** optional `claims:` front matter (predicate, confidence, `valid_from` / `valid_to`). Hydrate **never infers** claims from prose.
- **Write-path jobs** (one kind per concern) upgrade layer 1 → layer 2, repair refs, persist `valid_from`, semantically merge conflicts, and **commit**. Trigger and edit policy: [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md). Layout/examples: [Knowledge Markdown and front-matter layout](03-knowledge-file-layout.md).
- Object / claim / evidence remain **serving-store words**.

**`AGENTS.md` and `repositories/`.**

- Root **`AGENTS.md`**: folder map (folders, not every unit) + display name in front matter `name`. Hydrate copies the name onto the `ws_` row. Ops (folder add) update **only** `name` and a **marked folder-map section**. Execution is a write-path **job** ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)); this supersedes the earlier unsandboxed-ops line. Hydrate does not rewrite this file. Malformed or missing: do **not** update the Workspace name (keep last known / repo-name default).
- **`repositories/*.md`:** one file per linked remote. Front matter `git` required, `branch` optional (default branch if missing). Body optional. Merging the file **authorizes clone**; GitHub integration/authz may reject; UI shows a human-friendly clone error. No secrets in git. Malformed file: **unlink** that linked repository for this SHA. Duplicate git URLs: extras malformed (skip; first path in tree order). Workspace remote is this repo (implicit), described in `AGENTS.md`.
- Indexing SHAs, clone credentials, `ws_` ↔ workspace-repository pointer stay **operational**. Unlinked = not a workspace repository and not named in any Workspace’s `repositories/` tree.

**Derived vs operational.**

- Postgres knowledge rows: part of the **projection** of the tree. Runtime reads hit Postgres, not git on the hot path. **Workspace-local:** no merge across Workspaces. Replace this Workspace’s knowledge at one SHA; previous SHA stays live until Postgres projection succeeds.
- Embeddings: derived. Hydrate may call the embedding API. Failure does not roll back Postgres; embeddings stay stale and **retryable**. Same-SHA no-op applies only to phases that already succeeded.
- FalkorDB: derived from hydrated Postgres via `project()`. Not a second markdown parser.
- Zoekt / SCIP: derived from workspace-repository + linked checkouts. **Independent per Workspace** (no shared clone across Workspaces for the same URL).
- **Operational:** auth/sessions, connection secrets/tokens, OpenWorkflow, conversations, onboarding, indexing/checkout status. Integrations/auth are org-shared **many-to-many** with multiple source→destination mappings.

**Malformed, delete, rename.**

- Skip **any** malformed file; still activate. Fail the whole hydrate only if the tree cannot be read.
- Deleted files drop that Workspace’s serving rows and edges.
- Rename-ref repair is a **write-path commit** (may be its own commit); repair as much as possible. Hydrate does not invent link targets.

**Confidence and temporality.**

- File `confidence` is that signal’s **maximum**. Hydrate **copies** per-signal max + windows onto serving rows (one signal per asserting path). Skill/ingest calibrate writes (~0.5 typical, ~0.7 strong, ≥0.85 rare) and set `valid_to` from source semantics when possible.
- Missing `valid_to`: evergreen. Missing `valid_from`: a **`valid_from` persist job** fills from the introducing git commit; bumps only when it **re-asserts**. Until that commit exists, **hydrate derives the same introducing-commit timestamp read-only** (Q25) and recall uses that effective `valid_from`. Never `valid_from = now`.
- **Recall** (not hydrate) decays each signal, then **damped-combines**. Same SHA stays idempotent (decay is query-time).
- Interval is half-open **`[valid_from, valid_to)`** (Q26): `e = 0` before `valid_from` and at/after `valid_to`. Decay only inside the window. Evergreen: `e = 0` before `valid_from`, then source half-life.
- Inside a window: `e = c_max × 0.5 ^ ((now − valid_from) / (span / 2))` with `span = valid_to − valid_from`.
- Evergreen after `valid_from`: `e = c_max × 0.5 ^ ((now − valid_from) / H[source])`. `H` in code, not env: git/manual 365d, Notion/Confluence 180d, Linear 120d, Slack 21d, else 180d.
- Combine with `α = 0.25` (in code): `combined = max(e) + (1 − max(e)) × (1 − Π (1 − α e_other))`. Result ≥ max; two 0.8s → ~0.84. Replaces today’s weighted-mean `aggregateConfidence` for this graph. Single signal: `combined = e`. Signals with `e = 0` are omitted. Two equal maxima: pick one as `max`, the rest corroborate.

**Not this ticket:** write-job schedule and kinds (10); exact YAML key names and example files (03); first-workspace export commits (12). Desired SHA vs indexed SHA: [Workspace revision and derived-store freshness](11-project-revision-and-freshness.md).

## Comments

- 2026-08-13 — Round 1 locked derived/operational stores and embedding-during-hydrate; Q1 restated as file-native.
- 2026-08-13 — Round 2: file-native yes; `AGENTS.md` + TanStack ops agent (no sandbox); rename is new id plus write-path ref rewrite; SHA replace / skip malformed / no-op confirmed; linked repos are `repositories/*.md`.
- 2026-08-13 — Closed too early; Sol refused. Reopened.
- 2026-08-13 — Round 3: Q11, Q13–Q17.
- 2026-08-13 — Round 4: two-layer graph; maintenance job; per-signal max; merge must rise with more signals.
- 2026-08-14 — Round 5: Q22 fill-if-missing; Q24 damped combine `α=0.25`, window-stretched decay, source half-lives, skill `valid_to` + confidence calibration.
- 2026-08-14 — Sol refused close again: missing `valid_from` vs evergreen decay (Q25); interval boundaries / future `valid_from` can make `e > c_max` (Q26).
- 2026-08-14 — Q25/Q26 accepted as Sol recommended. Ticket resolved. Leftover job trigger, YAML keys, and examples are 03/10.
