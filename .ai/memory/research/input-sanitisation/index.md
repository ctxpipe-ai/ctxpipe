# Input sanitisation posture (hardening backlog)

Research date: 2026-09-22  
Base: `origin/main` at `8d30bb29`  
Scope: how untrusted strings enter the product and reach sinks. Not a full authz or secrets review.

This note is prior art for a hardening pass. It is not an ADR.

## Question

Where does attacker-controlled input enter ctx|, what already stops it, and in what order should we close the remaining gaps?

## Attack surface (full stack)

Internet-facing (hosted backend origin):

| Surface | Who can hit it | Input shape |
|---|---|---|
| `/:orgSlug/api/v1/*` | Cookie / Bearer + org membership | Zod OpenAPI bodies, queries, path params |
| Connector admin routes | Same + admin/owner | git URLs, branches, titles, OAuth codes |
| `/mcp` | OAuth, cookie, org `x-api-key` | JSON-RPC; `ctx_advisor` prompt / conversation id |
| `/.auth/*` | Public + session | Better Auth, invite ids, `redirectTo`, DCR |
| `/api/v1/webhook/*` | Providers | Raw body + signature; then IDs, refs, clone URLs |
| LangSmith `/langsmith` | Anyone, if `ENABLE_LANGSMITH=true` | Graph runs, store, **truncate** |
| Public docs / OpenAPI / status | Anyone | None that mutate |

Internal (must stay private; Compose and Railway already treat them that way):

| Surface | Caller | Input shape |
|---|---|---|
| Codesearch HTTP | Backend JWT (`orgId` + audience) | Paths, Zoekt `Q`/`Opts`, git refs, clone URLs |
| Worker / OpenWorkflow | Backend enqueue | Repository and connector jobs |
| FalkorDB | Backend | Parameterized Cypher on a per-org graph |
| Postgres | Backend | Drizzle-bound SQL |

Untrusted **content** (not HTTP), later retrieved by Chat / `ctx_advisor`:

- GitHub repos (including the Repositories **Manual git** modal)
- Connector mirrors (Linear, Notion, Slack, Confluence, PagerDuty, PR comments)
- User chat / MCP prompts

## What is already solid

Do not spend the first sprint re-proving these.

- **SQL:** request-path `sql\`\`` is parameterized. `plainto_tsquery`, not `to_tsquery`. No user `sql.raw`.
- **Cypher:** no user Cypher API. Values are parameters. Labels/edge types pass `SAFE_CYPHER_IDENT` / predicate allowlists. Tenant = named graph.
- **Child processes:** `Bun.spawn` / `execFileSync` argv, not `sh -c`.
- **GET file:** `resolveSafeReadableFilePath` (lstat + realpath + regular file). Glob skips symlinks.
- **Connector assets:** ADR-028 HTTPS, DNS pin, private/metadata block, redirect re-check, size caps.
- **Webhooks:** GitHub / Slack / Notion / PagerDuty / Linear HMAC (Linear looks up tenant first, then verifies). Slack has skew.
- **Chat Markdown:** Streamdown (`rehype-sanitize` + `rehype-harden`). First-party UI has no `dangerouslySetInnerHTML`. Names/graph labels are React text.
- **Org scoping:** REST uses membership `orgId`. Advisor tools take org from ALS, not the model. Zoekt repo IDs are intersected with JWT org.
- **Instruction / ADR extractors** skip connector mirror prefixes (`isConnectorMirrorPath`).
- **Sign-out** already uses `safeAuthRedirectPath` (rejects `//` and `/\\`).

## Findings (verified)

### 1. LangSmith Studio is unauthenticated when enabled

`registerLangsmithRoutes` mounts the LangGraph API, including `POST /langsmith/internal/truncate`, with no auth (`apps/backend/src/routes/langsmith.ts`). Gate is `process.env.ENABLE_LANGSMITH === "true"` (lowercase only).

Hosted Railway Terraform sets `ENABLE_LANGSMITH=TRUE` (`infra/module/ctxpipe/railway.tf`). That does **not** match `"true"`, so production is accidentally off. PR deploys set `"false"`. If anyone “fixes” the case without adding auth, truncate and graph APIs are on the public origin.

### 2. Any org member can enqueue a clone of an arbitrary URL

