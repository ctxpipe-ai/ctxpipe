# ADR-029: Hosted MCP is the cross-client integration surface

**Status:** Accepted | **Date:** 2026-09-04 | **Tags:** mcp, interoperability, transport, distribution

## Context

ctx| is consumed by many agent and review tools. We can ship first-party
plugins for a few of them (Claude today; Cursor, Codex, or CodeRabbit later),
but we cannot build, review, and maintain a marketplace listing for every
client that should call `ctx_advisor`. Plugins improve discovery and install
UX. They are not a substitute for a working hosted endpoint.

`https://app.ctxpipe.ai/mcp` is therefore the vendor-neutral product boundary.
Clients paste that URL (optionally with `?orgSlug=`), complete OAuth, and
speak Streamable HTTP. If that handshake fails, the product is unavailable on
that client, regardless of how correct our protocol suite looks.

On 18 August 2026 we rejected authenticated `GET /mcp` with `405` to make
MCPJam protocol conformance 100/100. That was standards-valid: Streamable HTTP
says a server that does not offer a standalone SSE listener SHOULD return 405,
and a well-behaved client continues POST-only. The assumption was that real
clients would do the same.

They do not. CodeRabbit completes OAuth, `initialize`, and
`notifications/initialized`, then opens `GET /mcp` for the optional listening
stream. It treats our 405 as fatal, never reaches `tools/list`, and retries
the handshake in a loop. Cursor and Claude Code have had the same class of
bug in other servers. Conformance tested the spec, not the installed base.

Leaving the 405 in place would force a CodeRabbit-specific plugin or a
per-client workaround. That does not scale, and it hides a transport that
other clients will keep hitting.

Related: [ADR-026](ADR-026-claude-plugin-mcp-distribution.md) (Claude plugin
is one distribution path), [mcpjam research](../research/mcp-testing/mcpjam.md).

## Decision

1. **Hosted `/mcp` is the primary integration surface.** First-party plugins
   are supplemental. Do not treat a missing marketplace listing as a reason to
   leave a common client broken.
2. **Protocol conformance is the baseline, not the ceiling.** Where a widely
   used client diverges from the spec, and we can accommodate it without
   weakening authentication, tenant isolation, or JSON-RPC semantics, ctx|
   interoperate. Do not reject a safe request solely because the spec permits
   rejection.
3. **Accept authenticated `GET /mcp` as a standalone SSE listener.** Serve a
   cancellable `text/event-stream` with an immediate open signal and 10–15
   second keepalives. Apply the same keepalives to long POST response streams.
   Tool execution stays per-request / stateless. Do not add distributed session
   routing unless a client proves it cannot work without it.
4. **Keep the security boundary unchanged.** Origin checks, OAuth / API-key /
   cookie auth, organisation binding, and membership still run before the
   transport. This ADR does not relax tenant isolation.
5. **Prove behaviour with real client sequences.** MCPJam and the official
   conformance runner remain CI gates. They are not an interoperability claim.
   Regress the CodeRabbit handshake (initialize → initialized → GET SSE →
   `tools/list` → cancel) in-repo, and keep a documented smoke matrix for
   CodeRabbit, Cursor, Claude Code / claude.ai, MCPJam, and the Inspector.

## Consequences

- `@hono/mcp` is replaced by the official web-standard Streamable HTTP
  transport (`@modelcontextprotocol/sdk`), which already implements GET SSE
  and SSE keepalives.
- The August 2026 `GET 405` guard and its MCPJam-era rationale are superseded.
- Engineers must not reintroduce a blanket GET rejection to chase a
  conformance score. If a suite hangs on a long-lived GET, fix the test
  harness or document the gap; do not break clients to silence the suite.
- First-party plugins remain worthwhile for governed surfaces (Claude Tag).
  They must not become the compatibility strategy.

## Alternatives considered

- **Keep 405 and tell CodeRabbit to ignore it.** Rejected. We do not control
  their client, and other tools copy the same GET-after-initialize pattern.
- **Ship a CodeRabbit plugin instead of fixing `/mcp`.** Rejected as the
  default. Plugins do not scale to every review and agent product.
- **Stateful, shared MCP sessions across nodes.** Rejected until a client
  cannot complete `tools/list` on a per-request GET listener. A keepalive
  stream is enough for the current failure.
