---
name: preview-env-mcp
description: Hosted product MCP on the target origin: discovery, API keys, tools, ctx_advisor, and cross-tenant denial (preview-env).
disable-model-invocation: true
---

# preview-env mcp

`{BASE_URL}/mcp?orgSlug={orgSlug}`. The product MCP exposes **one** tool, `ctx_advisor` (a deprecated shim: one Workspace chat turn on the org's **first** Workspace per call, hidden from the UI list; the same `conversationId` resumes the thread, omitting it starts a new one). [Harness](../harness.md) is `PASS`. HTTP/CLI plus a short browser task. Flow format: [run-setup](../run-setup.md#flow-format). The onboarding MCP snippet URL is recorded in [ONB-4](../onboarding/SKILL.md).

### MCP-1 Discovery
**Requires** ONB-2.
**Steps**
1. `curl -sS -D - -o /tmp/preview-env-mcp-unauth.json -X POST "$BASE_URL/mcp?orgSlug=$orgSlug" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"preview-env","version":"0"}}}'`.
2. GET `{BASE_URL}/.well-known/oauth-protected-resource/mcp` and `{BASE_URL}/.well-known/oauth-authorization-server`.

**Expect (UI)** none.
**Expect (backend)** the unauthenticated POST is 401 (or 400 with a JSON-RPC auth error) with a `WWW-Authenticate` header naming `oauth-protected-resource`; both well-known URLs return JSON with issuer and resource metadata.
**Budget** 1 s / 3 s per request.
**Evidence** the response headers; `x-request-id`; trace.

### MCP-2 Doctor
**Requires** MCP-1.
**Steps**
1. `npx ctxpipe doctor mcp --url "$BASE_URL/mcp?orgSlug=$orgSlug"` (reachability and OAuth metadata only; it does not list tools).

**Expect (UI)** none.
**Expect (backend)** exit code 0 with reachable plus metadata; a connection error is a FAIL.
**Budget** 10 s / 30 s.
**Evidence** the command output.

### MCP-3 Mint and revoke an organization API key (#330, #336)
**Requires** ONB-2.
**Steps**
1. As A, open `/{orgSlug}/organization/api-keys`; **Create** a key named `preview-env {run-id}` with expiry 1 day (the dialog offers an organization/personal choice: pick organization).
2. Copy the secret shown once; close the dialog; confirm the key is listed without its secret.
3. Call `tools/list` ([MCP-4](#mcp-4-tools-list)) with `x-api-key`.
4. **Revoke** the key and confirm; repeat the call.

**Expect (UI)** the secret is displayed once; the list row shows the name and expiry; after revoke the row is gone.
**Expect (backend)** an `apikeys` row scoped to the org config; after revoke the same call returns 401; the secret never appears in a log or span (`ctxpipe.api_key.id` does).
**Budget** 3 s / 10 s per step.
**Evidence** `MCP-3-1.png`, `MCP-3-2.png`; the 401; trace with `ctxpipe.api_key.id`.

### MCP-4 tools/list
**Requires** MCP-3 step 2 (a live key). OAuth path: `SKIP(needs-human)` unless a human completes the OAuth client consent (`/.auth/consent`).
**Steps**
1. Initialize and `tools/list` on `POST /mcp?orgSlug={orgSlug}` with `x-api-key`.

**Expect (UI)** none.
**Expect (backend)** `tools/list` contains `ctx_advisor` and no other product tool; actor type in the trace is `org_api_key`.
**Budget** 2 s / 5 s.
**Evidence** the JSON-RPC result; trace.

### MCP-5 ctx_advisor answers through a Workspace chat turn
**Requires** MCP-4; HYD-1 (Workspace 1 is the org's first Workspace); hydrate ready.
**Steps**
1. `tools/call` `ctx_advisor` with a one-sentence prompt about a named file in the Workspace; keep the returned `conversationId`.
2. Call again with that `conversationId` and a follow-up.
3. Open the Workspace in the UI.

**Expect (UI)** the MCP conversation is **not** in the sidebar's conversation list.
**Expect (backend)** a `conversations` row for Workspace 1 whose `source` is not `ui`; a chat run executed in a sandbox; the second call reuses the thread; hosted: the sandbox is stopped as soon as each run ends (non-interactive runs hold no slot: check `workspace_sandbox_instances` within a minute, `needs-ticket-02`). Zero Workspaces: the tool returns the create-a-Workspace error (a FAIL here, since Workspace 1 exists).
**Budget** 15 s / 60 s per call (*uncertain*: includes sandbox start; no PRD target for MCP).
**Evidence** the tool result text; both calls' traces.

### MCP-6 Cross-tenant access is denied (#285)
**Requires** ONB-2; account C registered in its own context with its own org (repeat ONB-1 and ONB-2 for C, GitHub optional) and an API key in org C (MCP-3 steps for C).
**Steps**
1. With C's key, `POST /mcp?orgSlug={orgA}` (`tools/list`).
2. With C's session cookie, `GET /{orgA}/api/v1/workspaces`.
3. As C, open `{BASE_URL}/{orgA}/` and `{BASE_URL}/{orgA}/ws/{workspace1Slug}` in the browser.

**Expect (UI)** the page reads **You do not have access to this organisation** with **Go to home**; no Workspace name, conversation, or file of org A is shown.
**Expect (backend)** steps 1 and 2 are refused (401 or 403, never 200 with data); no row of org A is returned; the trace carries C's org, not A's.
**Budget** 3 s / 10 s per request.
**Evidence** `MCP-6-1.png`; the status codes; traces.

## Status

- **PASS** MCP-1 to MCP-6 `PASS` (MCP-4 OAuth path may `SKIP(needs-human)`).
- **FAIL** doctor or metadata down, `tools/list` missing `ctx_advisor` or listing extra tools, an advisor empty answer while a Workspace and models work, a revoked key still accepted, or any cross-tenant read.
- Device login (`npx ctxpipe auth login --base-url`) is optional setup auth, not MCP OAuth.
