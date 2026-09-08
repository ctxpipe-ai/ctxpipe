# Gate 3 G3-A/B milestone — Standards review

Pinned increment: `ec6d5340c4db91c4e888540deedddaa891ad9f58..9a1c5fac4fd6d8e2298a5fc25d8873239b22bcbf`

## Documented-standard violations

None in the reviewed increment.

The prior connector-owner blocker is closed. Config/content admission recovery, activation, stored-pointer reuse, terminal projection, and upgrade selection now require the default namespace, expected workflow name, and null version (`apps/backend/src/models/connector-content-sync.ts:160-180,200-234,337-351,413-495`; backfills at `db/backfill-connector-content-admissions.ts:36-59`). Repository ownership applies the same identity to direct IDs, fallback keys, progress fences, status projection, and upgrade recovery (`models/repository-ingestion-requests.ts:18-26,100-188`; `models/repository-ingestion-owners.ts:18-35`; `db/backfill-repository-ingestion-requests.ts:8-27`). Native negative cases cover foreign version/namespace through the production admission and persisted-pointer paths.

Semantic handoff persistence is idempotent across a lost transaction reply: a matching persisted owner/candidate/delta returns its original revision and files, while a different delta fails (`models/workspace-write-jobs.ts:410-467`). `captureSemanticHandoff` builds the child only from that returned record (`domain/workspaces/write-broker.ts:354-395`), preserving the first durable base when a second remote tip appears. The native COMMIT-loss/SIGKILL cases exercise replacement-process recovery and one final Git result.

Legacy paused admission adopts `desiredSha` only for an ownerless, uncommitted paused/queued row, then applies existing generation/URL/SHA/default checks (`openworkflow/enqueue-workspace-write-commit.ts:190-229`). The broker reconciles later tips. Superseded connector lifecycle helpers have no remaining callers.

## Fowler heuristic backlog (9; non-blocking)

Per the milestone brief, the existing backlog was retained without re-investigation: **Mysterious Name (2)**, **Repeated Switches (1)**, and **Duplicated Code (6)**.

**Blockers: 0.** Gate 3 remains open for G3-C–G in `docs/plans/workspace-recovery-gate-3/remaining.md`.