`POST /:orgSlug/api/v1/repositories` is membership-auth only, not admin (`apps/backend/src/routes/v1/index.ts`, `repositories.ts`). Schema is `gitUrl: z.string().url()` — `https:`, `http:`, `file:`, `git:` all parse. The Repositories page **Manual git → Add single repository** posts that body (`AddRepositoryModal`).

Codesearch then `git clone`s the URL (`apps/codesearch/src/domain/indexing/phases.ts`). Tokens are only injected for `github.com`. There is no `protocol.file.allow=never`, no host allowlist, no reject of link-local / metadata.

That is worker SSRF plus “run SCIP indexers in a tree the attacker chose.”

### 3. `files-query` (the `get_file` path) follows symlinks

`GET /{repoId}/files/{path}` uses `resolveSafeReadableFilePath`. `POST /{repoId}/files-query` uses lexical `resolveSafePath` then `Bun.file()`, which follows links (`apps/codesearch/src/routes/repo.ts`). Backend `get_file` calls files-query (`apps/backend/src/tools/getFile.ts`).

`listFiles` skips symlink **entries**, but `readdir` of a symlink **directory** lists the target. Combined with (2), a repo containing `etc -> /etc` can leak host files into Chat / MCP.

`paths` has no max count or per-path length. Whole files are base64-encoded in memory.

### 4. Git refs can look like git options

`isGitRefOrShaSafe` only rejects ASCII controls. `targetHash` / `fromHash` / `branch` are passed as argv operands without `--` and without rejecting a leading `-` (`phases.ts`, `resolveRef.ts`). A value such as `-c core.sshCommand=…` is a git option, not a ref.

Callers today are mostly the worker with real SHAs. Still a sharp edge on a JWT-gated internal API.

### 5. Open redirects on auth and Atlassian return

`safeAuthRedirectPath` exists and is tested. Invite accept and sign-in / sign-up do **not** use it (`[.]auth.$authView.tsx`, `[.]auth.sign-in.tsx`). `window.location.assign(redirectTo)` takes the raw query.

Backend `safeReturnPath` rejects `//` but not `/\\`. Node `URL` resolves `new URL("/\\evil.com", AUTH_BASE_URL)` to `https://evil.com/`. Confirmed in this environment.

Email verification copies Better Auth `callbackURL` through unchanged (`verification-email-url.ts`).

### 6. Chat `source-url` hrefs skip Streamdown

`ConversationThread` puts `part.url` straight on `<a href>`. `javascript:` / `data:` become clickable if a source is ever persisted that way.

### 7. Almost no length or body caps

No Hono `bodyLimit` on backend or codesearch. MCP `prompt` / `conversationId` are `z.string()` with no max (`apps/backend/src/mcp/tools.ts`). Conversation names and client-chosen IDs are unbounded. Search `Q` is unbounded; Zoekt `Opts` is `z.record(z.string(), z.unknown())`. Knowledge-graph snapshot limits go to 500k nodes / 1M edges.

### 8. Confluence CQL is string-built

`q` has `"` / `*` stripped. `spaceKey` is interpolated raw into `space.key="…"` (`connectors-atlassian.ts`). Admin-only, but a quoted key changes the CQL using the org’s Atlassian token.

Stored `atlassianApiBaseUrl` is validated on FIT parse, then reused later without re-check (`atlassian-api-base-url.ts`).

### 9. Forge FIT has no app audience

`verifyForgeInvocationToken` checks JWKS only. Atlassian signs FITs for every Forge app. Lookup by `installationId` usually 202s a stranger, but there is no `app.id` allowlist.

### 10. Browser headers and popup origin

No CSP, `frame-ancestors`, `X-Content-Type-Options`, or `Referrer-Policy` on backend / UI / docs. GitHub setup `postMessage`s `*` and the opener does not check `event.origin` (`[.]github.setup.tsx`, `popup.ts`). Linear / PagerDuty already check origin.

### 11. Connector Markdown is trusted context

Mirrors persist provider bodies into the org git repo. Retrieval and `ctx_advisor` treat that as org knowledge. InstructionUnit / Decision extractors already skip those paths. The residual is **prompt injection via Linear/Slack/Notion/Confluence/PD**, which you cannot regex away without emptying the product.

### 12. Config foot-guns

CORS falls back to `origin: "*"` + `credentials: true` when `AUTH_ALLOWED_ORIGINS` is empty. MCP DCR is unauthenticated (needed for hosts; phishing / consent-screen risk). OpenAI proxy re-reads a passthrough body after Zod.

