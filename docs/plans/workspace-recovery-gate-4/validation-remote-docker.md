# Remote Docker connectivity checkpoint

Gate 4 remains in progress. The native adapter now advertises published ports on
its TCP daemon host; socket and SSH transports retain the local default. An
explicit `advertisedPortHost` accepts a host or HTTP(S) origin and rejects
credentials, paths, queries and fragments. Docker API TLS does not imply TLS for
the application running in the container. Create, resume and forked handles use
the same native port configuration.

A separate trusted client container reproduced the old adapter returning
`localhost` for a remote DinD sandbox. With the patch installed, that client
started the non-root chat image through the native provider, reached OpenCode
1.18.18 at the advertised DinD host, checked `/global/health`, disposed the server
and verified the endpoint was unreachable. No real model credentials were used.

The retained `connects to native Docker published ports through the public
channel` contract verifies the default TCP host and an explicit override using
real native handles and real HTTP requests. The Alpine fixture uses its available
netcat applet; it does not assume that BusyBox includes `httpd`. It passed in
13.35 seconds. The full backend typecheck passed with 125 acknowledged diagnostics
and no new/stale entries in 107.58 seconds. The public package source, declarations
and installed output passed a bounded independent review.

Compose now uses the quota-capable runner, named Btrfs storage,
and native mutual TLS. Only backend and worker receive read-only client
certificates; the daemon API is not host-published. A disposable Compose project proved persisted native sandbox recovery after
runner replacement, followed by three successful restart cycles. Each cycle
verified Btrfs storage, the saved file, mutual TLS, refusal of plaintext and
clients without a certificate, the native published HTTP channel, and teardown.

Early repeated restart exposed stale containerd PID files and incorrect init
ownership. The runner now starts under native `docker-init` and clears only
ephemeral daemon PID files under `/run/docker`. Saved images, sandbox files and
certificates remain intact. The three passing cycles include this fix; initial
fixture failures and the reproduced startup failure are not passing evidence.

The callback adapter shares one validated backend-interface address between the
model proxy and TanStack's native tool-bridge provisioner. TanStack retains the
per-run bearer token and server-close lifecycle. A real nested Alpine sandbox
received 401 without the bearer, returned the exact authorized tool result, and
could no longer reach the bridge after close. Five focused callback/model tests
passed. Nonlocal advertised-only addresses are unsupported: the configured host
must resolve to a local backend interface reachable by the sandbox.

Compose derives this backend container's single IP unless explicitly configured,
and retains an explicit Bun server command alongside its wrapper entrypoint.
A real Compose fixture checked address export and command execution. Its initial
missing-command regression was fixed; a direct-Docker harness that misinterpreted
Compose dollar escaping was replaced with actual Compose execution.

The combined UI typecheck passed with 223 allowances (190.60 seconds). The backend
check exposed an existing environment fixture's unsafe cast after the optional
callback setting changed its diagnostic text. That fixture now uses `parseEnv`;
all 12 affected proxy tests pass (1.84 seconds), and the final full backend check
passes with 124 allowances and no new/stale entries (114.29 seconds). No allowance
was added. Test policy checks 430 tracked files and 28 commands; the CI inventory
contains 189 default backend files and 44 contracts, with no overlap or omission.

Production image/security activation, egress enforcement, integrated Docker chat
and Railway conformance/live proof remain open. Raw logs, fixture scripts and local
container/image identifiers remain in the task's private work directory.

The preceding checkpoint's full CI run 34327385395 completed while this batch was
being verified. Its native resource/quota contract passes; five other contract
failures remain under targeted investigation (see the acceptance ledger). The
local targeted chat rerun passes but does not close the CI streaming failure.
