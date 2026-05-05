# Universal ctxpipe CLI

## Context

ctx| currently helps teams install MCP configuration through repo-level pull
requests. That is useful for standardized project config, but it is cumbersome as
the primary onboarding path: every MCP client has different command syntax,
config file locations, transport names, OAuth behavior, and install UX.

If we keep documenting each path manually, the docs will sprawl and users will
need to understand too much of the MCP ecosystem before they can connect ctx|.

The npm package name `ctxpipe` appears to be available, which gives us a cleaner
product surface than a narrow MCP-only package.

## Recommendation

Create a universal `ctxpipe` CLI, with `init` as the default human-friendly
entrypoint:

```bash
npx ctxpipe init
```

`ctxpipe init` should initialize the current repository or workspace for ctx|,
not just install MCP. It can ask a small number of questions:

- Which ctx| organization should this repo use?
- Which agents or clients do you use?
- Should setup apply to this repo, the current user, or both?
- Should ctx| add MCP configuration now?

MCP setup should become one capability under this broader CLI. For example, an
agent or advanced user could still run a focused command:

```bash
npx ctxpipe mcp add --org acme --client codex
```

The CLI should detect supported clients, prefer native client commands, fall
back to safe config edits, and hide MCP file, transport, and auth details from
humans.

Repo-level PR installation should remain available, but should be positioned as
a team-managed project config option rather than the happy path.

## User Modes

### Human mode

Humans should get one command:

```bash
npx ctxpipe init
```

This path should be interactive, calm, and short. It should avoid flags and
avoid asking users to understand MCP internals. The CLI should do discovery
where possible and ask only the questions needed to make a safe change.

The expected flow is:

```txt
npx ctxpipe init
-> CLI asks the user to sign in to ctx|
-> Browser opens for ctx| device-code approval
-> CLI receives setup auth
-> CLI loads the user's ctx| organizations
-> User selects the organization for this repo
-> User chooses where to connect ctx|: This repo, Globally, or Both
-> CLI detects installed agents
-> User chooses which agents to connect
-> CLI shows a summary of what it will change
-> CLI writes agent config so selected agents know where ctx| MCP lives
-> Setup completes
-> Later, each agent triggers its own MCP OAuth flow on first use
```

Setup auth and MCP auth are intentionally separate. The CLI token is only for
setup context such as organization selection; each MCP client owns its own
OAuth tokens when it connects to `/mcp`.

### Agent mode

Agents and CI need non-interactive commands with explicit flags:

```bash
npx ctxpipe init --org acme --agents codex,claude --scope repo --yes
npx ctxpipe mcp add --org acme --client cursor --scope user --yes
npx ctxpipe doctor --json
```

These commands can be more verbose and machine-oriented. They should have stable
output, `--json` support where useful, non-zero exit codes, and no surprise TTY
prompts when `--yes` or explicit flags are supplied.

## Findings

### MCP org membership should be verified before rollout

`/mcp` currently authenticates the user and resolves `orgSlug`, but the reviewed
middleware only verifies that the organisation exists. It does not appear to
verify that the authenticated user is a member of that organisation.

Jakub noted that he believes this may already be enforced elsewhere. Before
shipping a broader CLI that makes MCP setup easier, we should double-check the
actual request path and add/adjust regression coverage if needed.

Relevant file: `apps/backend/src/auth/withAuth.ts`.

### API key docs have a separate draft PR

The docs describe dashboard API keys for MCP, but backend auth currently mounts
`bearer()`, `jwt()`, `organization()`, `deviceAuthorization()`, and
`oauthProvider()`. I did not find Better Auth `apiKey()` mounted, API key
routes, or API key schema.

There is already a draft PR related to this note. This proposal should track the
outcome rather than solve it directly.

Relevant docs: `apps/docs/content/docs/self-hosting/authentication.mdx`.

## Current Best Practice

The MCP ecosystem is converging on:

- Remote Streamable HTTP MCP for SaaS and server-backed tools.
- OAuth discovery, protected resource metadata, and DCR for user auth.
- Native client install commands where available.
- One-click install links for clients that support them.
- Checked-in config only when teams intentionally want project-level
  standardization.

