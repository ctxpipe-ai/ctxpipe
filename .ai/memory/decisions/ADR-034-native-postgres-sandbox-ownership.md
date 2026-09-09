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

- Store the captured immutable WorkspaceRevision beside the exact native record. Definition identity includes remote, connection, generation, SHA, default branch, access, and chat image identity. Exact revision keys remain distinct; a compatible live thread may move atomically between them as described below. Credential values and their optional presence do not change workspace identity.
- Files and publication load this captured binding from Postgres. Missing tree/status/publish ownership is a conflict, not permission to clone a replacement. Focused provider cleanup acquires the native key lock and retains failed rows for retry.
- The OpenCode package translator must classify message parts by native message role. The temporary reproducible patch fixes a native exact-text regression without restoring application text heuristics. The same native package patch aborts its SSE subscription before session disposal awaits iterator return, fixing the native cancellation hang. A companion OpenCode SDK patch handles its asynchronous stream-reader cancellation rejection and stops subscription retries after intentional abort. Delete it once an upstream release passes the retained HTTP/two-turn and cancellation proofs. Active generation takeover is outside the accepted scope: ADR-030 retains native memoryStream for socket replay and native persisted messages for reload after process restart.

- Creation and destructive workspace/conversation deletion take the same workspace-scoped native Postgres lock before any per-instance key lock. This covers the window before a first handle is persisted. The instance-store admission check rejects a missing conversation/workspace under that lock. Each query remains short; no SQL connection spans provider I/O. Warm ensures for different conversations in a workspace serialize only during acquisition, not the model run.

- Native persistence must coordinate replacement of a thread transcript. A reproducible opt-in `withPersistence` package patch takes the native Postgres thread lock, validates submitted history against persisted messages under that lock before a new model call, and releases via native terminal hooks. Terminal release distinguishes the already-settled caller abort from actual lease loss; only the former is ignored after persistence settles. Keep MessageStore replacement semantics unchanged. Remove the patch when the upstream package passes the retained concurrent-send/cancellation proof.

- Native sandbox definitions are static per provider. A temporary reproducible native package extension accepts a runtime workspace on ensure, middleware and named snapshot operations. Immutable workspace identity participates in the existing instance/checkpoint hash; credential values remain excluded. Capture the effective workspace once and use it consistently for provider lifecycle, secrets, projection, snapshots and hooks. Runtime onReady context replaces per-request closure state. Delete the patch when upstream passes the retained native isolation/rotation/snapshot/teardown proof. The accepted Gate 4 warm-path requirement and native design review authorize this extension; no application binding registry is added.

- Opt-in native workspace transitions preserve live conversation work when only SHA advances (issue 14). A stable compatibility identity includes tenant, workspace, generation, connection, remote, default branch and image; native provider/thread scoping completes the transition key. Native ensure takes one stable workspace lock, resumes the prior exact live record, invokes the Git transition hook, and atomically moves the persisted record only after success. `get(key)` remains exact. Transition discovery rejects pre-upgrade live rows without compatibility metadata, identifying the retained native/provider owner rather than guessing an old configuration or allocating over saved work. Failed transitions retain the original record and recoverable edits. A repair turn resolves that old revision before stock native middleware captures its exact key, projection and checkpoint state; publication still checks the desired revision. Native persistence holds the transcript lock during that resolution. Missing providers use a new current base fork; successful moves clear the previous base pointer. The Git hook checks the current Workspace target before mutation; the final move checks that same binding and SHA inside a short transaction with a Workspace row share lock. A superseded target leaves the old owner and completed Git marker for the next current-target request to reconcile. Generation/remote/image changes never qualify. The existing workspace deletion fence surrounds the native lock without nesting that fence.
- Native credential-free base snapshots contain the captured Git commit and reusable setup. Per-thread setup and credentials run after restoration. Snapshot cleanup serializes owners and deletes an image only after its last persisted owner is removed. Persist the configured sandbox image beside native ownership. The existing periodic workspace cleanup collects changed-image, superseded or idle base records only after their thread forks release that snapshot; current active forks keep their base owner. Source Git authentication resolves native SecretRefs for clone/fetch without placing credentials in the workspace identity or base environment.

- Git transition phases are recorded atomically inside the worktree Git directory, with uniquely named recovery stashes. A process lost after Git succeeds but before the native record move resumes the completed phase. Interrupted or conflicted rebases remain accessible through the old exact revision; do not replay a partially applied stash automatically. Conflicting default-branch edits yield to the new tip with their full stash retained. Published branch conflicts retain their commits and remain publication-blocked. Files status and the repair agent receive both effective and desired SHAs. Files and push routes hold the native transcript lock through ensure and their complete operation. Request abort and native lease loss share the operation controller; existing handle adapters forward it through native process and filesystem operations. A temporary native Fs extension accepts optional signals for read/write/mkdir/remove; Docker cancels each command/chunk and awaits process termination, and local-process forwards cancellable filesystem calls or uses its existing cancellable command path. Remove these patches when upstream preserves the native cancellation proof. An ancestor target alone is not replay evidence: an initial rewind rebases, while only a matching completed marker permits replay.

## Consequences

### Native Docker resource enforcement

The locked small-pod limits are enforced in the native Docker provider, including
resume, snapshot restoration and forks. A configured isolation policy requires a
non-root user, CPU/memory/PID caps, a per-container storage quota, no capabilities
or extra mounts, no privilege escalation, and disabled container logs. Existing
containers that fail inspection are rejected before restart; an unsupported
daemon must fail rather than silently omit a limit.

The locked Compose DinD topology uses Docker's Btrfs storage driver for quotas.
The infrastructure runner owns a persistent sparse filesystem and takes an
exclusive volume lock. It never reformats existing data and fails startup if
quota support is absent. Native Docker commits and forks remain the snapshot
mechanism. This avoids an application filesystem/snapshot implementation. Btrfs
referenced-byte accounting is stricter than a writable-layer-only cap. The runner
requires aggregate disk monitoring; its privileged infrastructure container is
never an agent sandbox. TLS remains the runner default. Resource-contract work
does not complete the separate egress, production-image or provider wiring work.

Native conformance and two-process crash/hand-off proof precede the caller switch. Multiple revision records can coexist for a thread; cleanup enumerates their actual native provider identities rather than hiding them behind an alias. Removing old uniqueness is not a complete concurrency fix until all callers use the Postgres native lock. No Gate 4 production checkpoint is complete before that wiring and proof.
