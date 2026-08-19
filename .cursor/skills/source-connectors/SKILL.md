---
name: source-connectors
description: Source connectors. Use when designing, implementing, or reviewing an integration that durably imports external provider content into a ctxpipe context repository.
---

# Source connectors

Build **git-native** source connectors: the provider is authorised on **this** deployment, selected content is written as files into a GitHub **context repository**, then `runRepositoryIngestionWorkflow` indexes that repo. Same code for hosted and self-host. The provider app and webhook endpoint terminate on this deployment; credentials are deployment-shared or connection-specific according to the provider’s tenant-isolation model.

For new connectors, inherit Linear/Notion’s thin control plane (scoped mirror) or Slack’s bind-and-capture path. Consult Confluence only when maintaining its accepted legacy path.

Canonical decisions: [ADR-018](../../../.ai/memory/decisions/ADR-018-unified-connections-table.md), [ADR-022](../../../.ai/memory/decisions/ADR-022-linear-connector-git-native-mirror.md), [ADR-023](../../../.ai/memory/decisions/ADR-023-notion-connector-git-native-mirror.md). Slack intent-capture: [ADR-025 on PR #267](https://github.com/ctxpipe-ai/ctxpipe/blob/slack-connector/.ai/memory/decisions/ADR-025-slack-connector-git-native-mirror.md). Self-host Atlassian exception: [ADR-019](../../../.ai/memory/decisions/ADR-019-confluence-forge-self-host-and-per-org-atlassian-3lo.md).

## 1. Classify the job

Read [connector kinds](references/kinds.md), then name the **kind** before any schema or UI:

| Kind | Job | Scope SoT | Git write | Anchor |
|------|-----|-----------|-----------|--------|
| **Native git** | Source already is git (GitHub App) | GitHub picker / repo rows | none (ingest the repo) | GitHub connector |
| **Scoped mirror** | Curated spaces (docs, issues) | `<slug>/config.yaml` draft on a config PR, live after merge | full reconcile then webhook entity sync | Linear, Notion |
| **Intent capture** | User points at a thread/item | none, unless there is real scope to review | snapshot commit to the bound default branch | Slack (PR #267) |

MCP is not a source connector. Query-time provider MCP (e.g. Slack MCP) can complement capture; it does not replace git-native durability.

**Done when:** the kind is named, the anchor connector is named, kinds.md was read, and a config PR exists only if there is real scope to review.

## 2. Thin control plane

One `connections` row (`con_*`, `type = <slug>`). **`connections.config` jsonb** holds identity, encrypted secrets, and repo binding (`repositoryId`, `branch`, `enabled`, setup phase / pending config PR fields when the kind uses them). Read/write config only through a colocated Zod schema in `apps/backend/src/lib/connection-config.ts` (lesson: `connections.config` JSONB).

Keep in git or OpenWorkflow, not Postgres:

- draft or live scope → git yaml
- dirty-entity / job queues → OpenWorkflow
- binding (`repositoryId` / branch / enabled) → `connections.config`, not `*_sync_targets`

Deployment-shared webhook signing secrets are env (same role as `LINEAR_WEBHOOK_SECRET`), not a table. Provider-issued per-connection secrets belong encrypted on the row.

A new table is justified only for a first-class product entity (e.g. `repositories`), never for connector control-plane, unless an ADR shows why `connections.config`, git, and OpenWorkflow cannot hold the state. List APIs return metadata only — no `config`. Prefer `connectionId` / list-by-org / resolve via `repositoryId`; do not `.limit(1)` an org’s connectors.

Encrypt tokens with `encryptConnectionSecret` (`*Enc` fields). Never log or return decrypted secrets.

**Done when:** the stored shape is a Zod schema on `connections.config`, uniqueness (if any) is a targeted partial index, and any new table is justified in an ADR.

## 3. Pipe files into git

Git is the durability and audit store. Scoped mirrors also use a configuration PR as the **approval** boundary; intent capture commits snapshots to the bound default branch.

Write under a managed root `<slug>/` in the bound context repository (often `ctxpipe-context`).

- **Plain text first.** Markdown for documents, issues, threads, comments. YAML for machine scope (`config.yaml`). CSV only as a tabular companion beside canonical row Markdown (Notion databases).
- **Deterministic conversion.** Convert provider-native blocks/markup into readable Markdown (or another agreed plain-text form), preserving all user-authored text, ordering, headings, lists, authors, timestamps, links, and code. No LLM rewrite, no API-JSON dumps, no retained HTML unless HTML is itself the source payload.
- **Stable paths.** Include the provider id so renames do not duplicate. Match the anchor: Linear uses flat `linear/issues/<slug>--<id>.md`; Notion pages and Slack threads use `<slug>--<id>/index.md` directories.
- **Images are files.** New connectors download image bytes through the authorised client (not anonymous CDN), commit them next to the Markdown (`png`/`jpg`/`webp`/`svg`), and rewrite links to relative paths. Never persist private or expiring URLs as image sources. Existing connectors keep their shipped media policy (Notion/Linear/Slack stubs); changing that policy requires an ADR update.
- **Other binaries.** Skip unless the bytes are the retrieval payload (images, diagrams). Attachment metadata + permalink is enough for most files. Do not double-index content another connector already owns (Linear GitHub PRs stay references).
- **Provenance.** YAML frontmatter: source, stable ids, canonical URL, timestamps. Connector uninstall does not purge git.

Writes go through `commitFiles` in `installation-write-client.ts` (`encoding: "base64"` for binaries). After a successful write, enqueue `runRepositoryIngestionWorkflow`.

**Done when:** a sample tree is specified (paths + file types); for a new connector every image is committed as bytes; existing connectors are judged against their own ADR; the mirrored page is readable without a live provider API.

## 4. OAuth, webhooks, and the data boundary

Hosted and self-host run the **same** routes. Difference: who creates the provider app and supplies secrets.

- **Deployment-shared** app credentials live in env (`LINEAR_*`, `NOTION_*`, `SLACK_*`). **Connection-specific** credentials (and provider-issued secrets) live encrypted in `connections.config`. Document which model this provider requires. Backend **and** worker need shared client credentials when the worker refreshes tokens.
- Callbacks and Event URLs are on **this** deployment’s `AUTH_BASE_URL` (e.g. `/api/v1/integrations/<slug>/callback`, `/api/v1/webhook/<slug>`). Derive redirect URI from `AUTH_BASE_URL`; optional `*_REDIRECT_URI` only when the public URL differs.
- One Event URL per deployment app; route to a connection by workspace/team id in the payload. Per-connection webhook paths only when the provider app itself is per-connection (GitHub App on the connection row).
- Per-org provider apps only when sharing one app would cross tenants (Atlassian 3LO on the Forge row — ADR-019). Still processed on this deployment.
- OAuth start/callback: expiring signed `state` binds `userId` + `orgId` (and `connectionId` when needed). PKCE when the provider’s code flow supports it (Atlassian). Popup completion: tiny same-origin HTML relay + `localStorage` (lesson: Connector OAuth popup completion). Secrets never go in `state`.
- Signed webhooks: verify raw body + timestamp; ACK after OpenWorkflow enqueue. Skip events unless setup is live (no dirty-entity buffer). Failed enqueue → 5xx so the provider retries.

**Self-host data boundary:** customer tokens, webhooks, and source bytes stay on the customer’s deployment. Do not add a ctxpipe-SaaS proxy, relay, gateway, or webhook forwarder on that path. Hosted ctxpipe is one deployment; a self-host install is another.

**Done when:** callback + Event URL are documented as `{AUTH_BASE_URL}/…`, each secret is classified env vs `connections.config`, routing key is named, and no SaaS hop exists for self-host traffic.

## 5. Event and setup lifecycle

**Scoped mirror** phases (Linear/Notion): `draft` → `awaiting_merge` → `initial_sync` → `live` (plus `config_failed` / `sync_failed`). Config workflow opens the yaml PR; GitHub push on the target branch after merge starts full content sync; live webhooks run `*-sync-entity`.

**Intent capture** (Slack): bind repo (`draft` → `live` derived from binding); no yaml theatre. Provider event enqueues a capture workflow that snapshots one item.

Rebind (repository/branch change) resets lifecycle. `app_uninstalled` / token revoke sets `status: revoked` and disables binding; git stays. Deleting the bound repository clears binding fields.

Durable work is OpenWorkflow in `apps/backend/src/openworkflow/workflows/` (directory discovery). Webhook handlers stay thin.

**Done when:** phases, the merge/capture trigger, and the live incremental path are named, matching the kind.

## 6. Implement

Follow [references/file-map.md](references/file-map.md). Inspect the named anchors and reproduce their **responsibilities** for this kind; mark inapplicable surfaces N/A. UI chrome: [product-ui](../product-ui/SKILL.md) + connector-wizard lesson (Linear/Notion/Slack share setup chrome; list rows are `ConnectorListItem`, not a stepper).

If AWS CDK / deploy images change, add a changeset for `@ctxpipe/aws-cdk`.

**Done when:** every file-map row for this kind is implemented or N/A; converter fixtures, binary/`base64` commits, raw-body signature tests, workflow discovery, empty optional env parsing, and focused UI tests pass. CDK edits: `pnpm --filter @ctxpipe/aws-cdk test`.

## 7. Record the decision

New kind or a control-plane exception → [capture-adr](../capture-adr/SKILL.md) and point this skill at it. Confirmed convention → [capture-lesson](../capture-lesson/SKILL.md). New term → [capture-glossary](../capture-glossary/SKILL.md).

Product guide under `apps/docs/content/docs/(guide)/connections/source-connectors/`. Self-host operator page under `apps/docs/content/docs/self-hosting/` (OAuth app, callback, Event URL, env, Compose / Railway / CDK).

**Done when:** docs describe both hosted and self-host, and an ADR exists if the kind or state model is new.
