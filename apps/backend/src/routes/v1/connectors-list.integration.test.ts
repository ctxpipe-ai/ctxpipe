import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { OpenAPIHono } from "@hono/zod-openapi"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { AppEnv } from "../../app/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  type ConnectionType,
  connections,
} from "../../db/schema/connections.js"
import { connectorsListRoutes } from "./connectors-list.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_connectors_list_${suffix}`
const id = (name: string) => `con_${name}_${suffix}`

/** The list reads only the presence of a secret, never its value. */
const SECRET = "ciphertext-fixture"

const pagerdutyAccount = {
  accountId: "PD123",
  accountName: "Example",
  accountSubdomain: "example",
  region: "us",
  ownerUserId: "user_owner",
}

/** One row for each state of each provider, with the status we expect. */
const seeds: {
  name: string
  type: ConnectionType
  config: Record<string, unknown>
  status: "connected" | "needs_reconnect" | "setup_pending"
}[] = [
  {
    name: "github_installed",
    type: "github",
    config: {
      installationId: 4242,
      ingestAllRepositories: true,
      includeFutureRepos: true,
      accountSlug: "example",
    },
    status: "connected",
  },
  {
    name: "github_self_hosted_draft",
    type: "github",
    config: {
      ingestAllRepositories: true,
      includeFutureRepos: true,
      githubAppId: "123",
      appSlug: "example-app",
      privateKeyEnc: SECRET,
    },
    status: "setup_pending",
  },
  {
    // The hosted App install has not come back yet: no App credentials.
    name: "github_hosted_draft",
    type: "github",
    config: { ingestAllRepositories: true, includeFutureRepos: true },
    status: "setup_pending",
  },
  {
    name: "forge_installed",
    type: "forge",
    config: {
      status: "installed",
      cloudId: "cloud-1",
      confluenceSiteHost: "example.atlassian.net",
    },
    status: "connected",
  },
  {
    // Installed, but the Marketplace event has not bound the site yet.
    name: "forge_installed_without_cloud_id",
    type: "forge",
    config: {
      status: "installed",
      confluenceSiteHost: "pending.atlassian.net",
    },
    status: "setup_pending",
  },
  {
    name: "forge_pending",
    type: "forge",
    config: { status: "pending", installOpenedAt: "2026-10-01T00:00:00Z" },
    status: "setup_pending",
  },
  {
    name: "forge_uninstalled",
    type: "forge",
    config: { status: "uninstalled", cloudId: "cloud-2" },
    status: "needs_reconnect",
  },
  {
    name: "linear_installed",
    type: "linear",
    config: {
      status: "installed",
      accessTokenEnc: SECRET,
      workspaceId: "lin-ws-1",
      workspaceName: "Example Product",
      setupPhase: "live",
    },
    status: "connected",
  },
  {
    // A row from before the status key: the schema reads it as installed.
    name: "linear_legacy_without_status",
    type: "linear",
    config: {
      accessTokenEnc: SECRET,
      workspaceId: "lin-ws-3",
      workspaceName: "Example Legacy",
    },
    status: "connected",
  },
  {
    name: "linear_installed_without_workspace",
    type: "linear",
    config: { status: "installed", accessTokenEnc: SECRET },
    status: "setup_pending",
  },
  {
    name: "linear_revoked",
    type: "linear",
    config: {
      status: "revoked",
      accessTokenEnc: SECRET,
      workspaceId: "lin-ws-2",
      workspaceName: "Example Platform",
    },
    status: "needs_reconnect",
  },
  {
    // A self-hosted OAuth app is saved, but the workspace is not linked.
    name: "linear_draft_with_app",
    type: "linear",
    config: {
      setupPhase: "draft",
      oauthClientId: "lin-client",
      oauthClientSecretEnc: SECRET,
    },
    status: "setup_pending",
  },
  {
    name: "notion_installed",
    type: "notion",
    config: {
      status: "installed",
      accessTokenEnc: SECRET,
      workspaceId: "no-ws-1",
      workspaceName: "Example",
    },
    status: "connected",
  },
  {
    name: "notion_legacy_token",
    type: "notion",
    config: { accessToken: "legacy-plaintext-fixture", workspaceId: "no-ws-2" },
    status: "connected",
  },
  {
    name: "notion_draft_with_app",
    type: "notion",
    config: {
      status: "pending",
      setupPhase: "draft",
      oauthClientId: "no-client",
    },
    status: "setup_pending",
  },
  {
    name: "notion_installed_without_token",
    type: "notion",
    config: { status: "installed", workspaceId: "no-ws-4" },
    status: "setup_pending",
  },
  {
    name: "notion_revoked",
    type: "notion",
    config: {
      status: "revoked",
      accessTokenEnc: SECRET,
      workspaceId: "no-ws-3",
    },
    status: "needs_reconnect",
  },
  {
    name: "pagerduty_installed",
    type: "pagerduty",
    config: {
      ...pagerdutyAccount,
      status: "installed",
      accessTokenEnc: SECRET,
    },
    status: "connected",
  },
  {
    // A row from before the status key: the schema reads it as installed.
    name: "pagerduty_legacy_without_status",
    type: "pagerduty",
    config: { ...pagerdutyAccount, accessTokenEnc: SECRET },
    status: "connected",
  },
  {
    name: "pagerduty_draft_with_app",
    type: "pagerduty",
    config: {
      ...pagerdutyAccount,
      accountId: "pending:draft",
      status: "pending",
      oauthClientId: "pd-client",
    },
    status: "setup_pending",
  },
  {
    name: "pagerduty_revoked",
    type: "pagerduty",
    config: { ...pagerdutyAccount, status: "revoked", accessTokenEnc: SECRET },
    status: "needs_reconnect",
  },
  {
    name: "slack_installed",
    type: "slack",
    config: {
      status: "installed",
      botTokenEnc: SECRET,
      teamId: `T_${suffix}_1`,
      teamName: "Example",
    },
    status: "connected",
  },
  {
    name: "slack_pending",
    type: "slack",
    config: { status: "pending" },
    status: "setup_pending",
  },
  {
    name: "slack_installed_without_token",
    type: "slack",
    config: { status: "installed", teamId: `T_${suffix}_3` },
    status: "setup_pending",
  },
  {
    name: "slack_revoked",
    type: "slack",
    config: {
      status: "revoked",
      botTokenEnc: SECRET,
      teamId: `T_${suffix}_2`,
    },
    status: "needs_reconnect",
  },
  {
    name: "buildkite_installed",
    type: "buildkite",
    config: {
      organizationSlug: "example",
      apiTokenEnc: SECRET,
      status: "installed",
    },
    status: "connected",
  },
  {
    name: "buildkite_revoked",
    type: "buildkite",
    config: {
      organizationSlug: "example-2",
      apiTokenEnc: SECRET,
      status: "revoked",
    },
    status: "needs_reconnect",
  },
  {
    name: "plain_installed",
    type: "plain",
    config: {
      workspaceId: "pl-ws-1",
      workspaceName: "Example Support",
      apiKeyEnc: SECRET,
      status: "installed",
    },
    status: "connected",
  },
  {
    name: "plain_revoked",
    type: "plain",
    config: {
      workspaceId: "pl-ws-2",
      workspaceName: "Example Help",
      apiKeyEnc: SECRET,
      status: "revoked",
    },
    status: "needs_reconnect",
  },
]

