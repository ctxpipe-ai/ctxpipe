---
name: preview-env-hydrate
description: Workspace hydrate to an active projection, skipped files, re-hydrate on a new commit, and retry (preview-env).
disable-model-invocation: true
---

# preview-env hydrate

Workspace **revision** prepare: `workspace-hydrate` rebuilds the projection (Postgres knowledge units, graph, embeddings) and `workspace-index` the code index. Not `POST /repositories`. [Harness](../harness.md) is `PASS`; worker and codesearch were woken. Flow format: [run-setup](../run-setup.md#flow-format). Use browser plus curl with a cookie jar exported from account A's session (`COOKIE_JAR`).

### HYD-1 New Workspace reaches an active projection
**Requires** ONB-5 (Workspace 1 from the knowledge template).
**Steps**
1. Poll `curl -fsS -b "$COOKIE_JAR" "$BASE_URL/$orgSlug/api/v1/workspaces/$workspace1Slug"` every 5 s; record `hydrateStatus`, `hydrateError`, `desiredSha`, `activeProjectionSha`.
2. When `ready`, `GET …/files/tree` (expect 200, not 409) and open **Files**.
3. Compare the Settings hydrate chip with the JSON.

**Expect (UI)** chip **Hydrate ready** matching the JSON; **Files** shows the tree with `AGENTS.md`, the 4 knowledge files, the malformed file, and `.agents/skills/ctxpipe-knowledge/SKILL.md` from the bootstrap commit.
**Expect (backend)** `workspace_commit_projections` row for the head SHA; exactly 4 `workspace_knowledge_units` rows (one per valid knowledge file; `AGENTS.md`, `.agents/`, and the malformed file have none); `activeProjectionSha` equals `desiredSha`; `workspace-hydrate` then `workspace-index` runs succeeded; the bootstrap commit from [ONB-5](../onboarding/SKILL.md) is part of the projected revision.
**Budget** 60 s / 3 min, Workspace created to `hydrateStatus === "ready"`. If the worker deploy timestamp did not move after enqueue, wake again ([harness](../harness.md#1-wake)) and keep polling.
**Evidence** `HYD-1-1.png` (Settings chips), `HYD-1-2.png` (Files); JSON status; trace and `openworkflow.run.id` of both runs.

### HYD-2 Malformed file is skipped, not fatal
**Requires** HYD-1; `knowledge/operations/legacy-migration-notes.md` from the knowledge template (run-setup).
**Steps**
1. Open **Settings** on the Workspace page.
2. In the **Hydrate skipped 1 file** notice, select `knowledge/operations/legacy-migration-notes.md`.
3. Check the knowledge units for that path.

**Expect (UI)** hydrate is still **Hydrate ready**; below the chips, a warning notice **Hydrate skipped 1 file** names `knowledge/operations/legacy-migration-notes.md` with the reason **Front matter could not be read**; selecting the path opens that file in **Files** (it is in git). A Workspace with no skipped files shows no notice.
**Expect (backend)** `GET …/workspaces/{slug}` has `skippedFiles: [{ "path": "knowledge/operations/legacy-migration-notes.md", "reason": "malformed" }]`; no `workspace_knowledge_units` row for that path; the `workspace-hydrate` run's output (OpenWorkflow `output` JSON) has `skipped: 1` and the same entry in `diagnostics`; no `hydrateError`.
**Budget** none beyond HYD-1.
**Evidence** `HYD-2-1.png` (Settings notice), `HYD-2-2.png` (file open in **Files**); the Workspace JSON and the run output.

### HYD-3 New commit on the default branch triggers re-hydrate
**Requires** HYD-1 `ready`; `gh` or a human able to push to `pe-{run-id}-ws`.
**Steps**
1. Push a commit adding `knowledge/preview-env/{run-id}.md` (with a relative link to an existing file) to the default branch.
2. Wait for the push webhook; if none arrives within 60 s, reload the Workspace (the Workspace list request enqueues a tip check).
3. Poll the Workspace JSON until `activeProjectionSha` equals the new SHA; open **Files**.

**Expect (UI)** the chip passes **Hydrating** and returns to **Hydrate ready** (the previous projection keeps serving meanwhile, so Files and chat never go blank); the new file appears in **Files**.
**Expect (backend)** a `workspace-tip-check` run sees the new SHA; a new `workspace-hydrate` run activates it by one compare-and-set; `desiredSha` equals the pushed SHA; a new `workspace_knowledge_units` row.
**Budget** 60 s / 3 min, push to **Hydrate ready** on the new SHA (webhook path); note separately whether the reload fallback was needed.
**Evidence** `HYD-3-1.png`; the pushed SHA; trace and run ids.

### HYD-4 Failed hydrate recovers with Try again
**Requires** a Workspace whose hydrate fails (`SKIP(no-fixture)` when none fails; do not create a broken repository on purpose unless the user asks).
**Steps**
1. On **Settings**, read **Hydrate failed** and its error.
2. Click **Try again** (`POST …/retry-prepare`).

**Expect (UI)** the chip moves to **Hydrating** then **Hydrate ready** (or failed again with a named error, never a spinner forever); copy says hydrate does not wait on a bootstrap commit.
**Expect (backend)** a new `workspace-hydrate` run per retry; `hydrateError` cleared on success.
**Budget** 60 s / 3 min, **Try again** to ready.
**Evidence** `HYD-4-1.png`; trace of the retry request.

### HYD-5 Linked-repository index completes
**Requires** WS-6 linked `pe-{run-id}-code`.
**Steps**
1. On **Settings**, watch the linked row until its chip settles.

**Expect (UI)** **Indexed** (or **Indexed with issues** with a note); never stuck on **Indexing** or **Pending** beyond the budget (a stuck chip means codesearch is down or asleep).
**Expect (backend)** a `repository-index` run finished; the code index answers a query: in Workspace chat ask what `loyaltyPoints(12345)` returns in `pe-{run-id}-code`; the answer is 17 and cites `src/loyalty.ts`.
**Budget** 90 s / 5 min, link to **Indexed** (same clock as WS-6).
**Evidence** `HYD-5-1.png`; Railway codesearch logs on a fail.

## Status

- **PASS** HYD-1, HYD-3, HYD-5 `PASS`; HYD-2 `PASS`; HYD-4 `PASS` or `SKIP`.
- **FAIL** `failed` after retry, 409 tree after ready, no projection switch after a push, or the worker never ran (attach Railway logs via [observability](../../observability/SKILL.md)).
- **SKIP** no Workspace (later areas that need one `SKIP(blocked-by ONB-5)`).
