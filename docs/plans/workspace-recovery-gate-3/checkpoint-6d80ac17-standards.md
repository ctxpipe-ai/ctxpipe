# Gate 3 race/cleanup checkpoint — Standards review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...6d80ac1729e5e6628de6b13a20bb0b5e2c44eb17`  
**Decision:** fail for implemented scope — 1 documented-standard breach, 0 Fowler heuristic findings.

## Documented-standard breach

**`apps/backend/src/domain/workspaces/write-broker.ts:89-115` — the final write-admission check is assembled from two SQL snapshots.** `getDesiredWorkspaceRevision()` and `getWorkspaceById()` execute separate `orgSql` transactions (`apps/backend/src/models/workspaces.ts:172-185,278-285`). A relink can therefore commit after `admitted` reads the old revision but before `live` reads the new row. Because the second result contributes only `writeStatus`, a writable replacement binding passes the condition and the broker pushes `committed` to the former repository URL. The same split exists in the earlier check at `write-broker.ts:45-51`; the final occurrence makes the stale write reachable immediately before native push.

This violates ADR-033 lines 20-21: only the broker may obtain the repository-scoped credential, and “full binding identity is checked immediately before push.” It also defeats the immutable-binding fence required by the accepted recovery design. Read revision plus write status in one repository/model statement (or return one admission record) and use that atomic result at both checks; add a real PostgreSQL interleaving proof between those reads.

## Heuristics and resolved findings

No additional Fowler smell is retained. The prior Data Clump/Duplicated Code finding is resolved by `WorkspaceSemanticHandoff` (`write-job-intent.ts:21-32`; `db/schema/workspaces.ts:16,180`). Explicit per-kind step repetition remains an ADR-033 requirement and is suppressed. Tool-enforced issues and declared unfinished Gate 3 work were excluded.

Recorded native/type/migration/install evidence was inspected, not rerun. This is an intermediate-checkpoint result, not Gate 3 acceptance.
