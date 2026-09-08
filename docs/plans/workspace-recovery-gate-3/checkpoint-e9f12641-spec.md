# Gate 3 paused-write checkpoint — Spec review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...e9f12641bd7a8cf9292db13a84f1c7199b982bc5`
**Decision:** fail for implemented scope — 1 high-priority finding.

## Finding

**[P1] Access loss after acquisition still terminally fails every no-op path — `apps/backend/src/domain/workspaces/write-broker.ts:235-260`; e.g. `apps/backend/src/openworkflow/workflows/workspace-file-edit.ts:155-165`.** Each typed workflow now waits when acquisition returns unavailable and when a prepared push returns `paused`, but an empty transform calls `refreshWorkspaceWriteRevision()`. That shared validator throws whenever the current row is not `writable`, even after it successfully resolves the actual tip and confirms the same binding. A periodic probe can change access between acquisition and transform; an already-satisfied command then exhausts step retries/fails with “binding changed” instead of preserving its owner in a wait or completing the no-op. This affects all twelve workflows, and it is especially reachable for protection detected concurrently with a no-op.

Ticket 10 line 77 requires **“No file changes → skip.”** ADR-033 line 19 further requires: **“A result already present on that default can complete even if write access has since become read-only; no new write credential is issued.”** Remove write status from read-only no-op validation and complete when the resolved tip/binding is unchanged, or return a typed access-unavailable result and use the same durable wait loop. Add a real interleaving proof that revokes access after `acquire-revision` for an unchanged command and asserts no commit, no write credential, one owner, and a non-failed result.

## Reviewed scope

The prior stale-probe P1 is fixed by full-binding CAS and callers reject CAS loss. Paused commands retain their captured SHA, owner, planning metadata and prepared candidate; tip advancement routes to semantic reconciliation. Recognized push denial pauses without replacement or protection-workaround publication. Protected-default conversation capability is enforced server-side across runtime, file mutations and PR publication, serialized to the UI, and default-branch push remains hard-denied. Declared remaining Gate 3 work and Gates 4–6 were excluded; this is not Gate 3 acceptance.
