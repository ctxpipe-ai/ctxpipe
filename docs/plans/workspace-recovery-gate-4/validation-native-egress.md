# Native Docker egress checkpoint

Gate 4 remains open. This checkpoint adds opt-in native enforcement and retained
proof; production chat has not yet activated the new image, resource profile and
egress policy together.

## Native boundary

The Docker provider creates an internal network for each agent and a trusted,
nonroot proxy connected to that network and the daemon's egress bridge. The
forward proxy binds only to its internal alias. Agent DNS and direct external
routing are unavailable; exact HTTP routes and HTTPS CONNECT authorities are
checked by the proxy, including metadata-address checks after DNS resolution.
The proxy connects to the validated address, strips hop-by-hop headers and bounds
connection establishment while allowing streaming responses.

Native MCP bridge creation admits its exact HTTP `/mcp` URL and bearer token
through a proxy-local Unix control socket. The token travels through Docker exec
stdin, not its arguments or URL. Close revokes access before shutting down the
listener. Published HTTP/SSE ingress separately requires a native per-channel
token; `SandboxChannel.close()` revokes it, and OpenCode disposal owns that close.
Both grants use ten-minute leases renewed by the owning provider every two
minutes. Revocation or expiry also terminates active forwarded requests.

The provider validates ownership labels, topology, image identities, runtime
policy and the proxy asset digest. New egress resource names incorporate SHA-256
of the deterministic key and full workspace identity, separating organization
ownership without renaming existing database records. The core's legacy FNV
keys remain unchanged. PostgreSQL exact-owner checks and atomic conditional
updates now reject collisions without renaming dirty worktrees; valid revision
transitions preserve their provider identity. Collisions remain an availability
limitation, and no cryptographic database-key migration is claimed.

Native teardown keeps the stopped agent as its durable retry reference until
the proxy and internal network are removed. It checks ownership and refuses
foreign network members before mutation.

A process killed after proxy allocation now recovers on retry. Before creating
a topology, the provider validates and removes only an incomplete topology with
matching ownership and generation, no live agent and no foreign endpoints.

Snapshot restoration now receives the existing deterministic native instance
key. Retrying the same restoration reuses the existing worktree. Resume returns
Docker's canonical container ID even when lookup used its name.

## Evidence

Retained public-interface cases are in
`sandbox-ownership-native.contract.test.ts`; existing OpenCode and callback
contracts verify the affected native lifetimes. No paid model requests were
needed. Raw logs and machine-specific fixture data remain in task-private work.

| Check | Result |
| --- | --- |
| Egress regression against old provider | Expected failure: network enforcement unavailable, 5.68 s |
| Snapshot replay against old provider | Expected failure: identical inputs allocated two containers, 32.30 s |
| Installed real-Docker egress case | Passed, 15.60 s: allowed model POST; denied other backend path, metadata and outside host; exact MCP bearer/path and revocation; blocked direct public IP; authenticated ingress and stale-token rejection |
| First combined run | Egress passed; restore reused the container but exposed name/ID inconsistency |
| Canonical-ID correction, restore-only rerun | Passed, 21.40 s; the modified restored file survived replay |
| Native OpenCode startup/completion and callback lifecycle | Five tests passed, 16.40 s |
| Crash after native proxy allocation, before fix | Expected HTTP 409 conflict, 5.65 s |
| Crash recovery after fix | Passed, 26.61 s; same identity recovers and native teardown leaves no owned containers or networks before fixture cleanup |
| Proxy deletion fails once, before fix | Expected failure, 13.98 s: retry leaves one owned proxy |
| Proxy deletion fails once, after fix | Passed, 13.06 s; retry from the original provider ID removes all owned resources |
| Network deletion fails once; restart and independent fork | Both passed, 51.20 s combined; parent and child retain independent edits, teardown removes both topologies and the intermediate image |
| Recovery-test backend typecheck | Passed, 124 existing allowances, no new/stale entries, 149.40 s; before the additional network/fork cases |
| PostgreSQL collision against old store | Expected failure, 6.12 s: another workspace could read the first owner's provider ID |
| Final PostgreSQL native conformance, collision and transition | Nine cases passed, 4.76 s; additional same-workspace/different-conversation collision passed, 10.68 s |
| Full backend typecheck | Passed, 124 existing allowances, no new/stale entries, 105.74 s |
| Full UI typecheck | Passed, 223 existing allowances, no new/stale entries, 112.42 s |

The bounded proxy smoke also passed static HTTP, dynamic admission/revocation,
mapped-IPv6 metadata denial and authenticated/revoked ingress. That smoke is
supporting evidence, not a substitute for the retained real-Docker contract.

## Still required

- Complete integrated deployment recovery and final ownership review.
- Activate the immutable chat image, fixed resource limits and per-workspace
  egress policy together; include the policy generation in application identity.
- Run integrated Docker chat through the real model broker, Git credentials and
  tools; complete credential renewal and provider acceptance.
- Full CI and the final cumulative Gate 4 reviews.


Final combined checkpoint verification passes: full backend typecheck retains
124 allowances (93.39 seconds), full UI retains 223 (116.47 seconds), and the
proof policy and exact CI partition pass. Two new callback-narrowing diagnostics
found by the first backend pass were corrected; no allowances were added.
The retained recovery file contains four cases, and PostgreSQL additionally
rejects same-workspace/different-conversation collisions. New raw evidence stays
in task-private work.
