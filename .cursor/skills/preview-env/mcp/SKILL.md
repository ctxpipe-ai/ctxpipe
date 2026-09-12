---
name: preview-env-mcp
description: Hosted product MCP on a Railway PR preview origin.
disable-model-invocation: true
---

# preview-env mcp

`{BASE_URL}/mcp?orgSlug={orgSlug}`. Product MCP exposes **one** tool: `ctx_advisor` (new hidden conversation per call, first workspace, read-only). Repo explorer tools run **inside** that chat turn. [Harness](../harness.md) is `PASS`. HTTP/CLI plus a short `computerUse` for the snippet.

## 1. Discovery

```bash
curl -sS -D - -o /tmp/preview-env-mcp-unauth.json \
  -X POST "$BASE_URL/mcp?orgSlug=$orgSlug" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"preview-env","version":"0"}}}'
```

Expect `WWW-Authenticate` with `oauth-protected-resource`. Then GET:

- `{BASE_URL}/.well-known/oauth-protected-resource/mcp`
- `{BASE_URL}/.well-known/oauth-authorization-server`

Both return JSON with issuer/resource metadata.

**Done when:** unauthenticated POST is 401 (or 400 with JSON-RPC auth error) **and** both well-known URLs are JSON.

## 2. Doctor

```bash
npx ctxpipe doctor mcp --url "$BASE_URL/mcp?orgSlug=$orgSlug"
```

Reachability + OAuth metadata only. It does not list tools.

**Done when:** the command exits 0 (or prints reachable + metadata). Non-zero with a connection error is FAIL.

## 3. tools/list

Authenticated Streamable HTTP. Prefer the signed-in cookie (`Cookie` header) or an `x-api-key` from `/.auth/account` (create only if cookie auth is rejected; label the key preview-env).

Initialize + `tools/list` on `POST /mcp?orgSlug={org}`. The list includes `ctx_advisor` and no extra product tools.

**Done when:** `tools/list` result contains `ctx_advisor`.

## 4. ctx_advisor

`tools/call` `ctx_advisor` with `prompt` asking for this org’s standards or ADRs (one sentence). Zero workspaces → expected error to create a Workspace (FAIL the area if the org should already have one).

**Done when:** the tool result has non-empty text, **or** the create-Workspace error when `GET /{org}/api/v1/workspaces` is `[]`.

## 5. UI snippet

From onboarding MCP slide or account/org copy control, read the MCP URL. On a preview origin, note if the snippet still says `https://app.ctxpipe.ai/mcp`. **Install via PR**: open preview only; do not submit.

**Done when:** the visible URL is recorded (preview host vs `app.ctxpipe.ai`).

## Status

- **PASS** — steps 1–4 met; step 5 recorded.
- **FAIL** — doctor/metadata down, `tools/list` missing `ctx_advisor`, or advisor empty while a workspace and models should work.
- Device login (`npx ctxpipe auth login --base-url`) is optional setup auth, not MCP OAuth.
