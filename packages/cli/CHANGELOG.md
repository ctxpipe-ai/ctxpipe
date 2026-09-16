# ctxpipe

## 0.4.0

### Minor Changes

- 9c9e889: Add API-key MCP auth as an OAuth alternative: `--auth api-key` writes a client-specific interpolation of `CTXPIPE_API_KEY` (never the secret) into repo or user MCP config. Mint organisation keys in Organisation settings; personal keys remain under User account. `doctor mcp` sends `x-api-key` when `CTXPIPE_API_KEY` is set in that process. Raise dashboard API-key rate limits so MCP is usable.

### Patch Changes

- 9c9e889: Write Cursor and Claude MCP config with `"type": "http"` so Cursor Agent CLI and Desktop accept the Streamable HTTP server.

## 0.3.4

### Patch Changes

- 19293bb: Support the generic tenant-bound MCP endpoint used by the ctx| Claude plugin.
- 21a2182: Emit a Claude Code–valid Stop continuation (`decision: block` + `reason`) and stop observing PostToolUse, which minted tool dumps as memory candidates.

## 0.3.3

### Patch Changes

- 9072089: Keep memory-capture follow-ups quiet: seed a one-sentence user reply, and stay silent when nothing was promoted.

## 0.3.2

### Patch Changes

- e6085e2: Stop Cursor memory capture from recapturing Stop `followup_message` as a new lesson, and stop classifying MCP/grep/test dumps from afterFileEdit and postToolUse. Cursor hooks observe user prompts only; tool-sourced pending ids are dismissed.

## 0.3.1

### Patch Changes

- 44dd8dc: Stop memory capture from looping on Cursor Stop follow-ups. Classify user/assistant speech only, raise the lesson bar, and emit a one-shot follow-up so promotion turns cannot recapture themselves.

## 0.3.0

### Minor Changes

- 52370f7: Require organisation membership for MCP and org-scoped REST. Harden Streamable HTTP transport and add ctxpipe doctor mcp plus version-pinned MCPJam diagnostic scripts.

## 0.2.0

### Minor Changes

- 492d964: Add local memory into CLI

## 0.1.1

### Patch Changes

- 7f148d1: Publish CLI to npm (retry after failed 0.1.0 release). Read CLI version from package.json instead of a hardcoded constant.
- 70855a0: .

## 0.1.0

### Minor Changes

- fb57f34: New CLI & device code auth flow
