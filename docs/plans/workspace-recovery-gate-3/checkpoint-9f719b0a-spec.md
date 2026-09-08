# Spec review — Gate 3 owner/provider checkpoint

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...9f719b0a5402930d2221358582b1ccd589e74adc`.

## Finding

1. **[P2] The upgrade backfill can replay an older path assignment over a newer result.** The backfill chooses each key with `ORDER BY entry.key, j.updated_at DESC, j.id DESC` (`apps/backend/src/db/backfill-knowledge-path-state.ts:16-27`). Before this checkpoint, both completion helpers updated `updated_at` even when the row was already completed (visible in the pinned delta for `workspace-write-jobs.ts`). Therefore a lost completion acknowledgement for old job A, retried after newer job B completed, can make A look newest; the first upgrade backfill then permanently seeds A's stale path because later runs use `DO NOTHING` (`backfill-knowledge-path-state.ts:30-33`). This violates ADR-033's requirement that “Repeated completion cannot replay old assignments over newer results” (`ADR-033-native-durable-write-workflows.md:15`). Backfill from an immutable first-completion order/cursor (or reconstruct identity from Git), and add the pre-upgrade sequence A-complete, B-complete, A-completion-replay, migrate.

The four prior checkpoint findings are otherwise resolved. Runtime completion projects once under the workspace lock into one RLS row; reads are constant-history and binding-scoped. A semantic child validates the exact stored delta, keeps the mechanical parent as the sole job/result row, hydrates both no-op paths, and lets only the parent complete. Provider choice and locator are durably planned before allocation. All eleven handoff callers share this flow, including mirror binding and export no-op cutover.

Declared race, cleanup/restart/replica, Railway/sbx, planner/cap, pause/resume, alternate-writer/deletion, and Gates 4-6 work remains open; this is not Gate 3 acceptance.
