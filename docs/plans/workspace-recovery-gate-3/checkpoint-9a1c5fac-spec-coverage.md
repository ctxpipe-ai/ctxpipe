# Coverage — G3-A/B milestone `9a1c5fac`

## Boundary

- Pinned range: `ec6d5340c4db91c4e888540deedddaa891ad9f58..9a1c5fac4fd6d8e2298a5fc25d8873239b22bcbf`
- Reviewed production and focused contracts only, then pinned direct callers/interactions with `git show`/`git grep`.
- Reused prior accepted evidence; did not inspect historical logs, run tests, alter the repository, or reopen the nonblocking heuristic backlog.
- Specs: Gate 3 in `docs/plans/workspace-chat-recovery.md`, locked write tickets, ADR-033, and `docs/plans/workspace-recovery-gate-3/remaining.md`.

## G3-A ownership

- Connector identity: `models/connector-content-sync.ts` prepare/reuse, activation, prior-generation lookup, lost-ACK recovery, config/content failure projection.
- Connector recovery: `db/backfill-connector-content-admissions.ts` owner and later-run selection.
- Connector callers: both `enqueue-connector-config-sync.ts` and `enqueue-connector-content-sync.ts` recovery paths.
- Repository identity: `models/repository-ingestion-requests.ts` lookup/activation/write predicate; `models/repository-ingestion-owners.ts` reader projection; `db/backfill-repository-ingestion-requests.ts` upgrade selection.
- Focused proofs reviewed: `routes/v1/connector-content-admission-native.contract.test.ts` covers config/content × foreign version/namespace through admission, stored pointer, activation, and terminal projection; `repository-ingestion-owner-native.contract.test.ts` covers foreign version/namespace/name across activation, pointer lookup, progress, and projection.
- Retirement: confirmed removed Linear/Notion initial-sync and retry claim helpers plus Confluence direct activation/upsert helpers have no remaining source references. Native admission replaces their focused contract uses.
- Result: previous ec6 P1 closed; no uncovered owner lookup found in the milestone’s declared surfaces.

## G3-B replay/resume

- `models/workspace-write-jobs.ts`: existing semantic handoff equality excludes the refreshed revision while requiring immutable owner/candidate/delta; returns the complete persisted handoff.
- `domain/workspaces/write-broker.ts`: child input uses returned persisted revision/files/deletions rather than second-attempt calculations.
- All eleven mechanical parent workflows were traced to the shared `captureSemanticHandoff` interface; `workspace-semantic-merge.ts` validates the complete stored handoff against the sole job row.
- `write-worker-loss-native.contract.test.ts`: focused proof holds the real handoff transaction after commit, kills the first process, advances the human tip again, starts two replacements, and asserts three total commits (two human, one job), one durable job result, and two capture attempts.
- `openworkflow/enqueue-workspace-write-commit.ts`: legacy SHA adoption applies only to queued/paused, ownerless, uncommitted rows without a captured revision.
- `write-job-intent.ts`, `write-job-resume.ts`, and `workspace-tip-check.ts`: traced the production paused-job row through claim and enqueue; row generation, URL/default metadata, and `desiredSha` are preserved.
- `write-pause-native.contract.test.ts`: focused legacy case adds a second post-admission human tip and verifies one bootstrap commit on top.

## Outcome

- Actionable Spec findings: **0**
- Previous connector wrong-version finding: **closed**
- G3-A: no blocking issue found in reviewed correction
- G3-B: no blocking issue found in reviewed correction
- G3-C–G: explicitly pending; not reviewed as completed scope
