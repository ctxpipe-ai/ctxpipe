# Gate 3 twelve-kind checkpoint — Standards review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...cab528013bb3e49ddfc05d419984f03494d6579d`
**Decision:** changes requested — 2 documented-standard blockers, 0 new Fowler heuristic findings.

## Documented-standard breaches

### [P1] Preserve every durable object-to-path assignment

`apps/backend/src/domain/workspaces/migration-export.ts:651-658` replaces `knowledgePaths` with entries for only the objects assigned in the current projection, while `apps/backend/src/models/workspace-write-jobs.ts:495-515` loads only the newest completed map. If object B disappears for one completed projection, that result drops B's assignment. When B returns after import-key cleanup, the still-existing prior path cannot be recovered and a second path can be allocated. This violates ADR-033:14, which requires completed jobs to retain imported-object-to-path assignments so later extraction can reuse them. Merge validated prior entries into each result, or fold completed maps newest-to-oldest per key; add an assign → omit → complete → reassign proof.

### [P1] Capture projection data and the cutover marker in one SQL snapshot

`apps/backend/src/openworkflow/workflows/workspace-extract-ingest.ts:94-115` builds one durable transform input with three separately committed model calls: source objects/claims, completed path metadata, then migration-export completion. An export may complete between the path read and marker read, producing `knownKnowledgePaths = {}` with `stampImportKey = false`; extraction can then allocate a duplicate after cleanup. The backend standard (`apps/backend/AGENTS.md:11`) requires a transaction for multi-table operations, and ADR-033:18 requires short org SQL transactions. Provide one short model operation (and a consistent snapshot/query) for this logical read and characterize the interleaving.

## Heuristic smell review

No additional Fowler smell rises to a finding. The renamed projection helpers and extraction step resolve the prior Mysterious Name concern. The repeated workflow skeleton is deliberate under ADR-033's typed per-kind protocol.

## Verified

The four connector readers now return binding URL and connection ID from their joined statement; broker validation no longer combines snapshots. Paused mirror identity and completed same-binding export/extraction paths are carried explicitly. The semantic-merge workflow uses native three-way merge data, current-tip sole parenting, immutable command binding, replay recovery, and no-op handling. Declared unfinished Gate 3 capabilities were excluded from acceptance findings. I reviewed pinned blobs only and did not rerun the supplied 35-test/type evidence.
