# MCP servers for agents

The root [`AGENTS.md`](../../AGENTS.md) lists the config files for each harness. Keep the server lists the same in all of them. This file says what each server is for and how to sign in.

Claude Code and Codex read keys from environment variables. Only `ctxpipe` can fall back to OAuth: use `/mcp` in Claude Code, or `codex mcp login ctxpipe` in Codex. Cursor uses OAuth for `ctxpipe`, `neon`, and `railway`, and environment variables for the other servers. `codex mcp list` shows the auth state of each server.

| Server | Purpose | Auth in Claude Code and Codex |
| --- | --- | --- |
| `ctxpipe` | Hosted product MCP (org `ctx-tev`) | `CTXPIPE_API_KEY` (sent as `x-api-key`), or OAuth with access to that org |
| `ctxpipe-storybook` | Storybook MCP at `http://127.0.0.1:6006/mcp` | None. Storybook must be running: `pnpm --filter @ctxpipe/ui storybook` |
| `neon` | Neon Lakebase Postgres, **read-only** | `NEON_API_KEY` (Bearer) is required. The URL forces read-only. [Neon MCP docs](https://neon.com/docs/ai/neon-mcp-server) |
| `railway` | Railway status + deploy/runtime stdout | Stdio server (`railway mcp local`). Set `RAILWAY_API_TOKEN`, or run `railway login` |
| `hyperdx` | ClickStack logs, traces, metrics, dashboards | `HYPERDX_ACCESS_KEY` = personal access key (Bearer), not the `HYPERDX_API_KEY` ingest token. It is required |
| `langfuse` | Langfuse **project** MCP (LLM traces / prompts) | `LANGFUSE_AUTH_STRING` = base64(`pk:sk`) is required. Codex sends it through a stdio `mcp-remote` bridge. See [ops/observability/USING.md](../../ops/observability/USING.md) |
| `cloudflare` | Cloudflare API, **read-only** by token: zones, DNS records, Access apps and policies, tunnel configuration, Logpush jobs. See [Cloudflare](#cloudflare) | `CLOUDFLARE_API_TOKEN_READONLY` (Bearer) is required |

## Cloudflare

The `cloudflare` server is Cloudflare's official API MCP server at `https://mcp.cloudflare.com/mcp` ([repository](https://github.com/cloudflare/mcp), [docs](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)). It covers the full Cloudflare API. Use it to read Cloudflare state for operations, debugging, and infrastructure-as-code work. For example, read a zone ID, a DNS record, an Access policy, or a tunnel ingress rule. Do not ask a person for these values.

The server has no read-only mode. It can send each API call that the token allows. Thus the token is the only limit. Use a token that has only read permissions. Do not use this server to change Cloudflare. The planned change path is the edge stack (ADR-061, in review in [PR #632](https://github.com/ctxpipe-ai/ctxpipe/pull/632)).

The CTO creates one account-owned API token with these permissions, and no other permission:

| Scope | Permission |
| --- | --- |
| Account | Account Settings Read (the server uses it to find the account ID) |
| Account | Access: Apps and Policies Read |
| Account | Access: Organizations, Identity Providers, and Groups Read |
| Account | Zero Trust Read (Gateway policies, WARP device settings and device posture, which ADR-061 uses) |
| Account | Cloudflare Tunnel Read |
| Account | Logs Read |
| Zone (`ctxpipe.ai` and `ctxpipe.dev`) | Zone Read |
| Zone (`ctxpipe.ai` and `ctxpipe.dev`) | DNS Read |
| Zone (`ctxpipe.ai` and `ctxpipe.dev`) | Access: Apps and Policies Read |
| Zone (`ctxpipe.ai` and `ctxpipe.dev`) | Logs Read |

Cloudflare Tunnel Read cannot get a tunnel run token. That endpoint accepts only a Write permission ([API reference](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/)). Do not add Client IP Address Filtering to the token: the server does not support it.

Logs Read gives more than configuration. Obey these rules:

- A Logpush job reads back with its `destination_conf`. Thus a Logpush destination must hold no secret: use an IAM role or an ownership challenge, not an access key, an HTTP auth header, or a vendor API key in the destination.
- Logs Read can also pull request logs (Logpull, Instant Logs). These hold client IP addresses and URLs that can name a customer. Do not pull request logs through this server. Use HyperDX for request data. If you must read a request log, do not put a customer identifier into a reply, a commit, a PR, or `.ai/memory/` (see _Customer privacy_ in [`AGENTS.md`](../../AGENTS.md)).

Put the token in `CLOUDFLARE_API_TOKEN_READONLY`. A Paseo agent does not read `~/.zshrc`. Thus also set the variable in Paseo's agent environment: `agents.providers.<provider>.env` in `~/.paseo/config.json`, for each provider that you use.
