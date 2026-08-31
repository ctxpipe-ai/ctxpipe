# ADR-026: Claude plugin for hosted MCP distribution

**Status:** Accepted | **Date:** 2026-08-28 | **Tags:** mcp, claude, plugins, slack, distribution

## Context

Customers currently install ctx| MCP by pasting a per-organization URL
(`https://app.ctxpipe.ai/mcp?orgSlug=…`) or by writing client config through the
CLI and GitHub PRs. That works for Claude Code on a laptop. It does **not**
work for Claude Tag channels in Slack: those surfaces ignore a repo `.mcp.json`
and ignore a user's personal claude.ai custom connector. They only load plugins
attached to an Access bundle, plus a host credential.

Custom connectors are **not** being removed from claude.ai. The Slack gap is
Tag's admin-governed model, not a global MCP sunset. Cursor, Codex, and
CodeRabbit marketplaces are separate formats and are out of scope.

A marketplace plugin that still embeds `?orgSlug=acme` cannot be one artifact
for every tenant. Claude Tag also does not document `userConfig` substitution,
so `${user_config.org_slug}` in the URL is unsafe for Slack.

Research: [Claude plugins](../research/claude-plugins/index.md).

## Decision

1. **Ship one Claude plugin** at `plugins/ctxpipe` (manifest, `.mcp.json`,
   `ctx-advisor` skill) and list it from the repo marketplace at
   `.claude-plugin/marketplace.json`. Install path:
   `/plugin marketplace add ctxpipe-ai/ctxpipe` then
   `/plugin install ctxpipe@ctxpipe`.
2. **Point the plugin at** `https://app.ctxpipe.ai/mcp` with `type: "http"`.
   No tokens and no `${user_config.*}` interpolation in the URL. OAuth stays
   DCR/CIMD as today.
3. **Bind organization during OAuth:** Better Auth's post-login step prompts
   users with multiple memberships to select an organization before consent.
   The organization id is stored as the grant `referenceId`, carried across
   refreshes, and added to JWT access tokens as the namespaced
   `https://ctxpipe.ai/organization_id` claim.
4. **Enforce that binding on `/mcp`:** bound JWT and opaque tokens resolve only
   their selected organization. A query slug cannot override a bound grant.
   Legacy/manual clients may still use `?orgSlug=`; an unbound account with one
   membership remains unambiguous.
5. **Defer** Connectors Directory submission, `custom_connection`, MCPB desktop
   extensions, and Cursor/Codex/CodeRabbit listings.
6. **Claude Tag customers** attach the plugin on the Access bundle and add an
   MCP Connector credential for `app.ctxpipe.ai`. Document that the agent acts
   as the admin identity.

## Consequences

- Slack Tag becomes a documented install path without a per-company MCP URL.
- Multi-org users choose the grant organization during OAuth. Later browser
  organization switches do not retarget Claude.
- Self-host operators fork `.mcp.json` to their origin.
- Directory listing and Anthropic review remain a later, out-of-band step.
- The plugin is not a substitute for `npx ctxpipe init` on Cursor/Codex/VS Code.

## Alternatives considered

- **Keep requiring `?orgSlug=` and ship per-tenant plugin copies.** Rejected as
  the default; that is the scaling problem. Admins can still bake a slug into a
  fork.
- **`userConfig.org_slug` in the MCP URL.** Fine for Claude Code; undocumented
  on Tag and would send a literal `${user_config.org_slug}` if unsubstituted.
- **MCPB desktop extension.** Wrong shape for a hosted remote MCP.
- **Expand to Cursor/Codex marketplaces in the same change.** Separate review
  queues; do not block Slack.
