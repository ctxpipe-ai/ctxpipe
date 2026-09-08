# Gate 3 fd7 checkpoint — Standards review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...fd7f8817d3417a9cb5c4ce3e5a46fb3b1a782fa1`

## Documented-standard violation (1)

**[P1] Lost-ack recovery does not prove the typed workflow owner.** `nativeWriteJobOwnerId` matches org/workspace/job/revision and the default-namespace idempotency key, but never checks `workflow_name` or `version` (`apps/backend/src/models/workspace-write-jobs.ts:569-581`). OpenWorkflow scopes idempotency by workflow name, so another workflow may legitimately have the same key. Before the intended workflow reaches `persistBoundWriteJob`, reconciliation can persist that unrelated run as `workflowRunId`, return successful admission, or project its cancellation/failure onto this job (`workspace-write-jobs.ts:584-610,738-774`). This violates ADR-033:11,18,33: every kind has a typed workflow, status follows the **owning** run, and uncertain admission must recover the accepted owner. The repository-ingestion equivalent correctly includes the fixed workflow name and null version (`repository-ingestion-requests.ts:18-24`). Derive the expected workflow identity from the immutable job kind and include it in both explicit-ID and lost-key lookup; add a native negative case with a same-key, wrong-workflow run before claim.

The prior readiness blocker is closed. Queue/running/issue transitions derive readiness from the retained published hash (`models/repositories.ts:415-496`; `models/repository-ingestion-requests.ts:101-157`), and the replacement native contract exercises the public enqueue → orchestrator → producer → index path (`repository-index-source-native.contract.test.ts:130-228`). Dot-segment/encoded evidence normalization and repository-subject projection through existing `AGENTS.md` preserve owner prose and metadata (`retract-extraction.ts:13-51`; `plan-extraction.ts:27-114`; `workspace-extract-ingest.ts:96-120`).

## Fowler heuristic judgments (9; non-blocking)

The cumulative ledger remains **Mysterious Name (2)** (`sourceId`/`evidenceKey`; `contentSyncWorkflowRunId`), **Repeated Switches (1)** in connector lifecycle dispatch, and **Duplicated Code (6)** across typed-write admission, connector admission, GitHub credential issuance, conversation preparation/publication, captured-source JWT assembly, and backend/codesearch published-checkout SQL. This increment closes none of those shapes.

**Blockers: 1.**
