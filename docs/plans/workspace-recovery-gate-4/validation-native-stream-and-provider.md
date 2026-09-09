# Native stream and provider checkpoint

Gate 4 remains in progress. The remote Docker/TLS checkpoint is bc1afa24. Its
push-triggered CI job was skipped by the workflow's actor/event rules; full CI
will be explicitly dispatched on this combined fix checkpoint.

## Reproduced CI defects

All three writer recovery failures came from a two-second Docker Modem
`connectionTimeout` that remained active while a request awaited its response.
A native delayed stop failed with `socket hang up` at 2,014 ms. Removing that
option retains the 30-second request deadline and workflow abort signals. The
create-replay test then passed in 7.8 seconds; the two process-loss cases passed
in 331.45 seconds. Tests now preserve the original body failure alongside cleanup
errors and include bounded, credential-free daemon/owned-container diagnostics.

The native OpenCode session had two independent ordering races. `subscribe()`
returned before its lazy SSE connection opened. Separately, the prompt HTTP
response could complete before queued text and tool events reached the client.
A real OpenCode server and gated HTTP proxy reproduced both. The retained tests
separate startup and completion; both failed against the old adapter. The native
fix waits for `server.connected`, and for the exact final assistant SSE update
before allowing the stock adapter to end its queue. Native state owns bounded
waits, abort, error propagation and disposal. No app-level transcript repair is
added. All three native port/startup/completion tests pass in 9.10 seconds. The two
previously failing chat cases plus native cancellation also pass (57.55 seconds).

## Provider identity

Explicit sbx selection stays sbx instead of silently selecting ordinary Docker.
The pinned sbx adapter lacks disk/PID enforcement and is ineligible for automatic
selection. An explicit sbx lock returns 503 without allocation or model calls.
Eligible automatic Docker preparation, reuse and revision advancement still
pass. A bounded review corrected the initial proposal to select an unsupported
sbx adapter ahead of an eligible Docker provider.

The final full backend typecheck passes with 124 existing allowances and no
new/stale entries (90.89 seconds). UI passes with 223 allowances (107.13 seconds).
No allowance was added. Formatting and proof-policy checks pass; the CI inventory
remains 189 default backend files plus 44 contracts, without overlap or omission.

## Remaining acceptance

The isolated egress topology proof succeeded, including direct-network/DNS and
metadata denials, allowed Git/HTTP proxy traffic, reverse HTTP ingress and proxy
restart. It is not production wiring: native provider network/proxy ownership,
exact per-run bridge admission, the production resource/image switch and
integrated chat still need implementation. Railway support/live proof and the
final Gate 4 audits also remain open. Private raw logs and fixture identifiers
remain in the task work directory.
