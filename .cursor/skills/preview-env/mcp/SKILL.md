---
name: preview-env-mcp
description: Hosted product MCP on the target origin: discovery, API keys, the seven read tools, and cross-tenant denial (preview-env).
disable-model-invocation: true
---

# preview-env mcp

`{BASE_URL}/mcp`. The product MCP exposes **seven** read tools ([ADR-051](../../../../.ai/memory/decisions/ADR-051-mcp-read-surface.md)): `list_workspaces`, `search_knowledge`, `search_code`, `find_symbol`, `read_file`, `list_files`, and `get_related`, plus the resource template `ctxpipe://{org}/{workspace}/{+ref}`. Each tool except `list_workspaces` needs an `org` slug argument. The server ignores `?orgSlug=`. No tool runs a model or a chat turn. `ctx_advisor` is gone. [Harness](../harness.md) is `PASS`. HTTP/CLI plus a short browser task. Flow format: [run-setup](../run-setup.md#flow-format). The onboarding MCP snippet URL is recorded in [ONB-4](../onboarding/SKILL.md).

### MCP-1 Discovery
**Requires** ONB-2.
**Steps**
1. `curl -sS -D - -o /tmp/preview-env-mcp-unauth.json -X POST "$BASE_URL/mcp" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"preview-env","version":"0"}}}'`.
2. GET `{BASE_URL}/.well-known/oauth-protected-resource/mcp` and `{BASE_URL}/.well-known/oauth-authorization-server`.

**Expect (UI)** none.
**Expect (backend)** the unauthenticated POST is 401 (or 400 with a JSON-RPC auth error) with a `WWW-Authenticate` header naming `oauth-protected-resource` and `scope="ctxpipe:read"`; both well-known URLs return JSON with issuer and resource metadata; the metadata lists `ctxpipe:read` and `ctxpipe:write` in `scopes_supported`.
**Budget** 1 s / 3 s per request.
**Evidence** the response headers; `x-request-id`; trace.

### MCP-2 Doctor
**Requires** MCP-1.
**Steps**
1. `npx ctxpipe doctor mcp --url "$BASE_URL/mcp"` (reachability and OAuth metadata only; it does not list tools).

**Expect (UI)** none.
**Expect (backend)** exit code 0 with reachable plus metadata; a connection error is a FAIL. The output does not name `ctx_advisor`; where it points to a next step, it names the read tools (`tools/list`, `list_workspaces`, `search_knowledge`).
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
1. `initialize` and then `tools/list` on `POST {BASE_URL}/mcp` with `x-api-key` and `accept: application/json, text/event-stream`. Keep the `instructions` text of the `initialize` result.

**Expect (UI)** none.
**Expect (backend)** `tools/list` contains exactly the seven read tools and no `ctx_advisor`; each tool has a `title` and `readOnlyHint: true`; `list_workspaces` carries `_meta["anthropic/alwaysLoad"]: true`; the `initialize` `instructions` start with the rules (under 512 characters), then name `{orgSlug}` with its Workspace slugs, and are under 2,048 characters in total; actor type in the trace is `org_api_key`.
**Budget** 2 s / 5 s.
**Evidence** the JSON-RPC result; trace.

### MCP-5 Read tools answer from the Workspace
**Requires** MCP-4; HYD-1 (Workspace 1 is the org's first Workspace); hydrate ready.
**Steps** (each is a `tools/call` or `resources/read` on `POST {BASE_URL}/mcp` with `x-api-key`)
1. `list_workspaces` with `{"org":"{orgSlug}"}`, then with `{"org":"{orgSlug}","workspace":"{workspace1Slug}"}`.
2. `search_knowledge` with `org`, `workspaces: ["{workspace1Slug}"]`, and a one-sentence `query` about a named file in the Workspace. Keep the first hit `ref`.
3. `read_file` with `org`, `workspace`, and that `ref`; then `list_files` with `org` and `workspace`.
4. `get_related` with `org`, `workspace`, `seeds: [ref]`, `maxDepth: 1`, and no `query`.
5. `resources/read` with `uri` `ctxpipe://{orgSlug}/{workspace1Slug}/{ref}`.
6. `search_code` with `org`, `mode: "literal"`, a `query` that appears in a linked repository, and `excludeRepositories: []`. Skip this step when the Workspace links no repository.
7. Call `search_knowledge` with `org` set to a slug that does not exist.
8. Open the Workspace in the UI.

**Expect (UI)** the Workspace shows no new conversation in the sidebar list.
**Expect (backend)** step 1 lists the Workspace with `ready: true`, and detail mode shows its repositories and readiness. Steps 2 to 4 return `structuredContent` and TOON text; each result names the served branch and SHA; the hit `ref` is a unit path, and the `read_file` content has line numbers and matches the file. Step 5 returns the same text as step 3. Step 6 returns refs of the form `<handle>:<path>`. Step 7 returns `isError: true` with code `org_not_found` and no hint of whether the org exists (the API-key error has no Connected apps hint). No call creates a `conversations` row, runs a chat run, or starts a sandbox. The spans carry `ctxpipe.mcp.org.slug_hash` and no query text, path, or handle.
**Budget** 3 s / 10 s per call (*uncertain*: `search_code` can take longer on a cold index).
**Evidence** the tool results; the traces of each call.

### MCP-6 Cross-tenant access is denied (#285)
**Requires** ONB-2; account C registered in its own context with its own org (repeat ONB-1 and ONB-2 for C, GitHub optional) and an API key in org C (MCP-3 steps for C).
**Steps**
1. With C's key, call `search_knowledge` and `list_workspaces` on `POST /mcp` with `org` set to `{orgA}`, then `POST /mcp?orgSlug={orgA}` with `tools/list` (the server ignores `orgSlug`).
2. With C's session cookie, `GET /{orgA}/api/v1/workspaces`.
3. As C, open `{BASE_URL}/{orgA}/` and `{BASE_URL}/{orgA}/ws/{workspace1Slug}` in the browser.

**Expect (UI)** the page reads **You do not have access to this organisation** with **Go to home**; no Workspace name, conversation, or file of org A is shown.
**Expect (backend)** step 1 returns `org_not_found` for each tool call, and `tools/list` shows no org A data (the URL parameter selects nothing); step 2 is refused (401 or 403, never 200 with data); no row of org A is returned; the trace carries C's org, not A's.
**Budget** 3 s / 10 s per request.
**Evidence** `MCP-6-1.png`; the status codes; traces.

## Status

- **PASS** MCP-1 to MCP-6 `PASS` (MCP-4 OAuth path may `SKIP(needs-human)`).
- **FAIL** doctor or metadata down, doctor output that names `ctx_advisor`, `tools/list` missing a read tool, listing `ctx_advisor` or another tool, a read tool that returns no hit for a file that the hydrated Workspace holds, a call that starts a sandbox or creates a conversation, a revoked key still accepted, or any cross-tenant read.
- Device login (`npx ctxpipe auth login --base-url`) is optional setup auth, not MCP OAuth.
