# ctx| Claude plugin

Distributes the hosted ctx| MCP (`https://app.ctxpipe.ai/mcp`) as a Claude plugin. Same package for Claude Code, Cowork, and Claude Tag in Slack.

The plugin declares the remote server. It does **not** skip OAuth. The first use still signs the caller into ctx|. Organization tenancy then follows the authenticated user:

- one membership → that organization
- several memberships → the session's active organization, or `?orgSlug=` / `X-Ctxpipe-Org` when that is ambiguous

`orgSlug` in the URL remains supported. Do not put tokens in the query string.

## Claude Code

```text
/plugin marketplace add ctxpipe-ai/ctxpipe
/plugin install ctxpipe@ctxpipe
```

Then `/mcp` and complete the ctx| OAuth prompt.

Self-host: copy this folder and change `.mcp.json` to your public `/mcp` origin.

## Claude Tag (Slack channels)

A custom MCP URL pasted into claude.ai does **not** apply in `@Claude` channels. Attach this plugin on the Access bundle, then add a Custom-tool credential whose allowed website is `app.ctxpipe.ai` (or your self-host host). Prefer the MCP Connector credential so the admin signs in once.

Start a **new** thread after attaching the plugin. Existing threads keep the tool set they started with.

```text
@Claude use ctx_advisor. What standards apply before we change this auth flow?
```

Team/Enterprise owners can upload a ZIP of this folder or vendor it into a private marketplace repo. Public GitHub sync is not a shortcut for org marketplaces; copy the files.

## claude.ai custom connector

If you only need web/Desktop/mobile chat, you can still add a custom connector:

`https://app.ctxpipe.ai/mcp`

or, when the user belongs to several organizations:

`https://app.ctxpipe.ai/mcp?orgSlug=your-org`

## What this is not

- Not a Cursor, Codex, or CodeRabbit marketplace listing.
- Not a Claude Desktop MCPB extension. Hosted ctx| is a remote MCP.
- Not a replacement for `npx ctxpipe init` on machines that already use repo or user MCP config.

See [Claude plugin](https://docs.ctxpipe.ai/docs/mcp/claude-plugin).
