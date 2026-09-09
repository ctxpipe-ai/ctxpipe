# Standards review — owner correction plus permission follow-up

Scope: the working repository delta after `39aa42a7`, excluding the unfinished replica contract and separate `/private/tmp` base work. No code edits or tests were performed.

## Documented violations / blockers

**None (0).** The follow-up closes the cold-fallback permission gap. Per-turn middleware requires stock `SandboxCapability` and captures `getSandbox(ctx)` (`tanstack-workspace-chat.ts:399-405`); commit classification alone reads the live Git branch (`chat-sandbox-policy.ts:223-259`). A detached/default checkout therefore cannot inherit permission from stale persisted metadata. This adds no registry, second ensure, or provider ownership path and remains consistent with ADR-034.

The UI branch label and link now use the existing status projection only (`WorkspaceChatSession.tsx:339-351`), so a deleted remote session branch is not presented from stale conversation metadata.

Supplied evidence: cold-fallback RED→GREEN and stock two-turn chat passed; not rerun here.

## Fowler heuristics

No new heuristic (0). Previously recorded nonblocking **Data Clumps** remains unchanged.
