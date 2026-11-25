# MCP servers for agents

The root [`AGENTS.md`](../../AGENTS.md) lists the config files for each harness. Keep the server lists the same in all of them. This file says what each server is for and how to sign in.

Claude Code and Codex read keys from environment variables. `crm` is different: Claude Code gets its headers from a command (see [CRM](#crm)). Only `ctxpipe` can fall back to OAuth: use `/mcp` in Claude Code, or `codex mcp login ctxpipe` in Codex. Cursor uses OAuth for `ctxpipe`, and environment variables for the other servers. `codex mcp list` shows the auth state of each server.

| Server | Purpose | Auth in Claude Code and Codex |
| --- | --- | --- |
| `ctxpipe` | Hosted product MCP (org `ctx-tev`) | `CTXPIPE_API_KEY` (sent as `x-api-key`), or OAuth with access to that org |
| `hyperdx` | ClickStack logs, traces with prompt text, metrics, dashboards (`hyperdx.ctxpipe.dev`, behind Cloudflare Access) | All required: `HYPERDX_ACCESS_KEY` = personal access key (Bearer), not the ingest token; `HYPERDX_CF_ACCESS_CLIENT_ID` and `HYPERDX_CF_ACCESS_CLIENT_SECRET` = the Access service token `agents`. Where each agent host keeps them: [ops/observability/USING.md](../../ops/observability/USING.md#agent-hosts) |
| `cloudflare` | Cloudflare API, **read-only** by token: zones, DNS records, Access apps and policies, tunnel configuration, Logpush jobs. See [Cloudflare](#cloudflare) | `CLOUDFLARE_API_TOKEN_READONLY` (Bearer) is required |
| `crm` | The self-hosted Twenty CRM (`crm.ctxpipe.dev`, behind Cloudflare Access), read and write. Holds customer data. See [CRM](#crm) | Claude Code only, on a factory agent host: the `headersHelper` `factory crm headers`. No environment variable. Codex does not start it |

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

## CRM

The `crm` server is the MCP server of the CRM: the self-hosted Twenty CRM at `https://crm.ctxpipe.dev/mcp` (factory `machines/crm`). It can read and write CRM records. The factory repo's `.mcp.json` has the same entry.

The server works only on a factory agent host. Its `headersHelper`, `factory crm headers`, prints the host's own Cloudflare Access service token and Twenty API key each time that Claude Code connects. Nothing is in an environment variable or in a config file. Thus the host must have `factory` on the `PATH` and the host's `ctxpipe-factory-crm-reader` AWS profile (factory `machines/cli` README, "CRM"). On a different machine, the command fails and the server does not connect. A person can use the same `/mcp` path from a WARP device with their own Twenty API key, in their own MCP config. Codex and Cursor cannot run a headers command: Codex lists the server with `enabled = false`, and Cursor lists it without headers.

The CRM holds customer data: names, email addresses, and companies of people. What an agent reads there (records, names, identifiers) stays in its session. Never put it into a pull request, an issue, a ticket, a commit, a log, or a file in a repo. Describe a finding without it, for example "one company record has no domain", not the name of the company. Read only the records that the task needs. This repository is public: also obey _Customer privacy_ in [`AGENTS.md`](../../AGENTS.md).
