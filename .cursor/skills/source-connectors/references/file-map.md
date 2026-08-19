# Connector implementation file-map

Read this in skill step 6. `<slug>` is the connection type (`linear`, `notion`, `slack`, …). Native git skips yaml/content-sync rows. Every new connector that writes into a context repo includes `config.yaml` + config PR (`*-sync-config`), including capture.

Anchor implementations: Linear and Notion on `main`; Slack on PR #267 (`slack-connector`).

## Control plane

| Surface | Where |
|---------|--------|
| `connections.type` union | `apps/backend/src/db/schema/connections.ts` |
| Stored Zod + encrypt/decrypt | `apps/backend/src/lib/connection-config.ts` |
| Row ↔ shape (no secrets on list) | `apps/backend/src/models/connection-rows.ts` |
| Model: list/get, bind, phase transitions, token refresh with lock | `apps/backend/src/models/<slug>-connector.ts` |
| Org list metadata enum | `apps/backend/src/routes/v1/connectors-list.ts` |
| Org-scoped routes | `apps/backend/src/routes/v1/connectors-<slug>.ts` — mount in `routes/v1/index.ts` under `requireOrgAdminOrOwner` |
| OAuth callback (non-org) | same file or `*-oauth-callback`; HTML popup relay |
| Capabilities (oauth configured, webhook URL) | `apps/backend/src/routes/v1/capabilities.ts` |
| Binding cleared when repo deleted | `apps/backend/src/domain/repositoryDeletion.ts` |

Partial unique indexes (e.g. one Slack `teamId` per org) belong on `connections`, not a new table. Generate migrations with the [drizzle-migrations](../../drizzle-migrations/SKILL.md) skill — do not hand-write SQL.

## Provider + git

| Surface | Where |
|---------|--------|
| HTTP/SDK client, token refresh | `apps/backend/src/services/<slug>/client.ts` |
| Markdown/CSV + attachment conversion | `apps/backend/src/services/<slug>/converter.ts` |
| Git commit (GitHub today) | `commitFiles` in `apps/backend/src/services/github/installation-write-client.ts` |
| Config yaml schema + load from repo | `config-yaml.ts`, `config-from-repo.ts` |
| Scoped: full mirror + incremental | `sync.ts`, `incremental.ts` |
| Capture: snapshot writer | e.g. Slack `sync.ts` + mention agent (new capture still has config yaml) |

## Workflows and webhooks

| Surface | Where |
|---------|--------|
| Workflows | `apps/backend/src/openworkflow/workflows/<slug>-*.ts` (CLI discovers this directory; add a `*-workflow-discovery.test.ts`) |
| Config PR | `<slug>-sync-config` (required for every new git-writing connector) |
| Scoped content | `<slug>-sync-content`, `<slug>-sync-entity` |
| Capture content | event/mention workflow that writes git then ingests |
| Provider webhook | `apps/backend/src/routes/webhooks/<slug>/<slug>.ts` — register in `routes/webhooks.ts` |
| GitHub config-merge | `routes/webhooks/github/github-<slug>-push.ts` wired from `github.ts` |
| Enqueue | `runWorkflowWithWorkerWake`; after git write `runRepositoryIngestionWorkflow` |

Webhook: verify signature on the **raw** body; enqueue; ACK. Non-live phases skip. Do not parse-and-reserialise JSON before HMAC.

## Deployment env (hosted + self-host)

Same encryption key (`AUTH_SECRET` / `CONNECTION_SECRETS_ENCRYPTION_KEY`) on backend and worker. Also copy any client id/secret the **worker actually uses** (token refresh). Webhook signing secrets are backend-only unless a worker verifies events.

| Surface | Where |
|---------|--------|
| Parse (optional strings; empty must not fail `parseEnv`) | `apps/backend/src/config/env.ts` |
| Examples | `apps/backend/.env.example`, `docker-compose.env.example` |
| Compose `deploy` profile | `docker-compose.yml` (backend + worker) |
| Railway Terraform | `infra/variables.tf`, `infra/module/ctxpipe/variables.tf`, `infra/module/ctxpipe/railway.tf` |
| AWS CDK | `packages/aws-cdk/src/internal/secrets-construct.ts` + README; **changeset** for `@ctxpipe/aws-cdk` |
| CI secret plumbing if required | `.github/workflows/deploy.yaml`, `pr-deploy.yaml`, `terraform-plan-pr.yaml` |

Typical names: `<SLUG>_CLIENT_ID`, `<SLUG>_CLIENT_SECRET`, `<SLUG>_WEBHOOK_SECRET` or `_SIGNING_SECRET`, optional `<SLUG>_REDIRECT_URI`.

## UI (`apps/ui`)

Follow [product-ui](../../product-ui/SKILL.md). Connector list lesson: `ConnectorListItem` + health chip; wizards are not on the list.

| Surface | Where |
|---------|--------|
| Catalog entry | `AddConnectorCatalogDialog` + `Add<Name>ConnectorButton` |
| Setup wizard/dialog + stories/MSW | `features/connectors/components/<slug>-setup/` or `*SetupDialog.tsx` |
| Connection card | `*ConnectionCard.tsx` |
| Queries + setup model | `features/connectors/queries/<slug>-connector.ts`, `<slug>-setup-model.ts` |
| List sort order | `sortOrgConnectionsForDisplay` (GitHub first) |
| Connectors page wiring | `routes/$orgSlug.connectors.tsx` |
| OAuth popup route if needed | `routes/[.]<slug>.setup.tsx` |
| List type union | `OrgConnectionListItem['type']` |

UK English in copy (`organisation`). GitHub prerequisite step before choosing a context repo.

## Docs

| Surface | Where |
|---------|--------|
| Product guide | `apps/docs/content/docs/(guide)/connections/source-connectors/<slug>.mdx` + `meta.json` |
| Context repo + connected sources | update `context-repository.mdx`, `connected-sources.mdx` |
| Self-host | `apps/docs/content/docs/self-hosting/<slug>.mdx` + `meta.json`; mention in configuration / production-readiness if secrets are required |
| ADR | `.ai/memory/decisions/ADR-NNN-<slug>-connector-….md` + `decisions/index.md` |

Self-host page must list: provider app creation, exact callback, exact Event URL, env vs `connections.config` secrets, Compose / Railway / CDK, and that traffic stays on the operator’s origin.

## Tests (minimum)

- Converter fixtures for representative payloads (including an image or other attachment if the provider has them).
- `commitFiles` with `encoding: "base64"` when binaries are written.
- Webhook: valid HMAC on the raw body, reject tampered/stale, enqueue-then-ACK, skip when not live.
- Workflow discovery test (`*-workflow-discovery.test.ts`).
- `parseEnv` still succeeds when the new optional secrets are empty.
- OAuth state: expired / wrong org rejected; nonce present (Linear-style HMAC state).
- Focused UI tests + Storybook/MSW for the wizard.
