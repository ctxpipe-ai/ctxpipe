# Gate 4 narrow Standards review — `75610653`

**Pinned range:** `21912ff7839bf69e0ceea08a3d72c946de2eaa98...7561065326b97627c92be467b484359187a689f1`. I reviewed the changed production paths, direct deletion callers, native fixtures, ADR-034, and committed evidence. Deferred Gate 4 items were excluded.

## Documented violations / blockers

**None (0).**

The concurrency boundary matches ADR-034's lock hierarchy. Both prepare and chat obtain `workspace-sandboxes:<workspaceId>` before TanStack's instance key (`tanstack-workspace-chat.ts:238-252,346-354`). Conversation and workspace deletion take the same outer lease before enumerating rows, then destroy each exact persisted identity under its instance-key lease before executing the database delete (`workspace-sandbox-cleanup.ts:17-67,78-127`). This prevents the pre-persistence allocation window without holding a SQL connection across provider I/O. Lock acquisition, renewal, release, and the instance admission query remain separate short org-scoped transactions, satisfying `apps/backend/AGENTS.md:11` and ADR-034 (`sandbox-lock-store.ts:11-119`; `sandbox-instance-store.ts:33-88`). Ownership loss propagates through the shared abort controller.

Instance admission joins conversation to its workspace and organization before native lookup (`sandbox-instance-store.ts:41-70`). A deletion that wins therefore rejects later provider creation; an allocation that wins remains visible to cleanup before the row delete. The route callers perform their destructive database operation inside this boundary (`routes/v1/conversations.ts:566-604`; `routes/v1/workspaces.ts:424-465`).

The new WebSocket fixture exercises production handlers, native offset replay without another model call, one terminal event, and transcript reconstruction in a fresh Bun process. The allocation race uses real Postgres/native ensure and the HTTP DELETE path. This meets the repository's real-infrastructure proof rule (`apps/backend/AGENTS.md:23`). Removing catch-and-empty persistence reads also makes storage failure observable.

Committed evidence records 34/34 focused native cases and 132 acknowledged type diagnostics with zero new diagnostics. I did not rerun tests.

## Fowler heuristic judgments

No new heuristic finding. The previously retained, nonblocking **Data Clumps** judgment is unchanged by this delta.

**Counts:** 0 blockers; 0 new heuristics; 1 retained nonblocking heuristic. This is an intermediate Gate 4 checkpoint.
