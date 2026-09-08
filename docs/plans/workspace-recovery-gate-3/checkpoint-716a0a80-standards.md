# Gate 3 source-budget checkpoint — Standards review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...716a0a80a2679b74fb9a3dc1f18c57c93d3573a2`

## Documented-standard violations (0)

None found in the implemented scope. The linked-source path/blob identity is captured in the immutable extraction batch and checked during acquisition, broker refresh/push/no-op paths, and semantic handoff. Per-root and final captures receive object, claim, and serialized-byte ceilings before durable persistence. Connector schemas are now pure imports, and network/Git work remains outside organization-scoped SQL transactions. Native Git/PostgreSQL/OpenWorkflow tests cover declaration removal/edit, restart, and oversized admission, consistent with ADR-033 and the TDD/mocking rules.

## Fowler heuristic judgments (7; non-blocking)

- **Mysterious Name (2):** `sourceId` becomes `evidenceKey` without expressing that equivalence (`extraction.ts:54`; `plan-extraction.ts:69-75`). `contentSyncWorkflowRunId` still represents both proposal/setup and content-run ownership (`db/schema/connections.ts:39` and `models/connector-content-sync.ts`). Introduce names/types for the actual concepts.
- **Repeated Switches (1):** provider lifecycle parsing, binding, and publication repeatedly dispatch on provider in `models/connector-content-sync.ts:26-96,104-538`; consolidate provider behavior behind one map or provider-owned implementation.
- **Duplicated Code (4):** cumulative admission/persistence branches in `openworkflow/enqueue-workspace-write-commit.ts:220-381`; connector admission flows; GitHub credential issuance in `models/github-installation.ts`; and conversation preparation/publication across `routes/v1/conversation-files-routes.ts` and `routes/v1/conversations.ts` retain parallel shapes. Share the invariant-bearing parts while keeping workflow lifecycle explicit.

The prior **Speculative Generality** finding is closed: unused graph reducers, test-only retrieval-object runtime APIs, and `runExtractForRoot` were removed. No new heuristic arose in this increment. Declared unfinished Gate 3 inventory remains acceptance work, not a checkpoint defect.

**Blockers: 0.**
