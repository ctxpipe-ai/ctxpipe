# ADR-034: Native Postgres sandbox ownership

**Status:** Accepted | **Date:** 2026-09-09 | **Tags:** tanstack, postgres, sandbox, chat

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

- Native sandbox definitions receive the policy of the prepared workspace. Docker definitions resolve prebuilt agent/proxy images to immutable IDs and bind exact model/Git destinations per workspace; the local-process definition remains shared. A temporary reproducible native package extension accepts a runtime workspace on ensure, middleware and named snapshot operations. Immutable workspace identity participates in the existing instance/checkpoint hash; credential values remain excluded. Capture the effective workspace once and use it consistently for provider lifecycle, secrets, projection, snapshots and hooks. Runtime onReady context supplies the native ensured workspace; no mutable application definition registry is retained. Delete the patch when upstream passes the retained native isolation/rotation/snapshot/teardown proof. The accepted Gate 4 warm-path requirement and native design review authorize this extension; no application binding registry is added.

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

### Native intermediate fork ownership

The Docker provider owns low-level fork commit images independently of the
application's persisted base snapshots. A durable source-container label protects
an in-flight commit across processes. Teardown removes a child's image without
force; Docker retains images still used by another container or snapshot. Native
create/destroy collect labeled images after their source disappears. A lost
in-flight fork remains source-owned until that source is cleaned up. Explicit
snapshots clear the transient label. Failed startup removes its commit, and
unexpected teardown errors propagate instead of reporting successful cleanup.
No application image registry or timer is introduced.

### Native process environment and OpenCode ports

Docker create separates query parameters from the container JSON body, so
runtime credentials never enter the request URL. Docker exec inherits image and
container environment values; the provider supplies only explicit overrides.
This preserves the non-root home and tool paths of the prebuilt chat image.
Process wait registers transport completion at spawn time, surviving callers
that start waiting after readiness consumption and termination.

Local-process OpenCode binds port zero and the native adapter reads the complete
readiness URL before connecting. The OS owns allocation and the native adapter
owns process termination and exit observation. Kill/wait phases are bounded and
startup plus cleanup errors remain visible. The application no longer leases
ports or owns a second disposer. Docker retains its configured published port.

### Remote Docker and runner restart

Native Docker port channels derive their advertised host from the TCP daemon
connection, with an explicit host/origin override for separate routing. Docker
API TLS does not change the application channel's HTTP scheme. This stays in the
native provider and applies to resumed and forked handles.

Compose uses the quota-capable runner with persistent Btrfs storage and native
mutual TLS. Backend and worker receive only read-only client certificates; the
API is not host-published. Native init owns PID 1 while the storage wrapper owns
mount cleanup. Startup clears stale daemon PID files only under `/run/docker`,
leaving saved sandbox data and certificates intact. Real replacement and three
restart cycles prove native file persistence, authenticated reconnection and
published HTTP access. This infrastructure proof does not close remaining
integrated chat, egress and provider acceptance work.

Remote tool callbacks use one validated reachable backend-local interface.
Compose model traffic uses a separate stable relay at the nested default bridge
gateway, forwarding to the backend DNS name on each connection. The relay reads
its shared network namespace directly, has no Docker credentials or API socket,
and binds only that gateway so isolated agents cannot bypass their proxy. Native TanStack code retains
per-run bearer tokens and listener cleanup; no application run registry or
second tool-listener owner is added. Compose derives its current backend container IP and explicitly retains
the Bun startup command. Advertised-only NAT addresses are unsupported by this
exact-interface binding.

### Provider identity and required limits

An explicit provider lock remains authoritative. The application keeps sbx and
Docker identities distinct. The pinned sbx adapter cannot enforce the locked
writable-disk and PID limits, so it is ineligible for automatic selection. An
explicit sbx lock fails closed for chat and write allocation rather than silently
using Docker or local-process. Automatic selection ranks eligible providers.

### Native OpenCode stream ordering

The adapter waits for OpenCode's `server.connected` event before returning a
session. The generated SDK returns a lazy iterator, so awaiting `subscribe()`
alone does not establish the event connection. A blocking prompt's HTTP response
can also arrive before its SSE events. The native session therefore waits for the
exact assistant message's terminal update after forwarding that event, then lets
the stock adapter close its queue. This preserves text and intermediate tools.
The event waits are bounded and abortable; stream failure and disposal reject
waiters and release native process/subscription ownership. No application text
reconstruction or terminal-event repair is introduced.

### Native egress boundary (opt-in; production activation pending)

A protected Docker sandbox will belong only to its own internal network. A
trusted, unprivileged proxy owns allowed outbound HTTP/CONNECT and narrow reverse
HTTP ingress; the agent has no direct external network or DNS path. The native
provider owns the agent, proxy and network through deterministic allocation
identity and Docker labels, including validation, recovery and teardown. No
application sandbox/proxy registry is added. The existing quota-capable runner
remains the resource boundary; this topology alone does not enforce disk limits.

