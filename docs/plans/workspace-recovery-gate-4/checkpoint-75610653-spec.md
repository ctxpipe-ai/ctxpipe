# Gate 4 Spec review — `75610653`

## Findings

No blocking Spec findings in this bounded milestone.

The deletion fence preserves the native contract and closes the reproduced pre-persistence window. Both prepare and chat wrap TanStack’s per-instance `sandbox:${key}` acquisition with `workspace-sandboxes:${workspaceId}`. The adapter composes those locks in one order—workspace, then instance—and shares cancellation across both leases (`sandbox-lock-store.ts:12-23`). Conversation and workspace deletion acquire the same outer key before enumerating/destroying instances and hold it through the database deletion (`workspace-sandbox-cleanup.ts:78-126`). I found no affected production path that takes these locks in reverse order. Each lease still uses short RLS transactions; provider I/O occurs after acquisition without a held SQL connection.

The instance store validates that the conversation still belongs to the captured workspace before returning either an existing record or `null` (`sandbox-instance-store.ts:33-65`). Because native creation/upsert remains inside the outer lease, deletion cannot enter between this admission check and first persistence. A waiter after deletion fails before provider creation. Cleanup keeps its existing inner-key lock and failed-destroy retry behavior.

The native WebSocket proof uses the production Bun handlers and `memoryStream`: it completes one real OpenCode turn, reconnects with a native offset, verifies exact suffix replay and no second model request, then invokes `reconstructChat` in a fresh Bun process against Postgres. This matches the accepted ADR-030 boundary; removing the unsupported active-takeover test avoids adding the expressly rejected journal/attach lifecycle. Persistence read failures now propagate from both transcript hydration and stored-turn detection instead of becoming empty history, as required by `workspace-chat-recovery.md:335-346`.

Warm definition/GitHub removal, workspace base snapshots/forks, active-disconnect coverage, simultaneous sends, final workspace-deletion/active-run cleanup proof, and Railway remain the declared Gate 4 remainder and were not treated as milestone regressions.
