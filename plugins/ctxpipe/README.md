# ctx| Claude plugin

Distributes the hosted ctx| MCP (`https://app.ctxpipe.ai/mcp`) as a Claude plugin. Same package for Claude Code, Cowork, and Claude Tag in Slack.

The plugin declares the remote server. It does **not** skip OAuth. The first use
signs the caller into ctx| and binds the OAuth grant to one organization:

- one membership → that organization
- several memberships → an explicit organization selection before consent

Changing the active organization in ctx| later does not retarget the grant.
Reconnect ctxpipe to choose another organization. `orgSlug` remains supported
for manual and legacy client configurations; the community plugin does not
need it. Do not put tokens in the query string.

## Claude Code

```text
/plugin marketplace add ctxpipe-ai/ctxpipe
/plugin install ctxpipe@ctxpipe
```

Then open `/mcp`, connect **ctxpipe**, and complete the ctx| OAuth prompt. Follow
[`SETUP.md`](./SETUP.md) to verify `ctx_advisor`, not merely the redirect.

Self-host: copy this folder and change `.mcp.json` to your public `/mcp` origin.

## Claude Tag (Slack channels)

A custom MCP URL pasted into claude.ai does **not** apply in `@Claude`
channels. Attach this plugin to the Access bundle, then add an **MCP
Connector** credential for `app.ctxpipe.ai` (or your self-host host). The owner
signs in once and selects the ctx| organization the channel agent may use.
Claude Tag requires this admin connection; the plugin removes URL entry, not
the connection and consent boundary.

Start a **new** thread after attaching the plugin. Existing threads keep the tool set they started with.

```text
@Claude use ctx_advisor. What standards apply before we change this auth flow?
```

Team/Enterprise owners can upload a ZIP of this folder or vendor it into a
private marketplace repo. Public GitHub sync is not a shortcut for org
marketplaces; copy the files.

## Community directory

Direct marketplace installation works from this repository. Public discovery
requires a separate submission to Anthropic's community Plugin Directory:

- `https://claude.ai/admin-settings/directory/submissions/plugins/new`
- `https://platform.claude.com/plugins/submit`

The submission is an account-owner action, not something this repository can
perform during build or deployment.

## Permissions and data

`ctx_advisor` reads context already available to the selected ctx| organization.
It does not change connected source systems. ctx| stores the MCP conversation
and normal operational telemetry so follow-up calls retain context. Membership
in the OAuth-bound organization is checked on every request.

See [Data processing](https://docs.ctxpipe.ai/docs/resources/data-processing).

## claude.ai custom connector

If you only need web/Desktop/mobile chat, the same plugin-bundled remote MCP is
the preferred path. Manual custom connectors remain supported as a fallback:

`https://app.ctxpipe.ai/mcp`

or an explicitly scoped legacy/manual URL:

`https://app.ctxpipe.ai/mcp?orgSlug=your-org`

## What this is not

- Not a Cursor, Codex, or CodeRabbit marketplace listing.
- Not a Claude Desktop MCPB extension. Hosted ctx| is a remote MCP.
- Not a replacement for `npx ctxpipe init` on machines that already use repo or user MCP config.

See [Claude plugin](https://docs.ctxpipe.ai/docs/mcp/claude-plugin).
