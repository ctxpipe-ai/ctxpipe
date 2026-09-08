# Spec coverage — Gate 3 race/cleanup checkpoint

## Identity and method

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `6d80ac1729e5e6628de6b13a20bb0b5e2c44eb17`.
- Verified both refs, enumerated 13 commits (`e7c18bd8` through `6d80ac17`), and reviewed the three-dot diff. All repository reads used pinned blobs/diffs; the moving worktree was not used as source.
- Read-only review: no repository mutation, delegation, or test execution.

## Specification applied

- Recovery plan foundation ownership and Gate 3 (`docs/plans/workspace-chat-recovery.md:47-58,89-104,264-279,642-659`).
- Locked write protocol (`.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:47-48,54,68-82,112-132,148-156`).
- Accepted recovery override and current contracts (`.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:11-23`).
- Pinned Gate 3 status and prior `checkpoint-9f719b0a` Spec report/coverage used to distinguish repaired findings from declared work.

## Source/interface coverage

- **Historical projection:** `db/backfill-knowledge-path-state.ts`, `db/migrate.ts`, workspace/job/path schema, completion projection methods, extraction snapshot consumer, and new native completion-order/migration-entrypoint proofs. Checked exact OpenWorkflow owner join, terminal timestamp, immutable fallback, RLS/binding filters, migration order, and idempotent no-overwrite.
- **Git race/recovery:** `write-broker.ts` remote containment, binding/access order, native push path; semantic workflow acquisition/merge/commit/push loop; exact-candidate discard and handoff validation in `workspace-write-jobs.ts`. Traced initial mechanical handoff, semantic native-push race, second race, continuous three-attempt failure, descendant lost-ACK, and read-only-after-publication paths.
- **Resource lifecycle:** `semantic-merge.ts` locator schema, provider planning, deadline validation, Docker/local create/resume, structured model abort, normal destroy, native 404 confirmation; new `workspace-semantic-cleanup.ts`; workflow registration/discovery; cleanup admission and idempotency keys. Inspected the pinned Docker provider patch’s pre-call abort checks and signal forwarding through inspect/pull/create/start/resume.
- **Public contracts/tests:** `write-job-intent.ts`, workflow discovery, native fixture hooks, affected merge/write/extract tests, and supplied logs for native CAS, repeated/continuous races, read-only recovery, deadline, Docker abort/outage, canceled-resource replacement worker, backfill ordering, migration entrypoint, and combined checkpoint.

## Adversarial conclusions

- Prior mutable-`updated_at` backfill defect fixed; exact owner completion time is preferred and the migration order makes the OpenWorkflow relation available.
- Native non-fast-forward after final admission converges through durable push retry into semantic refresh; subsequent semantic races release only the unpublished recorded candidate. Published ancestry is acknowledged before access rejection and still requires the same binding.
- Cleanup enqueue precedes allocation. Expired locators cannot allocate/resurrect; cleanup remains independent of owner cancellation and verifies provider absence after the 30-second request bound. Docker connectivity errors are retryable failures.
- One parent job/result identity, no-op hydration, immutable handoff, mirror binding, and export cutover behavior remain intact under the new loop.

## Explicit exclusions

The review does not convert the acknowledged process-kill/filesystem-loss and independent-process replica proof, Railway/sbx, planner/caps, full pause/protection/resume, alternate writer/credential migration, generic legacy deletion, or Gates 4-6 into findings.

## Evidence disposition

The pinned status reports 52 affected native checks across six suites, full backend types with 141 acknowledged diagnostics and no additions, migration entrypoint checks, scoped Biome/proof-policy/whitespace checks, frozen install, and prior checkpoint CI success. These were reviewed as supplied evidence and were not rerun.
