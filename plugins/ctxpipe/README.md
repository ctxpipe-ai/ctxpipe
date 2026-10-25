# ctxpipe Claude plugin

Distributes the hosted ctxpipe MCP (`https://app.ctxpipe.ai/mcp`) as a Claude plugin. Same package for Claude Code, Cowork, and Claude Tag in Slack.

The plugin declares the remote server and the `ctxpipe-context` skill. It does
**not** skip OAuth. The first use signs the caller into ctxpipe and creates an
OAuth grant with a set of organizations:

- consent lists your organizations; the active one is ticked and you can tick
  more (at least one)
- each tool call names one organization in `org`; one session can use several
- a removed membership or an unticked organization denies the next call, with
  no reconnect

Change the set in **Connected apps** in ctxpipe settings (`/.auth/account/connected-apps`).
The `/mcp` URL has no `orgSlug`. The server ignores `?orgSlug=`, so old
configurations do not fail. Do not put tokens in the query string.

Claude requests `offline_access`, so browser sign-out does not disconnect the
installed plugin. Revoke or disconnect the Claude MCP connection to remove its
access.

## Tools and skill

Version 0.2.0 replaces the `ctx_advisor` tool and the `ctx-advisor` skill with
seven read-only tools. Claude does the reasoning and ctxpipe returns facts with
refs it can cite:

| Tool | Job |
| -- | -- |
| `list_workspaces` | List the organizations and Workspaces you can read. |
| `search_knowledge` | Search knowledge units: ADRs, standards, service pages, mirrored sources. |
| `get_related` | Find units near seed refs in the graph and relevant to a query. |
| `search_code` | Search linked repositories (literal, regex, or structural). |
| `find_symbol` | Find definitions, references, callers, and callees. |
| `list_files` | List a folder of a Workspace repository or a linked repository. |
| `read_file` | Read a unit or a repository file by ref. |

A client can also open one ref as the resource `ctxpipe://{org}/{workspace}/{+ref}`.

The `ctxpipe-context` skill teaches Claude when to call each tool, to name the
organization in every call, to send independent calls in parallel, and not to
search the repository it works in. A client that calls `ctx_advisor` fails after
the upgrade: update the plugin and use the tools above.

## Claude Code

```text
/plugin marketplace add ctxpipe-ai/ctxpipe
/plugin install ctxpipe@ctxpipe
```

Then open `/mcp`, connect **ctxpipe**, and complete the ctxpipe OAuth prompt. Follow
[`SETUP.md`](./SETUP.md) to verify `list_workspaces`, not merely the redirect.

Self-host: copy this folder and change `.mcp.json` to your public `/mcp` origin.

## Claude Tag (Slack channels)

A custom MCP URL pasted into claude.ai does **not** apply in `@Claude`
channels. Attach this plugin to the Access bundle, then add an **MCP
Connector** credential for `app.ctxpipe.ai` (or your self-host host). The owner
signs in once and ticks the ctxpipe organizations the channel agent may use.
Claude Tag requires this admin connection; the plugin removes URL entry, not
the connection and consent boundary.

Start a **new** thread after attaching the plugin. Existing threads keep the tool set they started with.

```text
@Claude search ctxpipe knowledge. What standards apply before we change this auth flow?
```

Team/Enterprise owners can upload a ZIP of this folder or vendor it into a
private marketplace repo. Public GitHub sync is not a shortcut for org
marketplaces; copy the files.

## Community directory

Direct marketplace installation works from this repository. Public discovery
requires a separate submission to Anthropic's community Plugin Directory:

- `https://claude.ai/admin-settings/directory/submissions/plugins/new`
- `https://platform.claude.com/plugins/submit`

After this change is merged, submit the plugin's **main-branch subdirectory**:

`https://github.com/ctxpipe-ai/ctxpipe/tree/main/plugins/ctxpipe`

A dedicated repository is not required. Anthropic's community catalogue
supports `git-subdir` sources and sparsely fetches the plugin directory from a
monorepo. Do not submit the feature-branch URL.

The submission is an account-owner action, not something this repository can
perform during build or deployment.

## Permissions and data

The read tools return context already available to the ticked ctxpipe
organizations. They do not change connected source systems. ctxpipe stores normal
operational telemetry for each call. Membership in the
organization and the grant set are checked on every call.

See [Data processing](https://docs.ctxpipe.ai/docs/resources/data-processing).

## claude.ai custom connector

If you only need web/Desktop/mobile chat, the same plugin-bundled remote MCP is
the preferred path. Manual custom connectors remain supported as a fallback:

`https://app.ctxpipe.ai/mcp`

Older configurations that add `?orgSlug=your-org` keep working: the server
ignores the parameter.

## What this is not

- Not a Cursor, Codex, or CodeRabbit marketplace listing.
- Not a Claude Desktop MCPB extension. Hosted ctxpipe is a remote MCP.
- Not a replacement for `npx ctxpipe init` on machines that already use repo or user MCP config.

See [Claude plugin](https://docs.ctxpipe.ai/docs/mcp/claude-plugin).
