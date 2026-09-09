# Gate 3 closure correction — Spec review

Pinned target: `842e41bdeb68fc796d8a810a1dc17ccbf0d448e8`; focused increment: `d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67..842e41bd`.

## Findings

No blocking Spec findings.

The sole d3ba Spec blocker is closed. `persistLastJobAt`, `persistWriteJobIntent`, `persistWriteJobStart`, and `countWriteJobAttempts` are removed from `workspace-write-jobs.ts`; pinned repository-wide search finds no surviving reference. Job-row creation now remains in typed `persistBoundWriteJob`/`persistUnbornBootstrapJob` and the hydration planner’s paused reservation. This satisfies Gate 3’s requirement to **“Delete superseded write-intent, runner, and duplicate workflow choreography.”** ([recovery plan, line 651](docs/plans/workspace-chat-recovery.md)).

The adjacent source-authority correction is sound. `assertExtractionSource` applies one claims-only comparison to root `AGENTS.md` and captured linked declarations. It compares the candidate with the acquired parent revision, permits only `claims` changes, and rejects deletion, body changes, or non-claim metadata changes before credentials and at the broker’s final push fence. This also covers semantic-merge output while preserving a newer human parent as the comparison base. `updateKnowledgeMetadata` now adds front matter to a plain file without inserting an extra blank line, preserving the original body bytes required by ADR-033 line 46.

The prior cumulative ownership/default-push/credential audit remains unchanged and no new writer or owner was added.

**Count:** 0 Spec findings. Full CI remains pending, so this report does **not** declare Gate 3 complete.