That direction fits ctx| because the backend already serves `/mcp`, Better Auth
is already configured as an OAuth provider, and the product already has
organisation-scoped MCP URLs.

## Product Goals

- One default install command for most users.
- A single `ctxpipe` CLI that can grow beyond MCP setup.
- No hand-editing JSON or TOML for common clients.
- No need for users to understand Streamable HTTP, OAuth metadata, DCR, or config
  file locations.
- Clear separation between human-friendly interactive setup and agent-friendly
  non-interactive setup.
- Preserve enterprise and team workflows through PR-based project config.
- Keep auth secure and auditable.

## Non-Goals

- Do not replace the hosted `/mcp` server with a local-only MCP server.
- Do not make repo PRs the primary setup path.
- Do not add many new environment variables for install behavior.
- Do not build per-model docs pages as the long-term solution.
- Do not make human users learn the agent/CI flags.

## Implementation Approach

1. Verify auth prerequisites
   - Confirm where org membership is enforced for `/mcp?orgSlug=...`.
   - Add or adjust tests proving non-members cannot access `orgSlug`.
   - Track the API key draft PR and align CLI fallback behavior with its outcome.

2. Claim and publish the universal CLI package
   - Add `packages/cli`.
   - Publish as `ctxpipe`.
   - Expose the binary as `ctxpipe`.
   - Make `npx ctxpipe init` the main customer-facing command.

3. Implement interactive `init`
   - Authenticate with ctx| or detect an existing session/token.
   - Let the user select an organization.
   - Detect known agent clients.
   - Ask which agents should be configured.
   - Apply user/global or repo-scoped setup based on answers.

4. Implement non-interactive agent commands
   - Provide:

     ```bash
     npx ctxpipe init --org acme --agents codex,claude --scope repo --yes
     npx ctxpipe mcp add --org acme --client claude --scope user --yes
     npx ctxpipe doctor --json
     ```

   - Avoid TTY prompts when all required flags are supplied.
   - Return stable exit codes.
   - Support machine-readable output where useful.

5. Add MCP client adapters
   - Use an adapter registry per client:
     - Claude Code: native `claude mcp add --transport http ...`.
     - Codex: native `codex mcp add ... --url ...`.
     - Cursor: global or project `mcp.json`, later Add to Cursor link.
     - VS Code/Copilot: `vscode:mcp/install` link or `.vscode/mcp.json`.
     - OpenCode: `opencode.json` with `type: "remote"`.

6. UI integration
   - Generate the simple command:

     ```bash
     npx ctxpipe init
     ```

   - When the app already knows the org, optionally provide a prefilled
     agent/CI command.
   - Show detected or native commands as secondary options.
   - Keep "Install MCP via PRs" as an advanced/team option.

7. Docs simplification
   - One setup page:
     - Recommended human command.
     - Agent/CI command reference.
     - Manual MCP config.
     - Troubleshooting.
   - Move PR-based install to "Team-managed project config."

## Open Questions

- Should API keys be a real supported auth path for MCP, or should we avoid
  long-lived keys and lean fully into OAuth/device flows?
- Should interactive `init` default to user/global scope, repo scope, or ask?
- What should `ctxpipe init` initialize beyond MCP in v1?
- Should the CLI eventually manage repository onboarding, auth status, diagnostics,
  and local agent rules?
- Do we want a local bridge package later for clients with weak OAuth support?

## Suggested Rollout

1. Verify membership enforcement and resolve the API key docs/API key draft PR.
2. Claim and publish the `ctxpipe` npm package with a minimal `init`.
3. Ship MCP adapters for Claude Code, Codex, Cursor, and OpenCode.
4. Add VS Code install links and richer app UI.
5. Consider a local bridge for problematic clients.
6. De-emphasize PR install in onboarding while keeping it for team
   standardization.

## References

- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider)
- [Better Auth API Key](https://better-auth.com/docs/plugins/api-key)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [OpenAI Docs MCP](https://developers.openai.com/learn/docs-mcp)
- [VS Code MCP guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [OpenCode MCP docs](https://opencode.ai/docs/mcp-servers)
- [Railway MCP docs](https://docs.railway.com/ai/mcp-server)
