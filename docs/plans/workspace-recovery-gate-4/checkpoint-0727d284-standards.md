# Gate 4 narrow Standards review — `0727d284`

**Pinned range:** `f98a41b93b0efec4b15f9297db696d11e2e25c09...0727d28440e0e6dd00756d6c7e62641b01f2ca87`. I reviewed production wiring, all three dependency patches, their lock/error paths, four native cases, ADR-030/034, and committed evidence. Deferred G4-C/E work was excluded.

## Documented violations / blockers

**None (0).**

Production supplies the existing org-scoped Postgres `LockStore` directly to native `withPersistence` (`tanstack-workspace-chat.ts:321-355`), preserving ADR-030's stock TanStack loop. The opt-in persistence patch reads history before queuing, acquires `chat-thread:<threadId>`, rechecks under the lease before model execution, and releases from `onFinish`, `onError`, and `onAbort` (`patches/@tanstack__ai-persistence@0.5.1.patch:162-208,223-305,308-380`). It leaves `MessageStore` replacement ownership in persistence. A stale queued send is rejected before the model and cannot overwrite the accepted transcript. The native Postgres lock still uses short RLS transactions, so no SQL connection spans model/provider I/O, consistent with ADR-034 and `apps/backend/AGENTS.md:11`.

Terminal release suppresses only the matching caller-abort rejection after persistence settles; the explicit `ownershipLost` path still propagates lease failure. OpenCode now aborts its SSE subscription before awaiting iterator return, while the SDK handles asynchronous reader cancellation and stops retrying an intentionally aborted subscription. The OpenCode patch updates shipped source and ESM output; the SDK ships generated output only. All patches are pinned to exact package versions in `pnpm-workspace.yaml`, have frozen-install evidence, and ADR-034 states their retained proofs and deletion condition.

The four native cases use production HTTP/chat/OpenCode/Postgres paths. They prove two-turn replacement, one accepted concurrent send plus reload/retry, WebSocket reconstruction without durability errors, and cancellation followed by a successful turn (`workspace-chat-native.contract.test.ts:20-355`). This satisfies the real-infrastructure proof rule in `apps/backend/AGENTS.md:23`. Recorded evidence is 4/4, with 132 acknowledged type diagnostics and zero new; I did not rerun tests.

## Fowler heuristic judgments

No new heuristic finding. The previously retained nonblocking **Data Clumps** judgment is unchanged.

**Counts:** 0 blockers; 0 new heuristics; 1 retained nonblocking heuristic. This is not Gate 4 acceptance.
