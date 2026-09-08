# Spec review — Gate 3 twelve-kind checkpoint

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...cab528013bb3e49ddfc05d419984f03494d6579d`.

## Findings

1. **[P1] Reusing a job ID through the pause fallback can replace its supposedly immutable command.** `workspace-write-jobs.ts:46-82` uses `ON CONFLICT DO UPDATE`, replacing `kind`, generation, target SHA, status, and the full payload for any existing row whose `commit_sha` is null—even an already queued/running native command. A retry of the same `jobId` with different semantic files/`previousSha` (or another migrated kind's fields) therefore changes or pauses what runs under that ID; `persistBoundWriteJob`'s exact comparisons occur only later. ADR-033:12 requires transforms over “captured immutable Git data,” and ticket 10:120 requires idempotency by persisted job ID. Make fallback admission insert-or-compare, rejecting a different command tuple, and add same-ID/different-payload plus running-owner proofs.

2. **[P2] Invalid semantic commands can be persisted and then stranded by resume.** `enqueue-workspace-write-commit.ts:128-172` validates mirror content before status branching, but validates semantic content only in the writable branch at `:193-202`; the fallback stores unchecked `previousSha`, files, and deletes at `:345-379`. After access returns, tip-check claims the row `queued` (`workspace-tip-check.ts:82-105`), native admission rejects it, and `resumePausedWriteJobs` still records it as resumed (`write-job-resume.ts:47-57`). Ticket 10:130 says paused semantic intents must “resume … when writable.” Parse a revision-independent semantic content schema before persistence and prove invalid read-only input creates no row/workflow.

The three prior review blockers are corrected: mirror validation/binding is retained atomically; export/extract path assignments are binding-scoped and require an extant Git target. Clean semantic rebase uses native three-way tree merge, publishes one current-tip-parent commit, replays, and no-ops correctly.

Declared overlap/model conflicts, automated handoff, provider resource steps, planning/caps, complete pause handling, caller/credential migration, and legacy deletion remain open. This is not Gate 3 acceptance.
