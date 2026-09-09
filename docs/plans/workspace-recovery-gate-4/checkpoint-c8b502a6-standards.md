# Gate 4 narrow Standards review — `c8b502a6`

**Pinned range:** `0727d28440e0e6dd00756d6c7e62641b01f2ca87...c8b502a689df7113194b4c00de53519cc4667350`. Untracked provider work was excluded.

## Documented violations / blockers

**None (0).**

The correction closes the prior scheduling gap. Native persistence acquires `chat-thread:<threadId>` during setup, then `onConfig` loads the persisted transcript and validates the submitted prefix while that lease is held (`patches/@tanstack__ai-persistence@0.5.1.patch:35-119,189-241`). Canonical model→UI→model conversion removes display-only message identity and recursively stabilizes object keys while retaining nested content. A late stale request therefore fails before model execution or `MessageStore` replacement; a valid UI wire-format reload remains accepted. Lock release/error behavior is unchanged and continues through every native terminal hook, consistent with ADR-034.

Prompt-only internal calls now pass an empty message list so native persistence loads server-authoritative history before the trailing-user middleware appends the current prompt (`tanstack-workspace-chat.ts:328-358`). Explicit HTTP/WS message lists still undergo prefix validation.

`MessageStore.loadThread` restores `createdAt` as `Date` at the JSONB boundary (`workspace-chat-persistence.ts:64-91`), matching native converter expectations while HTTP reconstruction naturally serializes ISO strings. This keeps storage translation with the store owner and follows ADR-030's persisted-message reload design.

Committed evidence covers the late-stale red, stale rejection plus wire retry, grouped native chat/Postgres persistence, and corrected HTTP date assertion. Types record 132 acknowledged diagnostics and zero new. I inspected the evidence without running tests.

## Fowler heuristic judgments

No new heuristic finding. The previously retained nonblocking **Data Clumps** judgment is unchanged.

**Counts:** 0 blockers; 0 new heuristics; 1 retained nonblocking heuristic. Deferred Gate 4 work remains outside this verdict.
