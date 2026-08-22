---
name: analyze-logs
description: Analyze application logs and ops signals. In this ctxpipe repo, prefer Railway → Langfuse → Better Stack MCPs (not .evlog/logs/). For a workspace chat hang (composer spins, empty assistant), use JSONL and filter step opencode.chatStream — never Better Stack CSV. Upstream sections below cover optional/legacy evlog FS drain for other stacks.
license: MIT
metadata:
  author: HugoRCD
  version: "0.1"
---

# Analyze application logs

## When in this repo (ctxpipe)

For **ctxpipe product / ops debugging**, do **not** start from (or require) a local `.evlog/logs/` filesystem drain. The backend uses **evlog → OTLP / stdout**, not the FS drain as the primary path.

**Prefer MCP sources in this order:**

1. **Railway MCP** (`railway`) — service status + deploy/runtime logs (**primary** for “what’s failing / what did the service log?”).
2. **Langfuse MCP** (`langfuse`) — traces, LLM calls, advisor / conversation quality.
3. **Better Stack MCP** (`betterstack`) — only when uptime or telemetry data is present and needed for the question.

See also root [AGENTS.md](../../../AGENTS.md) (**Ops debugging / logs**). Use the **evlog FS drain** guidance in the sections below only as **optional / secondary** (legacy or other stacks that actually write `.evlog/logs/`), never as a prerequisite for debugging this repo’s backend.

### Workspace chat hang (composer spins, no assistant text)

Do **not** export Better Stack **CSV**. Mixed-service CSV drops HTTP `message`, splits TanStack ANSI across `info` rows, and hides the OpenCode 500 body.

1. Prefer **Railway MCP** JSON/JSONL for `service=backend`. Better Stack only if you can export **JSON or JSONL**.
2. Filter `step` in (`opencode.chatStream`, `tanstack-workspace-chat`, `attach-chat-sandbox-handle`) plus the conversation `POST /:orgSlug/api/v1/conversations/:conversationId` `requestId`.
3. The conversation `POST` is **200** when the stream opens (~17–18s). That is not a successful turn. The chat-attempt event is a **second** row with `step=opencode.chatStream` after Hono emits the HTTP event.
4. If you see `[evlog] log.set() called after the wide event was emitted` dropping `step, conversationId, workspaceId, status, bodyExcerpt`, that deploy still writes to the sealed request logger — the chat-attempt fields never land.
5. The chat-attempt event must include `conversationId`, `status`, and `bodyExcerpt` (OpenCode/TanStack fatal). Grep `opencode.chatStream`, not `message == ""`.
6. Redact session tokens and emails before pasting. Do not add a second drain or a new env var.

Out of scope unless that body names them: codesearch `POST /search` 503 (Zoekt warmup) and `SANDBOX_PROVIDER=railway` fail-closed.

## Local evlog FS drain (optional)

Read and analyze structured wide-event logs from the local `.evlog/logs/` directory to debug errors, investigate performance issues, and understand application behavior (**optional/legacy path** — see **When in this repo** above for ctxpipe).

## When to Use

- User asks to debug an error, investigate a bug, or understand why something failed
- User asks about request patterns, slow endpoints, or error rates
- User asks "what happened" or "what's going on" with their application
- User asks to analyze logs, check recent errors, or review application behavior
- User mentions a specific error message or status code they're seeing

## Finding the logs

Logs are written by evlog's file system drain as `.jsonl` files, organized by date.

**Format detection**: The drain supports two modes:
- **NDJSON** (default, `pretty: false`): One compact JSON object per line. Parse line-by-line.
- **Pretty** (`pretty: true`): Multi-line indented JSON per event. Parse by reading the entire file and splitting on top-level objects (e.g. `JSON.parse('[' + content.replace(/\}\n\{/g, '},{') + ']')`) or use a streaming JSON parser.

Always check the first few bytes of the file to detect the format: if the second character is a newline or `"`, it's NDJSON; if it's a space or newline followed by spaces, it's pretty-printed.

**Search order** — check these locations relative to the project root:

1. `.evlog/logs/` (default)
2. Any `.evlog/logs/` inside app directories (monorepos: `apps/*/.evlog/logs/`)

Use glob to find log files:

```
.evlog/logs/*.jsonl
*/.evlog/logs/*.jsonl
apps/*/.evlog/logs/*.jsonl
```

