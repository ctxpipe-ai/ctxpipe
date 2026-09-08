# Gate 3 seven-kind Spec review coverage

## Identity and method

- Axis: independent Spec review, read-only.
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Reviewed exact pushed commit: `398e5f186007e603fe878afc7ce7bbe9eddf3640`.
- Enumerated the five commits in `base..target`, inspected `git diff base...target` and the focused `46aaecab...target` changed surface.
- Every file read used `git show target:path`; searches used target-qualified `git grep`. The moving checkout was not review evidence.
- No suites were run. Accepted the supplied evidence of 53 focused native/HTTP checks, 143 acknowledged backend diagnostics with none new, and proof-policy 435 test/story/config plus 27 command files. Exact-SHA CI `34212392175` was still running during review.

## Accepted contracts traced

- Gate 3 plan: `docs/plans/workspace-chat-recovery.md:642-659`.
- Native recovery override: `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:7-23`.
- Git-canonical knowledge/links: `.ai/scratchpad/git-backed-projects/issues/02-hydration-contract.md:30-65`.
- Layout and folder-map semantics: issue `03-knowledge-file-layout.md:15-45`.
- Workspace and linked-repository lifecycle: issue `09-project-repository-lifecycle.md:64-112`.
- Write protocol: issue `10-ingest-to-git-write-protocol.md:66-132`.

## Seven-kind ledger

| Kind/area | Pinned source trace | Assessment |
| --- | --- | --- |
| Bootstrap | Typed workflow, bounded allowlist, immutable revision, shared native stage/commit/broker. | No new defect found. |
| UI file edit | Literal files/deletes persist in command identity; target Git modes and one-candidate semantics retained. | No new defect found. |
| Import-key cleanup | YAML-node deletion preserves BOM/CRLF/metadata/body. | No new defect found. |
| Claims upgrade | Normalized target dedupe plus in-place YAML sequence mutation. | Prior three findings remain corrected. |
| Valid-from | Mutates only missing/SHA validity nodes and preserves claim metadata/comments. | No new defect found. |
| Ops/folder map | Requested name is typed, persisted, committed, and hydrated; invalid marker sets fail terminally; exact prior directory instruction and encoded paths are covered. | Ambiguous first-folder-list heuristic remains destructive (finding 2). |
| Link/unlink | Typed action+URL schema; immutable DB/OpenWorkflow command; reads only `repositories/*.md`; same-basename allocation; normalized no-op; targeted unlink; one native commit; canonical publish/hydrate. | Raw secret persistence and incomplete identity canonicalization remain (findings 1 and 3). |

## Named follow-up verification

- **Display name API:** `routes/v1/workspaces.ts:378-415` passes `body.displayName`; `workspace-lifecycle.ts:97-119` creates an explicit job ID and awaits admission; `write-job-intent.ts:17-107`, `enqueue-workspace-write-commit.ts:206-224`, and `workspace-ops-folder-map.ts:38-201` preserve it as command identity; `folder-map.ts:53-60` updates only the YAML name. `write-ops-native.contract.test.ts:63-198` proves HTTP → command → Git → native hydrate.
- **Unrelated directory instruction:** the exact earlier scenario is retained by the strengthened contract (`write-maintenance-native.contract.test.ts:508-654`). Finding 2 covers a different accepted-by-regex ambiguity.
- **Markers:** `folderMapMarkerState` requires exactly one ordered pair (`folder-map.ts:24-44`); invalid input throws, the transform step has one attempt, and the native job reaches failed without a commit (`write-ops-native.contract.test.ts:7-61`).
- **Permanent Layer 1:** `hydrate.ts:156-209` always emits one body `LINKS_TO` per resolved target while retaining typed claim edges; a predicate-less claim without a body link still becomes Layer 1. Graph and hydrate tests cover coexistence and dedupe.

## Link/unlink caller and state coverage

- User routes: `routes/v1/workspace-linked-routes.ts:144-231` list the active projection, reject exact normalized self/duplicate URLs, attach operational repository metadata, and enqueue link/unlink.
- First-workspace auto-link: `workspace-lifecycle.ts:38-95` enqueues one typed command per discovered repository.
- Admission: `enqueue-workspace-write-commit.ts:94-235` snapshots the desired revision, requires writable state for native dispatch, and persists action/URL before scheduling.
- Ownership/replay: `write-command.ts:55-82` and `models/workspace-write-jobs.ts:326-425` compare action and URL as immutable identity.
- Transform: `link-declarations.ts:11-43` preserves other declarations, chooses a collision-free flat filename, no-ops existing target, and deletes matching target declarations.
- Workflow: `workspace-link-unlink.ts:39-180` has explicit acquire/transform/stage/validate/commit/broker/publish/enqueue-hydrate/complete steps and stale-no-op refresh.
- Hydrate: `hydrate.ts:48-97` activates valid declarations in tree order and skips malformed/duplicate exact normalized URLs.
- Existing identity evidence: `slug.ts:36-49` and `slug.test.ts:96-101` already define/test GitHub owner/repository identity as case-insensitive, but the link route, transform, and hydrate do not use it.

## Common mechanics

- Broker actual-default/relink/writable fences, normal Git non-fast-forward rejection, descendant lost-ack ancestry, candidate persistence before push, canonical containing-revision publication, and durable hydrate enqueue before completion are unchanged and remain consistent with ADR-033.
- Admission/terminal status reconciliation remains scoped by org/workspace/job/owning run.
- Serial backend test files address a shared production OpenWorkflow namespace; explicit replica/retry/concurrency contracts remain. This is test isolation, not product workflow serialization.

## Explicit open scope, not findings

Five remaining kinds; automatic planner and per-kind caps; protected/read-only pause/resume; rebase/semantic conflict recovery; alternate writer/credential migration; legacy deletion. Concurrent auto-link jobs still depend on the acknowledged semantic-conflict work. These prevent terminal Gate 3 acceptance but were not counted as checkpoint defects.
