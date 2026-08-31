# Repository ingestion queue (per-repo)

Internal behaviour notes for engineers. Not public product documentation.

## Goals

- At most **one active** `repository-ingestion` orchestrator per repository at a time (shared codesearch checkout is not safe to share across concurrent runs).
- **Different repositories** may ingest in parallel.
- Mid-run pushes must not be lost forever after a **successful** ingest: catch up via tip check + one follow-up.
- **Failures** do not auto-chain (avoids retry loops on a broken tip). Next push or manual reindex starts a new run.

## Single-flight claim

[`tryClaimRepositoryIndexingEnqueue`](../src/models/repositories.ts) marks a repo `queued` and returns `true` only when status is not already `queued` or `running` (unless stale).

Callers: [`enqueueRepositoryIngestionWorkflow`](../src/openworkflow/enqueue-repository-ingestion.ts) (webhooks, UI retry) and `claimAndRunRepositoryIngestionChild` (in-workflow fan-out via `step.runWorkflow`).

If claim returns `false`, no new orchestrator is started for that event.

### Stale reclaim

If a claim is left stuck without a live workflow:

| Status    | Stale after | Constant                     |
|-----------|-------------|------------------------------|
| `queued`  | 30 minutes  | `INDEXING_QUEUED_STALE_MS`   |
| `running` | 6 hours     | `INDEXING_RUNNING_STALE_MS`  |

Staleness uses `repositories.updatedAt` (bumped when status transitions via claim / mark-running / mark-ready / mark-failed).

## Success tip follow-up

After `mark-success` in [`repository-ingestion.ts`](../src/openworkflow/workflows/repository-ingestion.ts), the workflow calls [`enqueueFollowUpIfTipAhead`](../src/openworkflow/enqueue-follow-up-if-tip-ahead.ts):

1. `resolveRepositoryRef` for the current tip.
2. If `tip === ingestedHash`, stop.
3. Else `tryClaim` + wake one orchestrator (`indexingReason: "follow-up"`).

That follow-up run uses normal partial ingest: `fromHash = lastIngestedHash` (just set) → `targetHash = tip`, so commits that arrived during the previous run are covered in one diff.

## Failure

[`repository-ingestion-orchestrator`](../src/openworkflow/workflows/repository-ingestion-orchestrator.ts) `mark-failed` does **not** tip-check or enqueue. Status stays `failed`. A later push or UI retry can claim again because status is no longer `queued`/`running`.

## Example: three fast commits

1. Commit 1 → claim → run A ingests `sha1`.
2. Commits 2–3 while A is in flight → claim skips.
3. A marks ready → tip is `sha3` → follow-up B starts.
4. B partial `sha1 → sha3` → ready → tip unchanged → stop.

## Example: first run fails

1. Run A fails → `mark-failed` only (even if tip moved).
2. Next push or manual retry → claim → new run to latest tip.
