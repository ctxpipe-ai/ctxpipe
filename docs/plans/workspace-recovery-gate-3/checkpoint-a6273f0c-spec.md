# Gate 3 planner/admission checkpoint — Spec review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...a6273f0cec39f7fd28e9e0af20109dbf8e4432b2`  
**Decision:** fail for implemented scope — 1 high-priority finding.

## Finding

**[P1] Fence permission-probe persistence to the captured repository binding — `apps/backend/src/openworkflow/enqueue-workspace-write-commit.ts:80-105,150-168`; `apps/backend/src/models/workspaces.ts:1578-1592`.** Admission snapshots workspace A, performs remote I/O, then `persistWriteStatus()` updates solely by workspace/org id. If relink commits while that probe is in flight, A's result is written onto binding B. An already-scheduled B workflow can then read the new atomic `{revision B, writeStatus from A}` through `getWorkspaceWriteAdmission()`, so a stale `writable` result admits credential issuance and a push attempt for a binding that was classified read-only; the inverse stale result wrongly blocks B. The new single-row broker read therefore fixes the prior split-read interleaving but does not make write admission binding-atomic.

This violates ADR-033 line 22: **“Broker admission reads revision and write status from the same PostgreSQL row version. Final binding validation cannot combine an earlier revision with a later writable row after relink.”** Persist the probe with a CAS over captured generation, URL, connection, default branch, and desired SHA (or serialize/re-resolve), and do not return the probed status when that CAS loses. Add a real PostgreSQL relink-during-probe test that releases an already-scheduled new-binding workflow after the stale probe completes.

## Reviewed scope

The four-kind hydrate planner otherwise preserves native ownership and planning metadata, serializes reservations, carries maintenance lineage through published planned commits, enforces three attempts/non-shrinking remainder independently, and retains paused intents. Pinned evidence demonstrates actual SIGKILL, deleted checkout, and two independent replacement workers with one commit/result. Repository-scoped read-token and app-auth fallback paths issue no write token during probing. Declared remaining Gate 3 work and Gates 4–6 were excluded; this is not Gate 3 acceptance.
