# MCPJam for ctxpipe MCP diagnostics

Date: 2026-08-18

## Decision

Use MCPJam as an external development and test client. It must not become a
product runtime dependency, proxy, sidecar, or second MCP server.

- Keep the official MCP Inspector and conformance runner as independent
  standards references.
- Use the local MCPJam Inspector for interactive OAuth and JSON-RPC diagnosis.
- Use the version-pinned MCPJam CLI for deterministic probes and protocol
  checks.
- Keep OAuth conformance manual until ctxpipe has a dedicated non-interactive
  test identity or machine grant.
- Defer hosted LLM evals until deterministic transport and auth checks are
  stable.

## Verified capabilities

As researched on 2026-08-18:

- `@mcpjam/inspector` 2.40.0 supports local HTTP/S and Streamable HTTP, visual
  JSON-RPC logs, DCR/pre-registered/CIMD OAuth debugging, and persisted redacted
  OAuth traces.
- `@mcpjam/cli` 3.24.0 provides `server doctor`, OAuth login/conformance,
  protocol conformance, direct tool calls, JSON/JUnit output, and exit codes
  suitable for automation.
- `@mcpjam/sdk` 5.0.0 provides programmable clients and evals, but ctxpipe does
  not need it for the initial diagnostic layer.
- The hosted application accepts public HTTPS endpoints only. It cannot reach
  `*.localhost` or refresh against a local authorisation server.
- MCPJam does not provide a dedicated assertion suite for refresh-token races,
  dropped-session recovery, reconnect semantics, or client concurrency. Those
  remain ctxpipe-owned tests.

## Constraints and caveats

- ctxpipe's endpoint is `/mcp?orgSlug=<slug>`. The protected-resource audience
  intentionally canonicalises to `/mcp` without the query string.
- Portless browser trust does not guarantee that a separate Node.js CLI trusts
  its CA. Supply `NODE_EXTRA_CA_CERTS` rather than disabling TLS verification.
- Do not commit OAuth credentials or debug artefacts. Local output belongs
  under the gitignored `.mcpjam/` directory.
- Do not gate CI on interactive OAuth, `@latest`, browser UI behaviour, or
  probabilistic LLM evals.
- MCPJam has had client-side OAuth defects, including resource-indicator
  rewriting fixed in July 2026. Triangulate failures with the official runner
  and server logs before attributing them to ctxpipe.

## Initial ctxpipe findings

The first full protocol run scored 79/100 and identified three transport
defects in the production path:

1. Local endpoints accepted a hostile `Host`/`Origin` instead of returning 403.
2. Stateless `GET /mcp` opened an SSE stream which could not deliver server
   messages and caused client timeouts.
3. Notification-only POSTs returned status 202 with a JSON `null` body instead
   of an empty body.

The shared transport boundary now validates origins before authentication,
returns 405 for stateless GET, and normalises notification responses to an empty
202. The same MCPJam 3.24.0 suite then passed 15/15 applicable checks with a
score of 100/100 against protocol version 2025-11-25.

## Primary sources

- [MCPJam repository](https://github.com/MCPJam/inspector)
- [Installation and configuration](https://docs.mcpjam.com/installation)
- [Connecting Streamable HTTP servers](https://docs.mcpjam.com/inspector/connecting-servers)
- [OAuth Debugger](https://docs.mcpjam.com/inspector/guided-oauth)
- [CLI overview](https://docs.mcpjam.com/cli/overview)
- [Server doctor](https://docs.mcpjam.com/cli/server-inspection)
- [OAuth login](https://docs.mcpjam.com/cli/oauth-login)
- [OAuth conformance](https://docs.mcpjam.com/cli/oauth-conformance)
- [CI guidance](https://docs.mcpjam.com/cli/ci)
- [Protocol-version support](https://docs.mcpjam.com/inspector/protocol-versions)
- [Resource-indicator bug fixed](https://github.com/MCPJam/inspector/issues/2119)
