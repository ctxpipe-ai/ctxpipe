# Simple MCP Install

## Context

ctx| currently helps teams install MCP configuration through repo-level pull
requests. That is useful for standardized project config, but it is cumbersome as
the primary onboarding path: every MCP client has different command syntax,
config file locations, transport names, OAuth behavior, and install UX.

If we keep documenting each path manually, the docs will sprawl and users will
need to understand too much of the MCP ecosystem before they can connect ctx|.

## Recommendation

Make ctx| MCP setup remote-first, OAuth-first, and installer-driven.

The default setup path should become:

```bash
npx -y @ctxpipe/mcp-install --org acme
```

The installer should detect supported clients, prefer native client commands,
fall back to safe config edits, and hide MCP file, transport, and auth details
from the user.

Repo-level PR installation should remain available, but should be positioned as
a team-managed project config option rather than the happy path.

## Findings

### MCP org membership should be enforced first

`/mcp` currently authenticates the user and resolves `orgSlug`, but the reviewed
middleware only verifies that the organisation exists. It does not appear to
verify that the authenticated user is a member of that organisation.

Before improving MCP distribution, we should enforce membership for
`/mcp?orgSlug=...` and review org-scoped REST routes that use the same
middleware.

Relevant file: `apps/backend/src/auth/withAuth.ts`.

### API key docs should match the backend

The docs describe dashboard API keys for MCP, but backend auth currently mounts
`bearer()`, `jwt()`, `organization()`, `deviceAuthorization()`, and
`oauthProvider()`. I did not find Better Auth `apiKey()` mounted, API key
routes, or API key schema.

Decision needed: either implement Better Auth API keys, or remove that fallback
from docs and use OAuth, device flow, or a local bridge as the fallback story.

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
- No hand-editing JSON or TOML for common clients.
- No need for users to understand Streamable HTTP, OAuth metadata, DCR, or config
  file locations.
- Preserve enterprise and team workflows through PR-based project config.
- Keep auth secure and auditable.

## Non-Goals

- Do not replace the hosted `/mcp` server with a local-only MCP server.
- Do not make repo PRs the primary setup path.
- Do not add many new environment variables for install behavior.
- Do not build per-model docs pages as the long-term solution.

## Implementation Approach

1. Security prerequisite
   - Add org membership enforcement for `/mcp`.
   - Add tests proving non-members cannot access `orgSlug`.
   - Review org-scoped REST middleware for the same issue.

2. Auth clarity
   - Decide whether API keys are a supported MCP auth path.
   - If yes, add Better Auth API Key plugin, schema/migration, UI, and docs.
   - If no, update docs to say OAuth is primary and bridge/device flow is the
     fallback.

3. Installer package
   - Add `packages/mcp-install`.
   - Provide:

     ```bash
     npx -y @ctxpipe/mcp-install --org acme
     npx -y @ctxpipe/mcp-install --client claude --scope user
     npx -y @ctxpipe/mcp-install --dry-run
     ```

   - Use an adapter registry per client:
     - Claude Code: native `claude mcp add --transport http ...`.
     - Codex: native `codex mcp add ... --url ...`.
     - Cursor: global or project `mcp.json`, later Add to Cursor link.
     - VS Code/Copilot: `vscode:mcp/install` link or `.vscode/mcp.json`.
     - OpenCode: `opencode.json` with `type: "remote"`.

4. UI integration
   - Generate a personalized install command using the org slug.
   - Show detected or native commands as secondary options.
   - Keep "Install MCP via PRs" as an advanced/team option.

5. Docs simplification
   - One MCP setup page:
     - Recommended command.
     - Native commands.
     - Manual config.
     - Troubleshooting.
   - Move PR-based install to "Team-managed project config."

## Open Questions

- Should API keys be a real supported auth path for MCP, or should we avoid
  long-lived keys and lean fully into OAuth?
- Should the installer default to user/global scope or project scope? Proposed:
  user/global by default.
- Should we publish `@ctxpipe/mcp-install` publicly immediately, or keep it
  scoped/private until auth hardening lands?
- Do we want a local bridge package later for clients with weak OAuth support?

## Suggested Rollout

1. Fix membership enforcement and docs mismatch.
2. Ship installer for Claude Code, Codex, Cursor, and OpenCode.
3. Add VS Code install links and richer app UI.
4. Consider a local bridge for problematic clients.
5. De-emphasize PR install in onboarding while keeping it for team
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
