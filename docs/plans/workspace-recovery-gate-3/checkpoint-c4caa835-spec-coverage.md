# Gate 3 ingestion checkpoint — Spec coverage ledger

## Pin and scope

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed checkpoint: `c4caa83503c4ea1cd1648c86de6574f3107f8144`
- Cumulative comparison: `git diff bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...c4caa83503c4ea1cd1648c86de6574f3107f8144`
- Increment comparison: `git diff c869ba820ad722a3c5936568a69d02baa1546bb9...c4caa83503c4ea1cd1648c86de6574f3107f8144`
- Increment commit: `c4caa835 Gate 3: persist native ingestion ownership and preserve claim sources`
- All product/spec reads used `git show c4caa83503c4ea1cd1648c86de6574f3107f8144:<path>`. No implementation files or working-tree state were changed. No test process was run.

## Standards and requirements read

- `docs/plans/workspace-chat-recovery.md:642-659` — typed OpenWorkflow jobs, native Git, retry/idempotency, removal of duplicate choreography.
- `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:68-82,110-132` — one commit/no-op, conflict, loop guard, hydrate, binding checks.
- `.ai/scratchpad/git-backed-projects/issues/11-project-revision-and-freshness.md:47-59,82-110` — desired/default ref and SHA, index publication CAS, missed-tip reconciliation.
- `.ai/scratchpad/git-backed-projects/issues/02-hydration-contract.md:32-70` and `03-knowledge-file-layout.md` — Git-canonical knowledge, one signal per asserting path, claim/source shape and metadata preservation.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:37-45` — extraction ownership, retraction, bounded roots, owner-first repository ingestion.
- `docs/plans/workspace-recovery-gate-3/status.md:513-539` and `write-path-audit.md:38-40` — claimed retraction corrections/current-owner slice and explicitly open work.
- Root and backend `AGENTS.md`; `.agents/skills/code-review/SKILL.md` (filesystem-only review skill, absent from the pinned commit).

## Changed interface and caller trace

| Surface | Pinned files/callers inspected | Result |
| --- | --- | --- |
| Request schema/migration | `db/schema/repositories.ts:87-113`; generated migration `20260908204523_repository-ingestion-owner`; `db/migrate.ts:35-40`; `db/backfill-repository-ingestion-requests.ts:3-26` | One current RLS row per repository, unique request key, migration-order backfill, and no replacement of an existing request are implemented. Backfill selects the latest legacy orchestrator and does not enqueue. No finding in the claimed migration-only behavior. |
| Admission/activation | `models/repository-ingestion-requests.ts:18-173`; `openworkflow/enqueue-repository-ingestion.ts:14-44`; orchestrator `:7-49` | Repository lock, immutable binding, native idempotency key, lost-response lookup, first-step activation, and active-owner reuse traced. Two production callers still drop the admission promise: `routes/v1/repositories.ts:323-329` and `routes/v1/connectors-atlassian.ts:992-999` (Finding 1). Other callers in Linear `:738-753`, Notion `:920-933`, Slack `:681-696`, reindex `repositories.ts:353-365`, GitHub webhook `github.ts:117-137`, and `ensure-org-repository.ts:68-80` await it. |
| Owner/status projection | `models/repository-ingestion-owners.ts:6-74`; `repositories.ts:97-157,387-518`; route serializer `routes/v1/repositories.ts:266-309` | Current binding join, native failed/canceled projection, search-warning preservation, and fenced DB progress/terminal updates are present. Owner tests cover cancellation, failed insert/retry, upgrade preservation, warning projection, and late source cancellation. |
| Producer identity | `repository-ingestion.ts:51-140,177-258,275-290,468-525,551-624`; `repository-ingestion-requests.ts:175-255`; `graphs/.../setIngestionIndexingStep.ts:17-44` | Request is recovered from native parentage, added to graph progress and extraction, and asserted by extraction acquire/no-op/broker paths. The codesearch child receives no request/binding authority and performs unfenced external mutations (Finding 2). |
| Follow-up | `enqueue-follow-up-if-tip-ahead.ts:3-45`; caller `repository-ingestion.ts:592-617`; native contract `enqueue-follow-up-native.contract.test.ts:10-59` | Awaited admission, `afterRequestId`, retry after failed INSERT, and repeated successor reuse are covered. Test uses explicit `trunk`; nullable/default-ref behavior is wrong (Finding 3). |
| Extraction source fences | `extraction.ts:28-120`; `extraction-source.ts:16-79`; `write-command.ts:91-123`; `write-broker.ts:70-178,270-317`; `workspace-extract-ingest.ts:47-250` | Request ID is persisted in immutable input and rechecked at acquire, no-op refresh, precredential push, postcredential push, and semantic handoff paths. Source declaration blob/path checks are retained. |
| Retraction fixes | `dest-workspace-first.ts`; `migration-export.ts:97-155,449-673`; `plan-extraction.ts:15-101`; `retract-extraction.ts:13-136`; retraction native contract | Distinct canonical source strings are no longer collapsed; overlap works in both path directions; first `#` splitting and segment encoding preserve current hash paths. Raw-string merge identity fails to converge old unescaped/URL-alias spelling with the canonical encoded source (Finding 4). |
| Removed legacy ownership | Production search for `tryClaimRepositoryIndexingEnqueue`, `markRepositoryIndexingPending`, `markRepositoryIndexingFailed`, and callback failure helpers | No remaining production caller. Old mock-centric admission/orchestrator/follow-up tests are removed and native contracts replace their behavior checks. |

## Adversarial triggers checked

1. API process exits or native INSERT rejects after `void` call but before owner activation.
2. Active request A indexes branch A; a different-ref request B supersedes it; A’s Zoekt/SCIP side effects finish after B.
3. A null/default request resolves `main`; hosting default moves to `trunk` before the follow-up step.
4. Existing canonical Markdown contains the historical unescaped source `repo#src/a#b.ts`; the next extraction emits `repo#src/a%23b.ts`.
5. Cancellation before/after activation, superseded status completion, source removal/edit, binding change during credential issuance, repeated successor callback, failed native insert, and migration rerun were traced against the pinned native contracts; no additional defect was found in those covered paths.

## Evidence assessed (not rerun)

- Status claims 46 combined ownership/follow-up/producer/connector checks plus six owner-race checks, backend types with 132 acknowledged diagnostics, generated migration integration, and proof policy.
- Reviewed native contracts/logs include canceled owner/write, failed admission, concurrent retry, newer owner, superseded status/producer, late source fence, follow-up admission, migration upgrade, warning preservation, and per-source/directory/hash retraction.
- Coverage gaps relevant to findings: no native HTTP loss case for the two `void` callers; no mid-index supersession/CAS case; follow-up test always supplies an explicit branch; hash test starts with already encoded source text.

## Declared open scope excluded from findings

Full live extractor journey, complete endpoint/reference normalization, direct post-INSERT transport-ACK injection, remaining config/source ordering, true unborn bootstrap, model/allocation crash proof, workspace/semantic admission uncertainty, duplicate implementation cleanup, final CI, and Gate 3 terminal acceptance remain explicitly open. Findings above concern behavior already claimed or wired in the checkpoint.
