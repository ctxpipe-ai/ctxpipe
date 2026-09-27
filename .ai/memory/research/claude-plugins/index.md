# Claude plugins for distributing ctxpipe MCP

Date: 2026-08-28

Primary-source survey of Anthropic's 2026 plugin, connector, and Slack surfaces, for shipping the hosted Streamable HTTP MCP at `https://app.ctxpipe.ai/mcp?orgSlug=ORG`. Every claim below cites a first-party page, schema, or Anthropic GitHub artifact.

## Executive summary

Ship one generic remote MCP plugin, then submit it through two complementary
catalog paths:

1. **Claude Plugin Directory** (packaging + discovery): a public plugin with `.claude-plugin/plugin.json`, a root `.mcp.json` pointing at `https://app.ctxpipe.ai/mcp`, and a short skill that teaches Claude when to call `ctx_advisor`. The server binds the selected ctx| organization into the OAuth grant, avoiding `userConfig` and per-tenant plugin copies. The same plugin layout is consumed by Claude Code, Cowork, and Claude Tag. ([Plugins overview](https://claude.com/docs/plugins/overview.md); [Plugins reference](https://code.claude.com/docs/en/plugins-reference); [Claude Tag custom MCP](https://claude.com/docs/claude-tag/admins/connections/custom); [Better Auth post-login organization selection](https://better-auth.com/docs/plugins/oauth-provider#post-login-screen))

2. **Connectors Directory** (connector-first discovery for claude.ai / Desktop / mobile): list the same generic MCP URL. Directory connectors and custom URL connectors share the same runtime; the directory adds review, browse, and Suggested Connectors. ctx| no longer needs partner-gated `custom_connection` solely for tenant routing because organization selection occurs during OAuth. ([Directory vs custom](https://claude.com/docs/connectors/building/directory-vs-custom); [Authentication](https://claude.com/docs/connectors/building/authentication.md))

**Do not treat “Claude plugin” as one product.** In 2026 Anthropic uses the same word for three related but distinct things: Claude Code / Cowork plugin packages, Claude Desktop MCPB/DXT extensions, and the Claude plugin marketplace / directory. Slack `@Claude` (Claude Tag) is a fourth surface that **reuses the Claude Code plugin format** but **does not load a repo `.mcp.json` or a user's personal claude.ai connectors**. ([What to build](https://claude.com/docs/connectors/building/what-to-build.md); [Desktop extensions](https://claude.com/docs/connectors/custom/desktop-extensions); [Claude Tag settings map](https://claude.com/docs/claude-tag/concepts/settings-map.md); [Skills repo / MCP](https://claude.com/docs/claude-tag/admins/skills-repo))

**Customer Slack problem is real and official.** In Claude Tag channels, Claude reaches external services only through admin Access-bundle connections and attached plugins. A custom MCP URL the user pasted into claude.ai does not apply in the channel. The documented pattern is: plugin `.mcp.json` (declares the server) **plus** a Custom-tool credential on the bundle (lets the call leave the sandbox). ([For Claude Code users](https://claude.com/docs/claude-tag/concepts/for-claude-code-users); [Add a custom MCP server](https://claude.com/docs/claude-tag/admins/connections/custom#add-a-custom-mcp-server))

**Custom connectors are not being phased out on claude.ai.** Anthropic still documents manual URL add on every paid plan (Free: one custom connector). What *is* being deprecated is the earlier per-user Claude in Slack app (“Legacy”) for Team/Enterprise, in favor of Claude Tag. That deprecation is about Slack identity and setup, not about remote MCP itself. ([Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp); [Verification — directory is optional](https://claude.com/docs/connectors/verification.md); [Migrate from earlier Slack](https://claude.com/docs/claude-tag/admins/migrate-from-earlier.md))

## 1. What a “Claude plugin” is in 2026

### Claude Code plugins

A **plugin** is a self-contained directory of components that extends Claude Code: skills, agents, hooks, MCP servers, LSP servers, and monitors. The optional manifest lives at `.claude-plugin/plugin.json`. If omitted, Claude Code auto-discovers default folders and derives the name from the directory. ([Plugins reference](https://code.claude.com/docs/en/plugins-reference))

Distribution is via a **marketplace**: a catalog file at `.claude-plugin/marketplace.json` that lists plugins and their sources. Users add a marketplace (`/plugin marketplace add`) and install plugins (`/plugin install name@marketplace`). The official catalog is `claude-plugins-official`, auto-available in Claude Code. ([Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces); [Submitting your plugin](https://claude.com/docs/plugins/submit))

Plugins originated in Claude Code and are the technical source of truth for structure. Cowork and Claude.ai plugin docs defer to the Claude Code reference. ([Plugins overview](https://claude.com/docs/plugins/overview.md); [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude))

### Claude Desktop extensions (MCPB / DXT)

**Desktop extensions** are a different packaging path: local MCP servers bundled as **MCPB** (MCP Bundles) for Claude Desktop. They target local files/tools, offline use, and enterprise MDM-style deploy. Anthropic's glossary tells Claude Code readers to look at the Help Center for “desktop extension, MCPB, and DXT.” Claude Code does **not** natively consume `.mcpb` / `.dxt` files; it uses its own plugin directory. Unrecognized `plugin.json` fields are ignored, so one file can also carry MCPB/DXT or VS Code/Cursor metadata. ([Desktop extensions](https://claude.com/docs/connectors/custom/desktop-extensions); [Glossary](https://code.claude.com/docs/en/glossary.md); [Unrecognized fields](https://code.claude.com/docs/en/plugins-reference))

ctxpipe's hosted remote MCP is **not** a desktop-extension use case. Anthropic's own table recommends remote MCP for internet-hosted services and public APIs. ([Desktop vs remote](https://claude.com/docs/connectors/custom/desktop-extensions))

### Claude.ai / Cowork plugins

On claude.ai and Claude Desktop Chat, a plugin is the same file-based package, surfaced through **Customize → Plugins**. Paid plans (Pro, Max, Team, Enterprise). Skills work in web chat, Desktop Chat, and Cowork. Hooks and sub-agents run only in Cowork (grayed out in chat). Plugins can bundle connectors so the matching MCP is connected as part of install. ([Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude); [Plugins overview](https://claude.com/docs/plugins/overview.md))

Cowork's own install guide says plugins are available in **Cowork and Code** and “aren't used in Chat.” That conflicts with the Help Center and org-admin pages, which say distributed plugins appear in web chat and Desktop Chat as well as Cowork, with skills working across all three. Treat skills-in-chat as documented by the Help Center; treat hooks/agents as Cowork-only. ([Install plugins](https://claude.com/docs/cowork/guide/plugins.md); [Manage plugins](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization))

Team/Enterprise owners distribute plugins from **Organization settings → Plugins**: Anthropic-built marketplaces (Knowledge Work is default), ZIP upload (≤ 50 MB, ≤ 100 plugins per manual marketplace), or GitHub-synced private/internal repo. Installation preferences: Installed by default, Available, Required, Not available. Enterprise can override per group. Cowork and Skills must both be enabled first. ([Manage plugins](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization))

### Anthropic plugin marketplace / directories

There are **two public directories**, complementary and separate:

| Directory | What it lists | Surfaces | Submission |
| --- | --- | --- | --- |
| **Claude plugin directory** (`claude.com/plugins-for/cowork`, marketplace `claude-plugins-official`) | Plugins (skills + optional MCP + commands + agents) | Cowork and Claude Code; org distribution also reaches chat per Help Center | Public GitHub repo via [claude.ai plugin form](https://claude.ai/admin-settings/directory/submissions/plugins/new) or [Console](https://platform.claude.com/plugins/submit). Automated review; “Anthropic Verified” is extra. ([Submit plugin](https://claude.com/docs/plugins/submit)) |
| **Connectors Directory** (`claude.ai/directory/connectors/SLUG`) | Remote MCP servers (and separately MCPB desktop extensions, MCP Apps) | Claude.ai, Desktop, mobile, Cowork, Claude Code | Team/Enterprise org portal for remote MCP; separate form for MCPB. ([Submission](https://claude.com/docs/connectors/building/submission.md)) |

Publishing to the open [MCP Registry](https://registry.modelcontextprotocol.io) or `modelcontextprotocol/servers` does **not** surface a server in Claude. ([What the directory is not](https://claude.com/docs/connectors/building/directory-vs-custom))

Anthropic's partner recommendation: ship **remote MCP with OAuth first**, then a **plugin with skills** that wraps it. An MCP server works on every Claude surface; a plugin works in Claude Code and Cowork (plus chat skills, per Help Center). If the plugin's MCP URL is already a directory connector, Claude shows one tool set. If it is not, the connector appears as **Custom**. ([What to build](https://claude.com/docs/connectors/building/what-to-build.md))

### Slack / Claude Tag

**Claude Tag** (public beta) is the current Slack product for Team/Enterprise: one org-level agent identity, admin-governed Access bundles, `@Claude` in channels. It is the same Slack app handle as the earlier per-user “Claude in Slack,” not a second app. ([Migrate](https://claude.com/docs/claude-tag/admins/migrate-from-earlier.md); [Slack connector page](https://claude.com/docs/connectors/slack/index.md))

Claude Tag plugins use the **Claude Code plugin marketplace layout**. They attach to an Access bundle or a channel scope. A cloned repo's `.mcp.json` is **not** loaded. ([Skills repo](https://claude.com/docs/claude-tag/admins/skills-repo); [For Claude Code users](https://claude.com/docs/claude-tag/concepts/for-claude-code-users))

DMs with Claude in Slack still run on the user's own claude.ai account and **can** use that user's personal connectors. Channels cannot. ([Settings map](https://claude.com/docs/claude-tag/concepts/settings-map.md))

Claude Code's earlier Slack integration remains the setup path on **Pro and Max**; Anthropic is retiring it for Team and Enterprise in favor of Claude Tag. ([Claude Code Slack](https://code.claude.com/docs/en/slack.md) via [llms.txt](https://code.claude.com/docs/llms.txt))

## Surface matrix

| Surface | Loads a Claude Code plugin? | Can add a custom remote MCP URL? | How ctxpipe would reach it | Notes |
| --- | --- | --- | --- | --- |
| **Claude Code CLI / VS Code / JetBrains / Desktop Code** | Yes — marketplace, `--plugin-dir`, skills-dir, org managed | Yes — `claude mcp add`, `.mcp.json`, plugin `.mcp.json`, claude.ai connectors if allowed | Plugin + OAuth DCR/CIMD | Install scopes: user / project / local / managed. ([Install scopes](https://code.claude.com/docs/en/plugins-reference); [MCP](https://code.claude.com/docs/en/mcp)) |
| **Cowork** | Yes — marketplace, ZIP, org GitHub sync | Yes — custom connector, brokered from Anthropic cloud | Plugin (skills + MCP ref) and/or directory/custom connector | Remote connectors egress from Anthropic IPs, not the laptop. Local MCP in a plugin runs on the machine. ([Use plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude); [Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp)) |
| **claude.ai web chat** | Skills from installed plugins (Help Center); Cowork guide says plugins unused in Chat | Yes — Customize → Add custom connector (Owners add org-wide on Team/Enterprise) | Directory listing, custom-connector install link, and/or plugin-bundled connector | Free: one custom connector. ([Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp); [Use plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)) |
| **Claude Desktop Chat tab** | Same as web chat for skills | Yes — same custom-connector path (cloud-brokered). Local MCP via `claude_desktop_config.json` or MCPB is a **separate** mechanism and is not available in Cowork or claude.ai | Prefer remote MCP, not MCPB | ([Help Center custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp); [Desktop extensions](https://claude.com/docs/connectors/custom/desktop-extensions)) |
| **Claude mobile** | Not documented as a plugin host | Yes — same remote connectors (cloud-brokered) | Directory or custom connector | ([Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp)) |
| **Slack channels (`@Claude` / Claude Tag)** | Yes — only if attached to the Access bundle or scope | **Not as a user-pasted URL.** Admin adds a plugin `.mcp.json` **and** a Custom-tool credential for the host | Dedicated plugin + bundle credential | Personal claude.ai connectors never apply in channels. Repo `.mcp.json` ignored. ([Custom MCP](https://claude.com/docs/claude-tag/admins/connections/custom); [Settings map](https://claude.com/docs/claude-tag/concepts/settings-map.md)) |
| **Slack DMs with Claude** | No channel plugins | Yes — user's personal claude.ai connectors | Custom connector on the user's account | ([Settings map](https://claude.com/docs/claude-tag/concepts/settings-map.md)) |
| **Legacy Claude in Slack (per-user)** | Used the user's own connectors | Yes, via the linked claude.ai account | Same as personal connectors | Being deprecated on Team/Enterprise. ([Migrate](https://claude.com/docs/claude-tag/admins/migrate-from-earlier.md)) |
| **Claude Code on the web / cloud sessions** | Synced plugins from the claude.ai account (`@synced`) | Plugin MCP + connectors | Plugin enabled on claude.ai | ([Synced plugins](https://code.claude.com/docs/en/plugins-reference)) |
| **Claude for M365 / Science / Government** | Separate product docs; out of v1 scope | Custom MCP exists on Science and Government | Do not block on these | ([llms.txt](https://claude.com/docs/llms.txt)) |

Anthropic's own “works in” table: MCP server → Claude.ai, Desktop, mobile, Cowork, Claude Code. Plugin → Claude Code, Cowork. ([What to build](https://claude.com/docs/connectors/building/what-to-build.md))

## 2. Official plugin manifest schema

JSON Schema (generated 2026-04-23 from Claude Code Zod defs, hosted on SchemaStore):

- Plugin: `https://json.schemastore.org/claude-code-plugin-manifest.json`
- Marketplace: `https://json.schemastore.org/claude-code-marketplace.json`

([SchemaStore URLs](https://github.com/anthropics/claude-code/issues/9686); [Plugins reference `$schema`](https://code.claude.com/docs/en/plugins-reference))

### `.claude-plugin/plugin.json`

If a manifest is present, **`name` is the only required field** (kebab-case identifier). ([Required fields](https://code.claude.com/docs/en/plugins-reference))

| Field | Required | Role |
| --- | --- | --- |
| `name` | Yes if manifest exists | Unique kebab-case id; namespaces skills/agents (`plugin:skill`) |
| `displayName` | No | Human label in pickers |
| `version` | No | Semver. If set, users only get updates when it changes (except `command` sources) |
| `description` | No | Marketplace display |
| `author` | No | `{ name, email?, url? }` |
| `homepage`, `repository`, `license`, `keywords` | No | Metadata |
| `mcpServers` | No | Path, array of paths, or inline MCP config |
| `userConfig` | No | Prompted values at enable time; substitutable as `${user_config.KEY}` |
| `skills`, `commands`, `agents`, `hooks`, `lspServers`, `channels`, `dependencies` | No | Component paths or inline |
| `defaultEnabled` | No | `false` ships installed-but-off (v2.1.154+) |
| `$schema` | No | Editor only; ignored at load |
| `metadata` | No | Free-form; Claude Code does not read it |

Org-admin naming: plugin names are lowercase hyphenated words, max 64 characters. Reserved marketplace names include `claude-plugins-official`, `anthropic-marketplace`, `life-sciences`, and others. ([Naming rules](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization); [Reserved marketplace names](https://code.claude.com/docs/en/plugin-marketplaces))

### `.claude-plugin/marketplace.json`

Minimum: `name`, `owner`, `plugins[]` where each plugin has `name` + `source`. Plugin entries may also carry any plugin-manifest field plus `source`, `category`, `tags`, `strict`, `relevance`, `headers`, `headersHelper`. ([Marketplace schema](https://code.claude.com/docs/en/plugin-marketplaces))

`strict` (default `true`): `plugin.json` is authoritative and the marketplace entry merges with it. `strict: false`: the marketplace entry **is** the whole definition. ([Strict mode](https://code.claude.com/docs/en/plugin-marketplaces))

Plugin `source` types in Claude Code: relative path, `github`, `url`, `git-subdir`, `npm`, `archive` (HTTPS zip, v2.1.224+), `command` (v2.1.229+). ([Plugin sources](https://code.claude.com/docs/en/plugin-marketplaces))

Organization GitHub-synced marketplaces are narrower: relative paths, `github`, `url`, `git-subdir` only. No `npm`, `archive`, or `command`. Public repos are **not** allowed for org marketplaces (private or internal only). ([Manage plugins](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization))

Official catalog example (Anthropic): [`anthropics/claude-plugins-official` `.claude-plugin/marketplace.json`](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json) — `$schema` `https://anthropic.com/claude-code/marketplace.schema.json`, `name: "claude-plugins-official"`.

### How remote MCP is declared in a plugin

**Location:** `.mcp.json` at plugin root (recommended) or inline `mcpServers` in `plugin.json`. Format is standard Claude Code MCP config. ([MCP servers](https://code.claude.com/docs/en/plugins-reference))

**Remote HTTP (Streamable HTTP) — the ctxpipe shape:**

```json
{
  "mcpServers": {
    "ctxpipe": {
      "type": "http",
      "url": "https://app.ctxpipe.ai/mcp?orgSlug=${user_config.org_slug}"
    }
  }
}
```

`${user_config.KEY}` substitutes into MCP `http`/`sse`/`ws` `url`, `headers`, and `headersHelper`. ([Environment variables](https://code.claude.com/docs/en/plugins-reference); [User configuration](https://code.claude.com/docs/en/plugins-reference))

OAuth for a plugin-declared remote MCP is **not a manifest field**. Claude Code discovers it from the server origin (RFC 9728 protected-resource metadata → RFC 8414 AS metadata). DCR is client-driven on first use. A first-party issue against the official plugin-dev skill states a hosted OAuth MCP needs only `{ type, url }`; `sse` is legacy; there is no `oauth` / discovery-URL field. ([Issue #2196](https://github.com/anthropics/claude-plugins-official/issues/2196); [Authentication](https://claude.com/docs/connectors/building/authentication.md))

Static token auth uses `headers` (or beta `static_headers` / request headers on custom connectors). Do **not** put access tokens in the URL query string — the MCP authorization spec prohibits that, and Anthropic calls it a leak vector. `orgSlug` as a routing query is not a token, but keep credentials out of the URL. ([Authentication](https://claude.com/docs/connectors/building/authentication.md))

First-party shipped example (Context7, in the official marketplace):

```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "Authorization": "${CONTEXT7_API_KEY:-}"
      }
    }
  }
}
```

([`external_plugins/context7/.mcp.json`](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/external_plugins/context7/.mcp.json); [`plugin.json`](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/external_plugins/context7/.claude-plugin/plugin.json))

Caveat: Anthropic's in-repo `mcp-integration` skill still presents SSE as the OAuth transport and HTTP as “token auth.” That skill is **known outdated** relative to current Claude Code (`type: "http"` + auto OAuth). Prefer the plugins-reference + issue #2196 shape for new work. ([mcp-integration skill](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/plugin-dev/skills/mcp-integration/SKILL.md); [Issue #2196](https://github.com/anthropics/claude-plugins-official/issues/2196))

### `userConfig` (org slug, base URL, secrets)

Prompted when the plugin is enabled. Types: `string`, `number`, `boolean`, `directory`, `file`. `sensitive: true` masks input and stores in Keychain / `~/.claude/.credentials.json` instead of `settings.json`. Values export as `CLAUDE_PLUGIN_OPTION_*`. Non-sensitive values live under `pluginConfigs` in user / `--settings` / managed settings only — **project `.claude/settings.json` is ignored** so a cloned repo cannot inject hook/MCP values. ([User configuration](https://code.claude.com/docs/en/plugins-reference))

There is **no first-party `userConfig` documented for Claude Tag or claude.ai plugin install**. Tag tenancy is admin-side (fixed URL in the plugin + credential on the bundle). Directory per-tenant URLs use partner `custom_connection`. That is the main gap for a single artifact serving Slack + Code + directory.

## 3. Slack Tag implications

### What Slack Claude is now

- **Claude Tag** (public beta): admin-provisioned agent in channels; `@Claude` handle kept. ([Migrate](https://claude.com/docs/claude-tag/admins/migrate-from-earlier.md))
- **Legacy Claude in Slack**: per-user linked claude.ai account and that user's connectors. Team/Enterprise workspaces are being moved off it; after the account-team cutover date, scopes still on Legacy stop responding. ([Migrate warning](https://claude.com/docs/claude-tag/admins/migrate-from-earlier.md); [Claude Code Slack](https://code.claude.com/docs/en/slack.md))
- **Slack connector** (separate): lets Claude **on claude.ai** search the Slack workspace. Installing Claude in Slack is a prerequisite. This is not how you add ctxpipe *into* Slack. ([Slack integration](https://claude.com/docs/connectors/slack/index.md))

### Custom / bespoke MCP in Slack channels

Official, explicit constraints:

1. **A repository `.mcp.json` is not loaded** when Claude Tag clones a granted repo. MCP must live in an attached plugin, next to `.claude-plugin/plugin.json`. ([Skills repo](https://claude.com/docs/claude-tag/admins/skills-repo); [For Claude Code users](https://claude.com/docs/claude-tag/concepts/for-claude-code-users))
2. **Personal claude.ai connectors never apply in channels.** Channel access is only the admin Access bundle. Slack itself has no connector settings. ([Settings map](https://claude.com/docs/claude-tag/concepts/settings-map.md); [Customize](https://claude.com/docs/claude-tag/admins/customize.md))
3. **Custom MCP pattern is plugin + credential.** Plugins tab (or skills repo): `.mcp.json` with the server URL. Credentials tab: Custom tool, typically Bearer, **Allowed websites** = MCP host (e.g. `app.ctxpipe.ai`). The plugin tells Claude the server exists; the credential lets the call leave the default-deny sandbox. ([Add a custom MCP server](https://claude.com/docs/claude-tag/admins/connections/custom#add-a-custom-mcp-server))
4. **Credential types** include Bearer, Basic, Body parameter, AWS SigV4, GCP tokens, OAuth 2.0 JWT bearer, OAuth 2.0 client credentials, and **MCP Connector** (“OAuth sign-in. Sign in once as an admin; the agent acts as that account.”). ([Credential types](https://claude.com/docs/claude-tag/admins/connections/custom))
5. Plugins from a skills repo or ZIP land in the org catalog **off** until toggled on a bundle or added on a scope. ([Attach plugins](https://claude.com/docs/claude-tag/admins/add-connections); [Upload zip](https://claude.com/docs/claude-tag/admins/skills-repo))
6. Channel members can add plugins on the channel Configure page unless an admin restricts editing. ([Settings map](https://claude.com/docs/claude-tag/concepts/settings-map.md))

So a company whose Slack Claude “cannot use a custom MCP URL” is hitting the Tag channel model, not a missing ctxpipe feature. They need an **admin-attached plugin** (and a host credential), not another paste into Customize → Connectors.

### How a customer would install ctxpipe on Slack Tag

1. Owner enables Cowork + Skills if they also want org plugin marketplaces; for Tag alone, use **Plugins** at `claude.ai/admin-settings/plugins` (GitHub sync of a private marketplace, or ZIP / `.plugin` upload ≤ 200 MB). ([Skills repo](https://claude.com/docs/claude-tag/admins/skills-repo); [Manage plugins](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization))
2. Attach the ctxpipe plugin on the Access bundle covering the channels.
3. Add a Custom-tool credential for `app.ctxpipe.ai` (or the self-host host). Prefer the **MCP Connector** credential type if they should OAuth as a service account; Bearer if they use a service token.
4. In a **new** thread: `@Claude use ctxpipe / ask ctx_advisor …`. Existing threads keep the set they started with. ([Attach plugins](https://claude.com/docs/claude-tag/admins/add-connections))

ctxpipe can ship a **public plugin repo** for Claude Code/Cowork directory, and a **copy or relative-path vendor** into the customer's private marketplace repo (org sync cannot pull arbitrary private third-party sources unless same GitHub owner or GHE app). ([External plugin source](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization))

## 4. How published plugins handle the hard parts

### Remote HTTP MCP + OAuth

| Layer | Mechanism | Source |
| --- | --- | --- |
| Claude Code plugin | `{ "type": "http", "url": "https://…" }` — OAuth auto-discovered; DCR or CIMD | [Issue #2196](https://github.com/anthropics/claude-plugins-official/issues/2196), [Auth](https://claude.com/docs/connectors/building/authentication.md) |
| Hosted Claude (web/Desktop/mobile/Cowork) custom connector | Paste URL; optional OAuth client id/secret; optional beta request headers | [Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp) |
| Directory connector | Same runtime; auth types: `oauth_dcr`, `oauth_cimd` (out of the box), `oauth_anthropic_creds` and `custom_connection` (email `mcp-review@anthropic.com`), `static_headers` (beta), `none` | [Auth types](https://claude.com/docs/connectors/building/authentication.md) |
| Claude Tag | Plugin URL + sandbox credential (Bearer or MCP Connector OAuth). Agent uses the **admin** identity, not each Slack user | [Custom](https://claude.com/docs/claude-tag/admins/connections/custom) |

Hosted surfaces register redirect `https://claude.ai/api/mcp/auth_callback`. Claude Code uses RFC 8252 loopback (`http://localhost/callback`, `http://127.0.0.1/callback`, port ignored). Claude Code does **not** use Anthropic-held directory credentials; it runs its own CIMD client. Pure machine `client_credentials` with no user is **not supported** on hosted Claude. Egress to the MCP and the AS is from `160.79.104.0/21`. Token/discovery timeouts: 10s (30s refresh). ([Auth](https://claude.com/docs/connectors/building/authentication.md))

Protected-resource `resource` must match the MCP URL **exactly as the user enters it, including path**. Query-string canonicalization (ctxpipe already strips `?orgSlug=` on the PRM audience) must stay aligned with whatever URL the plugin/directory listing uses. ([Auth](https://claude.com/docs/connectors/building/authentication.md); [MCPJam note](../mcp-testing/mcpjam.md))

### Per-organization / per-tenant configuration

Official options:

1. **OAuth grant reference (ctx| choice)** — after login, resolve a valid active membership or prompt when none is available. Show the organization on consent and let multi-org users change it through the signed OAuth continuation. Store that organization as the grant `referenceId` and expose a namespaced JWT claim. Refresh tokens retain the reference. This is Better Auth's documented organization-specific OAuth pattern and works behind one static MCP URL. ([Better Auth post-login organization selection](https://better-auth.com/docs/plugins/oauth-provider#post-login-screen))
2. **Plugin `userConfig`** — user types org slug and optional base URL at enable (Claude Code). Substituted into the MCP URL. Not documented on Tag/claude.ai plugin UI, so ctx| does not use it for hosted tenant routing. ([userConfig](https://code.claude.com/docs/en/plugins-reference))
3. **Directory `custom_connection`** — users supply a tenant URL at connect time. Partner-gated. Directory does not template `{tenant}.example.com` in one listing. This remains relevant for providers that cannot bind tenancy during OAuth, not hosted ctx|. ([Per-tenant URLs](https://claude.com/docs/connectors/building/directory-vs-custom))
4. **Custom connector URL** — Owner pastes a generic or explicitly scoped URL org-wide; members Connect. Install links can prefill name + URL. ([Directory vs custom](https://claude.com/docs/connectors/building/directory-vs-custom); [Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp))
5. **Claude Tag** — one generic URL is baked into the attached plugin. An MCP Connector credential performs the one-time admin OAuth flow and binds the selected ctx| organization.

Self-host base URLs still require a customer-private plugin fork or manual
connector because the host itself differs.

### User vs team vs workspace install

| Product | Install grain |
| --- | --- |
| Claude Code | `user` (`~/.claude/settings.json`), `project` (committed `.claude/settings.json`), `local` (gitignored), `managed` (admin, read-only). ([Scopes](https://code.claude.com/docs/en/plugins-reference)) |
| Cowork / claude.ai | Personal install; Team/Enterprise org marketplace with default / available / required / hidden; Enterprise group overrides (most-permissive wins — **not** a security boundary). ([Manage plugins](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization)) |
| Custom connectors | Team/Enterprise: Owner adds URL; each member still clicks Connect (user-scoped OAuth). ([Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp)) |
| Directory connectors | One shared OAuth app per connector; no per-org OAuth client. Custom connectors *can* take org-scoped static client id/secret. ([Enterprise auth](https://claude.com/docs/connectors/building/authentication.md)) |
| Claude Tag | Org Owner + Access bundle + optional per-channel/scope attach. Not per Slack user in channels. DMs = personal connectors. ([Settings map](https://claude.com/docs/claude-tag/concepts/settings-map.md)) |

### Secrets / env vars

- Plugin `userConfig.sensitive` → Keychain / credentials file (~2 KB Keychain budget shared with OAuth tokens). ([userConfig](https://code.claude.com/docs/en/plugins-reference))
- Env substitution `${VAR}` in `.mcp.json` (Context7 `${CONTEXT7_API_KEY:-}`). Document in README; do not commit secrets. ([Context7](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/external_plugins/context7/.mcp.json); [mcp-integration skill](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/plugin-dev/skills/mcp-integration/SKILL.md))
- Custom connector request headers (beta): allowlisted names (`authorization`, `x-api-key`, `x-auth-token`, …); values stored by Claude, not shown again. Shared org credential, not per-user. Cannot set `Authorization` if OAuth owns it. ([Request headers](https://claude.com/docs/connectors/custom/remote-mcp))
- Claude Tag credentials: admin-held service account; Agent Proxy attaches them at the boundary. ([Custom](https://claude.com/docs/claude-tag/admins/connections/custom))
- Directory `oauth_anthropic_creds`: partner sends client id/secret to Anthropic; used only after user consent. Email `mcp-review@anthropic.com`. ([Auth](https://claude.com/docs/connectors/building/authentication.md))

### Versioning and distribution

| Path | How it versions | Review |
| --- | --- | --- |
| Public GitHub + own marketplace | Users `/plugin marketplace add org/repo`; pin via `version` / git `sha` | None |
| Official plugin directory | Public repo required. After publish, GitHub pushes are mirrored by CI + automated screening. No re-submit for updates | Automated; Verified is extra. Team/Enterprise or Console role to submit. Run `claude plugin validate` first. ([Submit](https://claude.com/docs/plugins/submit); [After publishing](https://claude.com/docs/connectors/building/after-publishing.md)) |
| Org GitHub sync | Private/internal repo; sync replaces all plugins. Auto-sync on PR merge that bumps plugin version (not direct push). Sync ≤ 30 min. Failed sync can **temporarily remove** plugins | Org admin only |
| Manual ZIP | Same `name` overwrites. Manual marketplace ≤ 100 plugins, 50 MB; Tag upload ≤ 200 MB | Skill/plugin scanning on Enterprise if enabled |
| Connectors Directory | Server tools update live with no resubmit. Listing metadata edited in dashboard; some changes re-reviewed. Slug permanent | Security, tool annotations (`title`, `readOnlyHint`/`destructiveHint`), OAuth for authenticated services, docs, privacy policy for local. ([Submission](https://claude.com/docs/connectors/building/submission.md)) |
| MCPB desktop extension | Separate form `https://clau.de/desktop-extention-submission` | Privacy policy required |

There is no separate “Anthropic partner program” product name in these docs beyond directory review + `mcp-review@anthropic.com` for `oauth_anthropic_creds`, `custom_connection`, header-allowlist additions, and delist. ([Auth](https://claude.com/docs/connectors/building/authentication.md); [Delist](https://claude.com/docs/connectors/building/after-publishing.md))

## 5. Smallest shippable artifact

**v1 (ship this week, no Anthropic review):**

```text
ctxpipe-claude-plugin/                 # public GitHub repo
├── .claude-plugin/
│   ├── plugin.json                    # name, displayName, version, description, author, homepage
│   └── marketplace.json               # so `/plugin marketplace add ctxpipe-ai/ctxpipe-claude-plugin` works
├── .mcp.json                          # type:http + generic hosted /mcp URL
├── skills/ctx-advisor/SKILL.md        # when/how to call the MCP tool
├── SETUP.md                           # optional; plugin submit docs encourage a setup skill
└── README.md                          # Code install, Tag attach, custom-connector link
```

Required to load: for a marketplace, each plugin needs `name` + `source`; for a plugin with a manifest, `name`. MCP file is required for the Slack/Code purpose. A skill is not strictly required but is what Anthropic says makes a plugin worth installing. ([What to build](https://claude.com/docs/connectors/building/what-to-build.md); [Submit](https://claude.com/docs/plugins/submit))

Validate: `claude plugin validate ./` and `claude plugin validate ./ --strict`. ([Validate](https://code.claude.com/docs/en/plugins-reference))

**Hosting:** public GitHub for Code/Cowork directory later; customers who GitHub-sync org plugins copy the folder into their **private** marketplace repo (relative `source`).

**v1.1 (no code change on our MCP):** publish an install link for custom connectors:

`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=ctxpipe&connectorUrl=https%3A%2F%2Fapp.ctxpipe.ai%2Fmcp`

and the admin twin under `/admin-settings/connectors`. Prefills only; user still confirms. ([Install link](https://claude.com/docs/connectors/building/directory-vs-custom))

**v1.2 (review queue):**

1. Submit the plugin (public repo) to the plugin directory.
2. Submit the generic remote MCP to the Connectors Directory (Team/Enterprise org, OAuth, tool annotations).

Do **not** build an MCPB desktop extension for hosted ctxpipe.

## 6. Cursor / CodeRabbit / Codex (brief)

These formats are **cousins, not the same marketplace**.

- **Cursor** ships two layouts: open **Agent Plugins** (`plugin.json` at repo root) and **Cursor Plugins** (`.cursor-plugin/plugin.json` + `.cursor-plugin/marketplace.json`). Claude Code explicitly ignores unknown top-level fields so one `plugin.json` *can* also be a Cursor/VS Code/MCPB manifest, but Cursor's marketplace and review are separate. ([Cursor plugins](https://cursor.com/docs/plugins); [Unrecognized fields](https://code.claude.com/docs/en/plugins-reference))
- **OpenAI Codex / ChatGPT Work** use `.codex-plugin/plugin.json`. OpenAI documents converting a Claude archive: keep `.claude-plugin/plugin.json` for upload; the portal emits `.codex-plugin/plugin.json`. Skills-only Claude uploads **must not** rely on `.mcp.json` / `mcpServers`. ([Package your plugin](https://developers.openai.com/plugins/build/plugins); [Submit Claude plugin to OpenAI](https://developers.openai.com/plugins/guides/submit-claude-plugin))
- **CodeRabbit** is a *product* plugin that installs into Cursor/Codex marketplaces; it is not a third Anthropic format. ([CodeRabbit Codex integration](https://docs.coderabbit.ai/cli/codex-integration))

Do not expand ctxpipe v1 to those marketplaces unless a later ADR says so.

## 7. Official statements on restricting custom MCP

**No official statement that custom/bespoke MCP entry is being removed from Claude.ai, Cowork, or Desktop.** Opposite:

- “You can manually add any third-party connector to Claude as long as you have the URL of that remote MCP server.” ([Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp))
- “The directory is a catalog, not a separate kind of connector… If you have a connector's URL, it can be added as a custom connector. A connector does not need to be in the directory for you to use it.” ([Verification](https://claude.com/docs/connectors/verification.md))
- Custom connectors remain on Free (limit 1), Pro, Max, Team, Enterprise. Team/Enterprise: only Owners add the URL; members Connect. ([Help Center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp))

**What is restricted or deprecated:**

- **Claude Tag channels** never consume a user-pasted custom URL or a repo `.mcp.json`. That is current design, not a sunset of custom MCP on claude.ai. ([For Claude Code users](https://claude.com/docs/claude-tag/concepts/for-claude-code-users))
- **Legacy Claude in Slack** (per-user connectors in channels) is deprecated for Team/Enterprise in favor of Tag. After the cutover date, Legacy scopes go silent. ([Migrate](https://claude.com/docs/claude-tag/admins/migrate-from-earlier.md))
- **Enterprise Claude Code** can force plugin-only MCP (`strictPluginOnlyCustomization` including `mcp`) or exclusive `managed-mcp.json`. That is admin lock-down, not a global phase-out. ([Managed MCP](https://code.claude.com/docs/en/managed-mcp.md))
- SSE remote transport is treated as **legacy** versus Streamable HTTP for new plugins. ([Issue #2196](https://github.com/anthropics/claude-plugins-official/issues/2196))
- Tokens in URL query strings are discouraged / spec-prohibited. ([Auth](https://claude.com/docs/connectors/building/authentication.md))

## Recommended v1 for ctxpipe

Ship a **single public plugin repo** that is valid for Claude Code, Cowork, and Claude Tag:

1. `.claude-plugin/plugin.json` — `name: ctxpipe`, `displayName: ctxpipe`, `version: 0.1.0`, description, author, homepage `https://docs.ctxpipe.ai`.
2. `.mcp.json` — one server `ctxpipe`, `type: "http"`, URL `https://app.ctxpipe.ai/mcp`.
3. Better Auth post-login organization selection — store the selected organization in the OAuth grant `referenceId`, carry it through refresh, and expose it as a namespaced JWT claim.
4. `skills/ctx-advisor/SKILL.md` — org-scoped engineering context; call the MCP tool instead of guessing the repo.
5. Root `marketplace.json` listing `ctxpipe` with `"source": "./"` (or `./plugins/ctxpipe` if we keep the repo multi-plugin later).
6. README with four install paths:
   - Claude Code: `/plugin marketplace add ctxpipe-ai/…` then `/plugin install ctxpipe@…`
   - Cowork / chat: Customize → Add marketplace, or org ZIP
   - Claude Tag: Owner uploads/syncs plugin, toggles it on the bundle, and completes an MCP Connector sign-in for `app.ctxpipe.ai`
   - claude.ai without plugin: generic custom-connector install link
7. Keep using OAuth DCR/CIMD on `/mcp`; verify the grant-bound organization on every tool request. Do not put tokens or tenant authority in a mutable browser session.
8. Submit the same generic URL to the Connectors Directory after plugin validation. Defer MCPB.

This removes manual MCP URL entry for Slack customers. It does **not** remove
Claude Tag's mandatory Access bundle and one-time admin MCP Connector sign-in.

## Open questions / risks

1. **End-to-end Tag proof.** The static generic URL and OAuth grant binding remove the `userConfig` dependency, but a real Access bundle must still be tested before claiming Slack Tag support.
2. **Help Center vs Cowork guide on “plugins in Chat.”** Skills-in-chat is claimed by Help Center and org-admin docs; Cowork guide denies Chat. Do not market “works in claude.ai Chat” until someone installs the plugin on a Pro/Team web session.
3. **OAuth as Tag service account.** MCP Connector credential is “sign in once as admin; agent acts as that account.” The grant is tenant-bound, but the identity is still shared and must be intentionally authorized for that organization's data.
4. **`?orgSlug=` vs PRM exact-match.** Hosted Claude requires `resource` to match the entered URL including path. Query handling must stay consistent or Connect/OAuth will fail with “Couldn't reach the MCP server.”
5. **Org marketplace cannot pull our public GitHub as a private-source shortcut** unless they vendor files. Document the copy step.
6. **Failed GitHub sync deletes org plugins temporarily.** Warn enterprise customers.
7. **Official mcp-integration skill is stale** (SSE vs HTTP). Do not copy it blindly.
8. **Directory review is separate from plugin review.** The generic OAuth URL avoids a `custom_connection` dependency, but listing still requires a second submission.
9. **Claude Tag is public beta**; behavior can change before GA. ([Beta note](https://claude.com/docs/claude-tag/admins/connections/custom))
10. **Enterprise managed MCP** can ban user-added servers (plugin-only or managed-only). A directory/plugin listing still helps those orgs add us to the allowlist.

## Source links

### Claude Code (code.claude.com)

- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Create plugins](https://code.claude.com/docs/en/plugins)
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Discover plugins](https://code.claude.com/docs/en/discover-plugins)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Managed MCP](https://code.claude.com/docs/en/managed-mcp.md)
- [Glossary](https://code.claude.com/docs/en/glossary.md)
- [Claude Code Slack](https://code.claude.com/docs/en/slack.md)
- [Docs index](https://code.claude.com/docs/llms.txt)

### Claude / Cowork / connectors (claude.com/docs)

- [Plugins overview](https://claude.com/docs/plugins/overview.md)
- [Submit plugin](https://claude.com/docs/plugins/submit)
- [What to build: MCP, plugin, or both](https://claude.com/docs/connectors/building/what-to-build.md)
- [Authentication](https://claude.com/docs/connectors/building/authentication.md)
- [Directory vs custom](https://claude.com/docs/connectors/building/directory-vs-custom)
- [Submit connector](https://claude.com/docs/connectors/building/submission.md)
- [After publishing](https://claude.com/docs/connectors/building/after-publishing.md)
- [Connector verification](https://claude.com/docs/connectors/verification.md)
- [Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp)
- [Desktop extensions](https://claude.com/docs/connectors/custom/desktop-extensions)
- [Install plugins (Cowork)](https://claude.com/docs/cowork/guide/plugins.md)
- [Slack integration](https://claude.com/docs/connectors/slack/index.md)
- [Docs index](https://claude.com/docs/llms.txt)

### Claude Tag

- [Custom connections / custom MCP](https://claude.com/docs/claude-tag/admins/connections/custom)
- [Skills repository](https://claude.com/docs/claude-tag/admins/skills-repo)
- [Add connections / attach plugins](https://claude.com/docs/claude-tag/admins/add-connections)
- [For Claude Code users](https://claude.com/docs/claude-tag/concepts/for-claude-code-users)
- [Settings map](https://claude.com/docs/claude-tag/concepts/settings-map.md)
- [Customize](https://claude.com/docs/claude-tag/admins/customize.md)
- [Migrate from earlier Slack](https://claude.com/docs/claude-tag/admins/migrate-from-earlier.md)

### Help Center

- [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)
- [Manage plugins for your organization](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization)
- [Custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Use connectors](https://support.anthropic.com/en/articles/11176164-pre-built-web-connectors-using-remote-mcp)
- [Claude apps release notes](https://docs.anthropic.com/en/release-notes/claude-apps)

### GitHub / schemas

- [anthropics/claude-plugins-official marketplace.json](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json)
- [Context7 plugin.json](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/external_plugins/context7/.claude-plugin/plugin.json)
- [Context7 .mcp.json](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/external_plugins/context7/.mcp.json)
- [mcp-integration skill (stale SSE guidance)](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/plugin-dev/skills/mcp-integration/SKILL.md)
- [Remote MCP config shape (issue #2196)](https://github.com/anthropics/claude-plugins-official/issues/2196)
- [SchemaStore plugin manifest](https://json.schemastore.org/claude-code-plugin-manifest.json)
- [SchemaStore marketplace](https://json.schemastore.org/claude-code-marketplace.json)
- [claude-code#9686 schema hosting](https://github.com/anthropics/claude-code/issues/9686)

### Other ecosystems (section 6 only)

- [Cursor plugins](https://cursor.com/docs/plugins)
- [OpenAI Codex plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI: submit a Claude plugin](https://developers.openai.com/plugins/guides/submit-claude-plugin)
- [CodeRabbit Codex plugin](https://docs.coderabbit.ai/cli/codex-integration)
