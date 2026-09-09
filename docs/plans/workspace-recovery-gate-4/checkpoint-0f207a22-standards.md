# Gate 4 `0f207a22` — Standards review

Pinned range: `83465ae6f3e4536041a89ea71ef311c55607413f...0f207a22dfa54109b44db89d5e0321c2260ee9d2`. Gate 4 remains partial; this review does not assess the explicitly deferred active-run durability, warm-call budget, deletion/allocation race, or Railway work. No tests were run.

## Documented-standard violations / blockers

**None.**

The implemented ownership path follows ADR-034 and the surviving ADR-027 constraints. Native keys are exact; upsert clears omitted optionals and persists the captured `WorkspaceRevision` (`sandbox-instance-store.ts:29-59`, `workspace-sandboxes.ts:61-107`). Lock acquire/renew/release use separate short org-scoped transactions, while the callback runs outside SQL; owner-token and expiry predicates prevent a former owner from renewing or deleting a successor (`sandbox-lock-store.ts:17-108`). The `sandbox_locks` primary key makes `org_id` effectively non-null despite the generated `CREATE TABLE` spelling, matching the Drizzle schema.

Files/publication read persisted binding, use `ensureExisting` for tree/status/publish, and recheck revision/write authority around credential issuance and push. Cleanup locks the same native key, verifies provider disappearance, retains `destroy_failed` identity, and makes destructive HTTP paths fail closed. The package patch classifies parts by OpenCode message identity/role, including part-before-metadata ordering. Native PG/Git/HTTP/process replacements satisfy the backend real-infrastructure proof rule (`apps/backend/AGENTS.md:23`); the deletion ledger accounts for the retired mock suites.

## Nonblocking Fowler heuristics

1. **Speculative Generality:** heartbeat orchestration was removed, but `StreamInput.onHeartbeat` and `TanstackWorkspaceChatInput.onHeartbeat` remain forwarded and unread (`transport.ts:46,115`; `tanstack-workspace-chat.ts:95`). Legacy sandbox-ID helpers and the SSE parser are production exports used only by tests (`chat-runtime.ts:79-98`; `workspace-chat-agui.ts:98-109`). Remove the dead callback/helpers or move test parsing into the fixture.
2. **Data Clumps:** warm/prepare callers repeatedly assemble the same revision, credential, branch, conversation, and workspace fields (`conversation-files-routes.ts:328-370`; `conversations.ts:672-711`), while publication flattens a `WorkspaceRevision` into five optional primitives (`conversation-files.ts:45-64`; `conversation-publish.ts:35-66`). Carry one domain input/projection to reduce divergence.

**Counts:** 0 documented violations / 0 blockers; 2 nonblocking heuristic findings.