Per-run MCP ports must be admitted exactly after the native bridge chooses its
URL, using the ensured handle. An optional native handle admission capability
receives that URL and its per-run token and returns a revoker. Bridge close owns
revocation as well as listener closure; failed admission closes the listener and
fails the turn. Dynamic grants are ephemeral and disappear on proxy restart.
Published HTTP/SSE ingress uses a separate native per-channel token and revoker;
OpenCode server disposal owns that channel. Both bridge and ingress admissions
have ten-minute renewable leases and abort active requests on revocation. The
forward listener binds only to the internal network. Native ownership validation
includes the proxy asset digest and resolved image identities. Resource names
use a stronger workspace-scoped ownership digest while existing database keys
remain unchanged.

The first real-Docker access/revocation and deterministic restore proofs pass.
Partial-creation crash recovery, retry after proxy/network deletion failures,
and independent worktree restart/fork now pass retained real-Docker contracts.
Teardown retains the agent container as a durable retry reference until its
proxy and network have been removed. Production activation and integrated chat
remain required. No application proxy registry is added.


### Collision isolation without orphaning legacy worktrees

The native core's existing FNV keys remain unchanged. The PostgreSQL adapter
validates organization, workspace, conversation (or shared base), provider,
image and revision before returning an exact record. Native chat upserts use
an atomic conditional conflict update with the same owner tuple; a collision
fails closed rather than overwriting the existing owner. Conditional deletion
preserves that boundary. Other writer/job persistence semantics are unchanged.

Transition lookup is conversation-scoped and validates provider/image while
allowing the previous revision; the desired-revision fence and stable owner
predicates govern the move. Provider IDs and existing dirty worktrees survive
legitimate moves. Native Docker labels retain their creation identity, so
current revision keys must not be substituted for that identity during resume.
The application supplies provider IDs only after its ownership checks. A true
hash collision remains an availability limitation, not permission to resume or
overwrite another owner's worktree. No blanket key migration is introduced.

### Production Docker policy activation

Deployment initializes the pinned Node proxy image and builds the chat image
before backend readiness. Request handling only inspects these images, never
builds or installs tools. Each prepared Docker definition uses immutable image
IDs, the fixed 1 CPU / 1 GiB / 128 PID / 4 GiB nonroot policy, exact model paths,
and GitHub plus the workspace Git host. Policy identity participates in both
exact and transition workspace identity; tokens and ordinary SHA transitions do
not change it. Separate tenants never share an accumulated allowed-host list.
Container OpenCode configuration uses the image user's writable home and fixed
container PATH, avoiding backend-host temporary directories and executable paths.

Focused activation checks and the credential-free relay replacement proof pass.
The complete Docker chat journey and remaining Gate 4 acceptance are still open.

### Mid-run model and Git authorization

An active chat uses separate signed model and Git capabilities bound to the
actual owner of TanStack's existing PostgreSQL transcript lock. The lock adapter
supplies an acquisition receipt to the calling run; minting requires that exact
owner rather than adopting whichever row is currently live. Brokers verify the
signature, purpose, live owner, conversation, and current workspace binding in
one joined tenant query. Native renew/release and crash expiry govern capability
lifetime; there is no second lease table, timer, or process registry.

After native sandbox setup and before OpenCode starts, the application injects
these capabilities with the native handle's environment API. Docker creation
secrets omit the legacy timed model token, so PID 1 cannot retain a credential
that bypasses native run revocation. Bootstrap cloning retains its independent
repository read credential. Trusted unsandboxed compatibility keeps the existing
prepare token.

The prebuilt image installs a fixed Git credential helper and a GitHub CLI
wrapper. Each invocation asks the exact broker endpoint for a short-lived
installation token. Scope is the workspace repository and linked GitHub remotes
recorded for the same connection, limited to 500 repositories and read-only
contents/issues/pull-requests/metadata permissions. The broker checks issuer
expiry independently of Octokit's cache and refreshes within the last minute.
It revalidates both native run authority and the complete allowed repository set
after GitHub IO. Tokens are returned with no-store and never written by the
helper to files; the wrapper passes GH_TOKEN only to its CLI child. Neither App
private keys nor model-provider keys enter the sandbox.

### Native snapshot and detached cleanup anchors

After bootstrap, native instance persistence precedes snapshot IO. A failed
snapshot retains an initialized instance that a later ensure can resume and
snapshot; a lost Docker commit acknowledgement is recovered only when the
requested tag resolves to a newly published image. Cleanup errors remain visible.

For isolated Docker handles, the native proxy receives a name derived from the
canonical agent container ID after allocation. This preserves a provider-owned
cleanup anchor when the agent is removed externally. Detached destruction checks
the proxy and network ownership labels, isolation boundary and endpoint set,
then removes the network before the proxy. Partial failures retain the proxy for
retry. Existing live handles and partial allocations remain discoverable through
the native owner/generation labels; no application process registry is added.

Proxy HTTP deadlines bound connection establishment. Valid prompt/model requests
may wait longer for response headers; caller disconnect and native grant
revocation still terminate their connections.