/** Empty drafts that only a setup first screen made: the list hides them. */
const hiddenDrafts: {
  name: string
  type: ConnectionType
  config: Record<string, unknown>
}[] = [
  {
    name: "notion_empty_draft",
    type: "notion",
    config: { status: "pending", setupPhase: "draft" },
  },
  {
    name: "linear_empty_draft",
    type: "linear",
    config: { setupPhase: "draft" },
  },
  {
    name: "pagerduty_empty_draft",
    type: "pagerduty",
    config: {
      ...pagerdutyAccount,
      accountId: "pending:empty",
      status: "pending",
    },
  },
]

function createApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_fixture" } as AppEnv["Variables"]["user"])
    c.set("session", {
      id: "session_fixture",
    } as AppEnv["Variables"]["session"])
    c.set("orgId", orgId)
    await next()
  })
  app.route("/connectors", connectorsListRoutes)
  return app
}

describe("GET /connectors gives the status of each connection (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required")
    initDb(connectionString)
    await getSystemDb()
      .insert(organizations)
      .values({
        id: orgId,
        name: "Connectors list fixture",
        slug: `connectors-list-${suffix}`.replaceAll("_", "-"),
        createdAt: new Date(),
      })
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(connections).values([
        ...seeds.map((seed, index) => ({
          id: id(seed.name),
          orgId,
          type: seed.type,
          config: seed.config,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        })),
        ...hiddenDrafts.map((draft) => ({
          id: id(draft.name),
          orgId,
          type: draft.type,
          config: draft.config,
        })),
      ])
    })
  })

  afterAll(async () => {
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("derives connected, needs_reconnect, or setup_pending from the stored connection", async () => {
    const response = await createApp().request("/connectors")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      items: { id: string; status: string }[]
    }
    const statusById = Object.fromEntries(
      body.items.map((item) => [item.id, item.status]),
    )
    expect(statusById).toEqual(
      Object.fromEntries(seeds.map((seed) => [id(seed.name), seed.status])),
    )
  })
})