Files are named by date: `2026-03-14.jsonl`. Start with the most recent file.

## If no logs are found

**In this repo (ctxpipe):** missing `.evlog/logs/` is expected. Use Railway → Langfuse → Better Stack (see **When in this repo** above). Do not treat FS-drain setup as required for product debugging.

For other stacks where the file system drain is intended but missing, guide the user to set it up:

```typescript
import { createFsDrain } from 'evlog/fs'

// Nuxt / Nitro: server/plugins/evlog-drain.ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('evlog:drain', createFsDrain())
})

// Hono / Express / Elysia: pass in middleware options
app.use(evlog({ drain: createFsDrain() }))

// Fastify: pass in plugin options
await app.register(evlog, { drain: createFsDrain() })

// NestJS: pass in module options
EvlogModule.forRoot({ drain: createFsDrain() })

// Standalone: pass to initLogger
initLogger({ drain: createFsDrain() })
```

After setup, the user needs to trigger some requests to generate logs, then re-analyze.

## Log format

Each line is a self-contained JSON object (wide event). Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | `string` | ISO 8601 timestamp |
| `level` | `string` | `info`, `warn`, `error`, `debug` |
| `service` | `string` | Service name |
| `environment` | `string` | `development`, `production`, etc. |
| `method` | `string` | HTTP method (`GET`, `POST`, etc.) |
| `path` | `string` | Request path (`/api/checkout`) |
| `status` | `number` | HTTP response status code |
| `duration` | `string` | Request duration (`"234ms"`) |
| `requestId` | `string` | Unique request identifier |
| `error` | `object` | Error details: `name`, `message`, `stack`, `statusCode`, `data` |
| `error.data.why` | `string` | Human-readable explanation of what went wrong |
| `error.data.fix` | `string` | Suggested fix for the error |
| `source` | `string` | `client` for browser logs, absent for server logs |
| `userAgent` | `object` | Parsed browser/OS/device info |

All other fields are application-specific context added via `log.set()` (e.g. `user`, `cart`, `payment`).

## How to analyze

### Step 1: Read the most recent log file

Read the latest `.jsonl` file. Each line is one JSON event. Parse each line independently.

### Step 2: Identify the relevant events

Filter based on the user's question:

- **Errors**: look for `"level":"error"` or `status >= 400`
- **Specific endpoint**: match on `path`
- **Slow requests**: parse `duration` (e.g. `"706ms"`) and filter high values
- **Specific user/action**: match on application-specific fields
- **Client-side issues**: filter by `"source":"client"`
- **Time range**: compare `timestamp` values

### Step 3: Analyze and explain

For each relevant event:

1. **What happened**: summarize the `path`, `method`, `status`, `level`
2. **Why it failed** (errors): read `error.message`, `error.data.why`, and the stack trace
3. **How to fix**: check `error.data.fix` for suggested remediation
4. **Context**: examine application-specific fields for business context (user info, payment details, etc.)
5. **Patterns**: look for recurring errors, degrading performance, or correlated failures

## Analysis patterns

### Find all errors

```
Filter: level === "error"
Group by: error.message or path
Look for: recurring patterns, common failure modes
```

### Find slow requests

```
Filter: parse duration string, compare > threshold (e.g. 1000ms)
Sort by: duration descending
Look for: specific endpoints, time-of-day patterns
```

### Trace a specific request

```
Filter: requestId === "the-request-id"
Result: single wide event with all context for that request
```

### Error rate by endpoint

```
Group events by: path
Count: total events vs error events per path
Look for: endpoints with high error ratios
```

### Client vs server errors

```
Split by: source === "client" vs no source field
Compare: error patterns between client and server
Look for: client errors that don't have corresponding server errors (network issues)
```

## Important notes

- Each line is a **complete, self-contained event**. Unlike traditional logs, you don't need to correlate multiple lines — one line has all the context for one request.
- The `error.data.why` and `error.data.fix` fields are evlog-specific structured error fields. When present, they provide the most actionable information.
- Duration values are strings with units (e.g. `"706ms"`). Parse the numeric part for comparisons.
- Events with `"source":"client"` originated from browser-side logging and were sent to the server via the transport endpoint.
- Log files are `.gitignore`'d automatically — they exist only on the local machine or server where the app runs.
