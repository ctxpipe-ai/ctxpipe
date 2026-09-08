# Spec review — Gate 3 race/cleanup checkpoint

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...6d80ac1729e5e6628de6b13a20bb0b5e2c44eb17`.

## Findings

No new correctness finding in the implemented slice.

The prior P2 is resolved. Upgrade reconstruction joins the exact native owner by run/org/workspace/job, ranks successful native executions by immutable `finished_at`, falls back to immutable job `created_at`, and excludes mutable `updated_at` (`backfill-knowledge-path-state.ts:16-39`). OpenWorkflow migrations now precede that query (`db/migrate.ts:34-38`). This matches ADR-033: “Historical ordering uses the matching native run completion time, falling back to immutable admission time” (`ADR-033-native-durable-write-workflows.md:15`).

Post-admission and repeated native Git races now follow the required semantic path. A rejected candidate is cleared only when the running row still contains that exact SHA (or its idempotent already-cleared state) (`workspace-write-jobs.ts:508-527`); semantic merge refreshes and retries three times, while continuous races terminate without claiming a commit (`workspace-semantic-merge.ts:141-161,283-329`). Lost-push acknowledgement checks remote containment before rejecting newly read-only state and still fences the full binding (`write-broker.ts:45-70`), satisfying ticket 10’s “If origin already has it, skip push and hydrate” requirement (`10-ingest-to-git-write-protocol.md:120`).

Provider plan, deadline, allocation, model call, normal destruction, and independent expiry cleanup are explicit durable operations. Cleanup is admitted before allocation and confirms absence after the maximum in-flight request window (`workspace-semantic-merge.ts:190-241`; `workspace-semantic-cleanup.ts:19-34`); Docker outages remain failures rather than false absence (`semantic-merge.ts:86-109`). This conforms to ADR-033’s deadline/cancellation contract (`ADR-033:16`).

Declared process/filesystem-loss and independent-process replica proof, Railway/sbx, planner/caps, pause/protection/resume, alternate writers, legacy deletion, and Gates 4-6 remain open. This is not Gate 3 acceptance.
