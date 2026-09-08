# Gate 3 ingestion-owner checkpoint — Standards review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...c4caa83503c4ea1cd1648c86de6574f3107f8144`

## Documented-standard violation (1)

**[P1] Two HTTP callers discard the new durable-admission promise.** `enqueueRepositoryIngestionWorkflow` now performs request reservation, native enqueue/lost-ack recovery, and activation before resolving, and it rethrows when no owner exists (`openworkflow/enqueue-repository-ingestion.ts:14-44`). Most callers await that contract, but repository creation uses `void` (`routes/v1/repositories.ts:319-333`) and Confluence config save does likewise (`routes/v1/connectors-atlassian.ts:992-999`). Either route can acknowledge success before an owner exists; a failed insert becomes an unhandled rejection rather than the route’s existing error response. This violates ADR-033’s checkpoint rule that queued state is published only after OpenWorkflow accepts the key, and the root TDD rule that owned admission be proved at the public seam. Await admission and map failure at both routes; add native HTTP failure/retry coverage.

The previous `#`-path blocker is closed: extraction encodes each source-path segment, retraction splits only at the first separator and decodes the full fragment, and claim identity now retains distinct sources. Directory overlap and native regression coverage match ADR-033.

## Fowler heuristic judgments (7; non-blocking)

The cumulative judgments remain: **Mysterious Name (2)** (`sourceId`→`evidenceKey`; dual-purpose `contentSyncWorkflowRunId`), **Repeated Switches (1)** in connector lifecycle dispatch, and **Duplicated Code (4)** across typed write admission, connector admission, GitHub credential issuance, and conversation preparation/publication. The new `RepositoryIngestionIntent` gathers the owner fields, so no new Data Clump applies; the compatibility export name is required by the source-connector contract and is not counted as Middle Man.

**Blockers: 1.**
