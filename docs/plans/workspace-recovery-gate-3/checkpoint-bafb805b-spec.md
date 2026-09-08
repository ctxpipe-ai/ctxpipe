# Spec review — Gate 3 semantic/model checkpoint

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...bafb805b2c16b2b9816d4bada2c4b692282c8945`.

## Findings

1. **[P1] Unset-provider deployments are forced to Docker, disabling semantic conflict jobs on Fargate.** `semantic-merge.ts:32-48` calls `detectSandboxProviderFromEnv({ hasDocker: true })`, so an unset `SANDBOX_PROVIDER` can never select `unsandboxed`; it constructs Docker even when no daemon exists. Ticket 10:92 explicitly requires: “Fargate v1 has no sandbox provider — jobs still run, unsandboxed.” The locked topology also says unset must detect a reachable Docker API and otherwise use local process (ticket 08:145-154). Use real capability discovery/the existing provider seam and add an unset/no-Docker resource proof. The same factory currently rejects the locked `railway` selection at lines 35-39, so either wire that provider or keep semantic-conflict support explicitly incomplete for that deployment.

2. **[P1] Valid modify/delete resolutions can never be published.** `merge-tree.ts:72-85` defines `merged.paths` as the provisional merge tree’s diff from current. For a base file modified on current and deleted by the incoming command, native `merge-tree` leaves current’s file in its conflicted tree, so that diff is empty while `conflicts` contains the path (`:86-115`). The model is expressly allowed to return `null` (`semantic-merge.ts:60-69,100-103`), but after applying that deletion the workflow validates against the empty `merged.paths` (`workspace-semantic-merge.ts:171-175`) and throws `Invalid write tree`. This violates ticket 10:82/105’s semantic resolution requirement and ADR-033:16’s rule that model output may replace conflict paths. Authorize the union of clean changed paths and exact conflict paths, then validate the final current-to-resolved diff; cover modify/delete and delete/modify choices.

The two prior admission findings are fixed: paused intents are insert-and-compare immutable, and semantic content is validated before status branching. Extraction now reads source, cumulative path maps, and cutover in one repeatable-read snapshot. Structured output rejects extra/missing paths and provider cleanup precedes push for completed attempts.

Declared automatic handoff, abandoned/cancellation cleanup, broader restart/replica proof, semantic no-op edges, planning/caps, full pause/protection, caller/credential migration, and legacy deletion remain open. This is not Gate 3 acceptance.
