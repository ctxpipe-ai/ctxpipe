# ADR-030: Organization-owned MCP API keys

**Status:** Accepted (amended 2026-09-22) | **Date:** 2026-09-14 | **Tags:** mcp, auth, api-keys, better-auth, organizations

## Context

MCP clients that cannot complete browser OAuth (CI, headless agents, shared GUI
env, static-header setups) already have **user-owned** Better Auth API keys
(`x-api-key`, `enableSessionForAPIKeys`). Those keys impersonate the minting
member: they require `?orgSlug=`, authenticate REST as that user, and die or
keep impersonating if the member leaves.

An organization-level key must be the non-interactive twin of a bound OAuth
grant ([ADR-026](ADR-026-claude-plugin-mcp-distribution.md)): one org per
credential, no person in the loop. Better Auth 1.6 only mocks a session for
**user-owned** keys, so a true org key cannot reuse `withCookieAuth` →
`requireAuth` (needs `user` + `session`) → `ctx_advisor`
(`requireCurrentUserId()`).

OAuth remains the laptop default. The Claude plugin, GitHub “Install MCP via
PRs” wizard, and CLI without `--auth` stay OAuth-only.

CodeRabbit accepts one `Authorization: Bearer` credential for a remote MCP
server but cannot set the custom `x-api-key` header. Supporting it requires a
narrow compatibility path without turning API keys into general REST bearer
credentials or allowing an API key to shadow a valid OAuth access token.

## Decision

1. **True org-owned keys.** Better Auth `apiKey()` registers two configs:
   - `configId: "default"`, `references: "user"`, `enableSessionForAPIKeys: true`
     (existing personal keys; do not migrate `referenceId`).
   - `configId: "organization"`, `references: "organization"`,
     `enableSessionForAPIKeys: false`. `referenceId` is the organization id.
   No parallel `apikeys` table. No new operator env vars.

2. **Org principal, not a fabricated member.** When `x-api-key` verifies as
   `configId: "organization"` and there is no user session, set
   `orgApiKey: { id, orgId, configId }` and leave `user` / `session` null.
   `requireAuth` allows `/mcp` with that principal. Org keys never satisfy
   `requireOrgAdminOrOwner` (dashboard mint stays session-based).

3. **MCP-only, including Bearer compatibility.** An org key on any non-`/mcp`
   path is **401**. User keys still authenticate REST as that user only through
   `x-api-key`; REST Bearer authentication remains OAuth-only. On `/mcp`,
   `Authorization: Bearer` is resolved as OAuth first: JWT-shaped credentials
   follow JWT verification, and opaque credentials are looked up as OAuth
   access tokens before any API-key check. Only an unrecognised opaque MCP
   Bearer falls back to personal/org API-key verification. This supports hosts
   such as CodeRabbit without broadening REST access or changing OAuth
   precedence. When both headers are present, the Bearer credential is resolved
   before `x-api-key` or cookie authentication, so a second API-key header
   cannot reject or shadow a valid OAuth token.

4. **One org per key.** Resolve tenant from `orgApiKey.orgId` with no membership
   join. Bare `/mcp` is enough. Query `orgSlug` is optional; mismatch is **404**.
   User keys still require `?orgSlug=` and membership. Bound OAuth grants are
   unchanged (slug cannot override).

5. **Advisor is org-service.** `currentMcpActor()` is
   `{ type: "org-service"; orgId }` or `{ type: "user"; userId }`. Org-service
   `ctx_advisor` threads use `${orgId}_org_${slugify(project)}_${conversationId}`
   and insert conversations with **`userId` null**. No bot user row, no creator
   stamp. Product chat list stays per signed-in user; admin/owner may filter
   **MCP service** (`source=mcp` AND `userId IS NULL`). Langfuse tags include
   `mcp-org-key`.

6. **Who mints.** Organization plugin access control: owner and **admin** get
   `apiKey: ["create","read","update","delete"]`; members get none. Keys are
   named, many per org. Secret shown once. Same limits as user keys: 30-day
   default expiry (`expiresIn: null` allowed with a UI warning), 1,000
   req/hour, policy in plugin config.

7. **Clients.** Same env name `CTXPIPE_API_KEY` for user and org keys (one
   active key per process). CLI `--auth api-key` interpolates that env into
   `x-api-key` and still sends `?orgSlug=` (org keys accept a matching slug).
   Hosts that cannot set custom headers may send the key as Bearer to `/mcp`;
   clients that support `x-api-key` should continue using it. Mint org keys in
   Organisation settings; personal keys stay under User account. Do not change
   the Claude plugin `.mcp.json` or the GitHub PR wizard.

## Consequences

- Machines authenticate the organization, not the minter. Creator leaving the
  org does not revoke the key; deleting the org still purges org data.
- Org-key traffic cannot call REST. Automating REST still needs a user key or
  a future scope decision.
- Chat UI must treat null-`userId` MCP threads as service conversations, not
  as a member's personal list.
- Bearer-only MCP hosts can use API keys, but the fallback is intentionally
  absent from REST and runs only after OAuth resolution fails.
- Self-host uses the same Better Auth rows in that deployment's DB; no extra
  operator secret.

## Alternatives considered

- **Admin user key locked to one org (metadata / slug bind).** Rejected: the
  key dies or impersonates when that admin leaves, so it is not org-level.
- **Fabricate a member session for org keys (`enableSessionForAPIKeys`).**
  Impossible for `references: "organization"` in Better Auth 1.6; also would
  impersonate someone.
- **Stamp the creating admin, or a dedicated org bot user, as `ctx_advisor`
  actor.** Rejected: still a person (or fake person) on every service thread.
- **Org-key REST (read-only or full).** Deferred until someone asks; MCP-only
  limits blast radius.
- **Try API keys before OAuth for `Authorization: Bearer`.** Rejected: an API
  key could shadow an opaque OAuth token. The amended decision keeps OAuth
  first and permits API-key fallback only for an unrecognised opaque token on
  `/mcp`.
- **Accept Bearer API keys on REST.** Rejected: the CodeRabbit constraint is
  MCP-specific and does not justify broadening API-key authority.
- **Convert existing user keys / drop personal keys.** Rejected: two configs;
  existing `configId: "default"` rows stay user-owned.
- **Split env names for user vs org keys.** Rejected: one process, one active
  key. Same `CTXPIPE_API_KEY`.
- **Change Claude plugin or GitHub PR wizard in v1.** Rejected: those paths
  stay OAuth-on-purpose; machines that cannot OAuth use CLI interpolation.