## Ordered fix sequence

Fix in this order. Earlier items are either live phishing, or they are the setup for host-file read / worker SSRF. Later items are defense in depth or product-trust work.

1. **Defuse LangSmith.** Do not mount `/langsmith` on a public origin. Require loopback or real auth. Do not “fix” Railway `TRUE` vs `"true"` until that lock exists.
2. **Allowlist clone URLs.** Accept GitHub HTTPS (and App-listed `clone_url`s) only. Reject `file:`, `http:`, `git:`, non-default ports, and link-local / metadata hosts. `git -c protocol.file.allow=never`.
3. **Make `files-query` (and directory list) symlink-safe.** Reuse `resolveSafeReadableFilePath`. Cap path count and file size. This is what `get_file` actually calls.
4. **Treat git refs as data.** Reject a leading `-`. Put `--` before user refs. Prefer SHA or `refs/heads/…`.
5. **Close open redirects.** Run every `redirectTo` / `returnTo` / email `callbackURL` through one helper at least as strict as `safeAuthRedirectPath`, then `new URL(path, origin)` and require same origin.
6. **Allowlist chat source links.** `http` / `https` only on `source-url` hrefs.
7. **Put lids on size.** Body / MCP payload limits. Max lengths on prompt, conversation id, name, branch, search query, org slug.
8. **Allowlist Zoekt `Opts`.** Known keys only; cap `Q`.
9. **Stop building CQL from raw keys.** Allowlist `spaceKey` charset. Re-validate stored Atlassian API bases on every fetch.
10. **Bind Forge FITs to our app.** Audience + expected `app.id`.
11. **Add browser security headers.** CSP, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`.
12. **Fix GitHub setup `postMessage`.** Target our origin; check `event.origin` on receive.
13. **Treat connector text as untrusted in advisor prompts.** Label / down-rank. Keep skipping InstructionUnit extraction. Do not try to “sanitize” issue bodies.
14. **Sandbox SCIP (or skip execution-heavy indexers on untrusted remotes).** Indexers run with `cwd` = checkout. A hostile `package.json` / `setup.py` / `build.rs` is RCE as the codesearch user. This is inherent to “compile their tree,” not a Zod miss.
15. **Hosted-SaaS authz polish.** Explicit CORS origins in non-dev. Revisit unauthenticated DCR. Cap OpenAI proxy request size.

## Threat-model notes (do not over-rank)

- Items 2–4 and 14 need an **org member** (or a hostile commit in a repo the org already indexes). They are still first-class: the product invites members to add git URLs, and `get_file` is on the advisor path.
- Item 1 is unauthenticated **if enabled**. Hosted prod is off by case mismatch today. Treat that as a landmine, not a live hole.
- Item 11 is the product working as designed. Fix trust labels, not Markdown stripping.
- SQL / Cypher / Streamdown / ADR-028 assets are not the weak layer.

## Sources

- `apps/backend/src/routes/langsmith.ts`, `apps/backend/src/app/app.ts`, `infra/module/ctxpipe/railway.tf`
- `apps/backend/src/routes/v1/repositories.ts`, `apps/backend/src/routes/v1/index.ts`
- `apps/ui/src/features/repositories/components/AddRepositoryModal.tsx`, `apps/ui/src/routes/$orgSlug.repositories.index.tsx`
- `apps/codesearch/src/domain/indexing/phases.ts`, `apps/codesearch/src/utils/git.ts`, `apps/codesearch/src/domain/indexing/scipIndexers.ts`
- `apps/codesearch/src/domain/repositories/paths.ts`, `apps/codesearch/src/routes/repo.ts`, `apps/backend/src/tools/getFile.ts`
- `apps/ui/src/lib/safe-auth-redirect.ts`, `apps/ui/src/routes/[.]auth.$authView.tsx`
- `apps/backend/src/routes/v1/org-atlassian-oauth.ts`, `apps/backend/src/auth/verification-email-url.ts`
- `apps/ui/src/features/chat/ConversationThread.tsx`
- `apps/backend/src/mcp/tools.ts`, `apps/codesearch/src/routes/search.ts`
- `apps/backend/src/routes/v1/connectors-atlassian.ts`, `apps/backend/src/lib/atlassian-api-base-url.ts`
- ADR-006, ADR-028, `apps/docs/content/docs/self-hosting/(operations)/production-readiness.mdx`
