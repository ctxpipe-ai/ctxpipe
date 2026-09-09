# Gate 4 narrow Standards review — `f185020b`

**Pinned range:** `0f207a22dfa54109b44db89d5e0321c2260ee9d2...f185020b5b9d7835d588b09c12515088bbb99e79`. This review covers the correction delta and direct callers only. Deferred Gate 4 work remains outside this checkpoint.

## Documented violations / blockers

**None (0).**

The corrected lifecycle follows the native-ownership design and the backend proof rule (`apps/backend/AGENTS.md:23`): setup checks out the captured SHA or fails (`chat-runtime.ts:34-44`); publication's final binding check includes that SHA before remote mutation (`conversation-publish.ts:122-145`); and sandbox selection prefers the exact binding and SHA regardless of another row's later heartbeat (`conversation-files.ts:46-78`). The route obtains the desired revision before selecting the stored binding (`conversation-files-routes.ts:546-565`), so planning and native resume share one explicit subject.

The static catalogue performs no tenant read while constructing a turn. On invocation it validates server-supplied scope, obtains one RLS-scoped published snapshot, rejects an unavailable projection, and only then creates the bound implementation (`workspace-chat-tools.ts:609-648`; `tanstack-workspace-chat.ts:319-336`). The database callback contains only the projection read; embedding and search run after it, consistent with the backend short-transaction ownership rule (`apps/backend/AGENTS.md:11`).

Recorded native evidence covers 29/29 revision/setup/publication cases and 8/8 chat/tool cases; I inspected the committed evidence and did not rerun tests.

## Fowler heuristic judgments

The earlier **Speculative Generality** cases are closed: production no longer contains the unused heartbeat callback, sandbox-key helpers, or test-only SSE parser.

One previously recorded, nonblocking **Data Clumps** judgment remains: chat preparation and publication still pass the revision/credential/binding components as broad property bags (`tanstack-workspace-chat.ts:73-98`; `conversation-publish.ts:35-41`). A focused domain input could reduce pairing risk, but this correction neither worsens nor needs to resolve it.

**Counts:** 0 blockers; 0 new heuristics; 1 retained nonblocking heuristic. This is not Gate 4 acceptance.
