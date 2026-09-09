# ADR-034: Native Postgres sandbox ownership

**Status:** Accepted design; Gate 4 implementation in progress | **Date:** 2026-09-09 | **Tags:** tanstack, postgres, sandbox, chat

## Context

The accepted recovery plan Gate 4 and locked topology issue 08 require native TanStack `defineSandbox`, `SandboxInstanceStore`, and a Postgres `LockStore` to survive process restart and coordinate replicas. Existing instance lookup substitutes any live conversation row for a missing native key, and persistence overwrites a different key's row. Native Postgres tests reproduce attachment to the wrong revision and loss of the original provider/snapshot identity.

## Decision

- Native instance keys are exact identities. Missing means null; upsert replaces that key's full native record and clears omitted optionals. Different revision keys remain distinct even for one thread. The existing table remains the backing store; remove its obsolete per-conversation uniqueness and cross-key alias behavior.
- Implement TanStack's `LockStore` directly with tenant-scoped Postgres rows and expiring ownership tokens. Acquire, renew, and release each use short RLS transactions. The callback runs after commit. Abort the native lease signal when ownership cannot be guaranteed; native sandbox/run-driver consumers retain their own algorithms.
- Preserve ADR-027's ban on session advisory locks, held pool clients, or SQL transactions spanning provider IO. Its conversation-row uniqueness and check-only LockStore decision are superseded by the native key/lock contract.
- Provide the same instance store and lock adapter to prepare, stock chat, and focused ensured-handle commands. Bind ownership-loss cancellation to the native ensure/chat abort controller because native ensure does not consume its lock callback signal itself.
- Remove process-owned registries, definition/handle caches, terminal repair, and catch-and-empty behavior as Gate 4's callers switch. No ConversationSession or alternative lease facade is introduced.

- Store the captured immutable WorkspaceRevision beside the exact native record. Definition identity includes remote, connection, generation, SHA, default branch, access, and chat image identity. Revision changes allocate separately; credential values and their optional presence do not change workspace identity.
- Files and publication load this captured binding from Postgres. Missing tree/status/publish ownership is a conflict, not permission to clone a replacement. Focused provider cleanup acquires the native key lock and retains failed rows for retry.
- The OpenCode package translator must classify message parts by native message role. The temporary reproducible patch fixes a native exact-text regression without restoring application text heuristics. The same native package patch aborts its SSE subscription before session disposal awaits iterator return, fixing the native cancellation hang. A companion OpenCode SDK patch handles its asynchronous stream-reader cancellation rejection and stops subscription retries after intentional abort. Delete it once an upstream release passes the retained HTTP/two-turn and cancellation proofs. Active generation takeover is outside the accepted scope: ADR-030 retains native memoryStream for socket replay and native persisted messages for reload after process restart.

- Creation and destructive workspace/conversation deletion take the same workspace-scoped native Postgres lock before any per-instance key lock. This covers the window before a first handle is persisted. The instance-store admission check rejects a missing conversation/workspace under that lock. Each query remains short; no SQL connection spans provider I/O. Warm ensures for different conversations in a workspace serialize only during acquisition, not the model run.

- Native persistence must coordinate replacement of a thread transcript. A reproducible opt-in `withPersistence` package patch takes the native Postgres thread lock, rejects history changed while queued before a new model call, and releases via native terminal hooks. Terminal release distinguishes the already-settled caller abort from actual lease loss; only the former is ignored after persistence settles. Keep MessageStore replacement semantics unchanged. Remove the patch when the upstream package passes the retained concurrent-send/cancellation proof.

## Consequences

Native conformance and two-process crash/hand-off proof precede the caller switch. Multiple revision records can coexist for a thread; cleanup enumerates their actual native provider identities rather than hiding them behind an alias. Removing old uniqueness is not a complete concurrency fix until all callers use the Postgres native lock. No Gate 4 production checkpoint is complete before that wiring and proof.
