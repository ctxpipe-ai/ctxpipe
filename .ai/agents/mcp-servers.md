# MCP servers for agents

The root [`AGENTS.md`](../../AGENTS.md) lists the config files for each harness. Keep the server lists the same in all of them. This file says what each server is for and how to sign in.

Claude Code and Codex read keys from environment variables. Only `ctxpipe` can fall back to OAuth: use `/mcp` in Claude Code, or `codex mcp login ctxpipe` in Codex. Cursor uses OAuth for `ctxpipe`, `neon`, and `railway`. `codex mcp list` shows the auth state of each server.

| Server | Purpose | Auth in Claude Code and Codex |
| --- | --- | --- |
| `ctxpipe` | Hosted product MCP (org `ctx-tev`) | `CTXPIPE_API_KEY` (sent as `x-api-key`), or OAuth with access to that org |
| `ctxpipe-storybook` | Storybook MCP at `http://127.0.0.1:6006/mcp` | None. Storybook must be running: `pnpm --filter @ctxpipe/ui storybook` |
| `neon` | Neon Lakebase Postgres, **read-only** | `NEON_API_KEY` (Bearer) is required. The URL forces read-only. [Neon MCP docs](https://neon.com/docs/ai/neon-mcp-server) |
| `railway` | Railway status + deploy/runtime stdout | Stdio server (`railway mcp local`). Set `RAILWAY_API_TOKEN`, or run `railway login` |
| `hyperdx` | ClickStack logs, traces, metrics, dashboards | `HYPERDX_ACCESS_KEY` = personal access key (Bearer), not the `HYPERDX_API_KEY` ingest token. It is required |
| `langfuse` | Langfuse **project** MCP (LLM traces / prompts) | `LANGFUSE_AUTH_STRING` = base64(`pk:sk`) is required. Codex sends it through a stdio `mcp-remote` bridge. See [ops/observability/USING.md](../../ops/observability/USING.md) |

