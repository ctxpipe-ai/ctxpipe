# Gate 3 checkpoint 716a0a80 — Spec coverage ledger

## Review boundary

- Verified both refs and reviewed `git diff bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...716a0a80a2679b74fb9a3dc1f18c57c93d3573a2` plus the 29-commit log. The cumulative range is 1,645 files; earlier checkpoint ledgers cover prior slices. All current-source reads used `git show 716a0a80...:path`, never the moving worktree.
- Read the repository and backend `AGENTS.md`, `.agents/skills/code-review/SKILL.md`, accepted recovery plan Gate 3 (`workspace-chat-recovery.md:642-659`), locked ingest ticket 10, ADR-033, pinned status, and write-path audit.
- Did not run tests, mutate the repository, delegate, or inspect later worktree edits.

## New source authority

- Traced producer destination selection through `capture-repository-extraction.ts:12-54`: own-repository match, first-workspace linked destination, immutable revision, transient read credential, canonical declaration lookup.
- Traced `extraction-source.ts:15-71`: Git tree order, valid declaration parsing, normalized URL match, captured Git blob ID, and fail-closed own/linked assertions.
- Checked authority at acquisition (`write-command.ts:91-123`), no-op/tip refresh (`write-broker.ts:255-305`), initial push and post-credential tip/binding checks (`write-broker.ts:70-167`), and semantic handoff capture (`write-broker.ts:341-378`). Source removal, declaration edit, default-tip advance, relink, and provider credential delay fail before a new push. Lost-push acknowledgement remains truthful because the first publication already passed the fence; canonical later retraction is explicitly open.
- Followed `sourceDeclaration` through `extraction.ts`, `write-job-intent.ts`, `workspace-write-jobs.ts:410-520`, `workspace-extract-ingest.ts`, and `workspace-semantic-merge.ts`. Exact extraction equality is required for replay and native child ownership; the semantic child reacquires and revalidates the same source.
- Inspected pinned native source/restart cases for workspace, linked, unlinked-before-resume, edited-before-resume, unchanged publication, Git commit count, and failed-step projection.

## Capture bounds and producer flow

- Verified `extractionCaptureBudgetSchema` checks 8 MiB, 10,000 objects, and 50,000 claims before nested command parsing; the final strict extraction schema canonicalizes duplicates deterministically.
- Traced pre-persistence guards at `runExtractKindForRoot`, combined identify output, final repository aggregation, direct admission, persisted intent, workflow input, and semantic child input.
- Found the uncovered predecessor boundary: `identify-roots` itself is unbounded, while nested `Promise.all` fan-out occurs before aggregate guards. Reported as one P1 with a manifest-driven trigger and concrete bounded-pool fix.
- Rechecked the previously withdrawn optional-metadata concern against the pinned historical native fixture and OpenWorkflow/PostgreSQL round-trip semantics. No raw `undefined` reaches the final schema.

## Cleanup and interface coverage

- Reviewed the connector schema/runtime split (`connector-mirror-input.ts`, `connector-mirror.ts`) and its imports in DB types, admission, mirror workflow, semantic workflow, and broker. The split breaks the admission runtime cycle without changing binding/scope behavior.
- Searched the pinned production tree for removed `retrievalObjectWrite`, object/projection reducer fields, graph writes, embedding writes, and legacy merge names. No production caller remains; migration poison/setup data is isolated in `test/legacy-extraction-fixture.ts`.
- Reviewed removal of old schema tests and reducer fields against repository-ingestion state construction and current extract callers. Current state retains only repository/index inputs, roots, objects, and claims.

## Scope classification

- Finding count: **1 P1, 0 P2, 0 P3**.
- Not findings because the checkpoint explicitly retains them as Gate 3 work: canonical Git retraction, complete multi-workspace endpoint mapping, a live extractor journey, native producer terminal-owner recovery, and the broader status/audit inventory.
- No additional implemented-scope defect found in declaration selection, immutable command ownership, source revalidation, semantic inheritance, duplicate merge, or retired projection cleanup.
