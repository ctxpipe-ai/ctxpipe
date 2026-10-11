import { OpenAPIHono } from "@hono/zod-openapi"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { projectWorkspaceSources } from "../../domain/workspace-sources/project.js"
import { contextStorage } from "../../test/hono-test-logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"

// The routes import the OpenWorkflow client, which reads DATABASE_URL on import.
let routes: typeof import("./workspace-sources-routes.js")

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

function createApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    return withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, () =>
      withOrgDbContext(seed.orgId, () => next()),
    )
  })
  app.route("/:orgSlug/api/v1/workspaces", routes.workspaceSourcesRoutes)
  app.route("/:orgSlug/api/v1/connectors", routes.connectionUsageRoutes)
  return app
}

describe("Workspace sources HTTP routes (Postgres + git)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_http")
    routes = await import("./workspace-sources-routes.js")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("lists sources, lists Used in for a connection, and refuses a change without GitHub", async () => {
    const slack = await seed.addConnection("slack", {
      teamName: "Acme Support",
    })
    const workspaceId = await seed.addWorkspace("support")
    const repo = await seed.gitRepository()
    const sha = await repo.commit({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  - id: support-channels
    provider: slack
    connection: ${slack}
    channels: [C1, C2]
  - id: broken
    provider: jira
    connection: ${slack}
`,
    })
    await projectWorkspaceSources({
      orgId: seed.orgId,
      workspaceId,
      revision: sha,
      text: await repo.sourcesText(sha),
      env: parseEnv(process.env),
    })
    const slug = `support-${seed.suffix.replaceAll("_", "-")}`.slice(0, 60)
    const app = createApp()

    const list = await app.request(
      `/${seed.orgId}/api/v1/workspaces/${slug}/sources`,
    )
    expect(list.status).toBe(200)
    const body = await list.json()
    expect(body).toMatchObject({
      path: ".ctxpipe/sources.yaml",
      revision: sha,
      fileError: null,
      canEdit: false,
      directCommitAllowed: false,
      pendingChanges: [],
    })
    expect(
      body.items.map((item: { sourceKey: string; status: string }) => [
        item.sourceKey,
        item.status,
      ]),
    ).toEqual([
      ["broken", "invalid"],
      ["support-channels", "ok"],
    ])
    expect(body.items[1].connectionName).toBe("Acme Support")

    const usage = await app.request(
      `/${seed.orgId}/api/v1/connectors/${slack}/workspaces`,
    )
    expect(usage.status).toBe(200)
    expect(await usage.json()).toMatchObject({
      items: [
        {
          workspaceId,
          workspaceName: "support",
          stat: "Slack",
          sources: [{ sourceKey: "support-channels", status: "ok" }],
        },
      ],
    })
    expect(
      (
        await app.request(
          `/${seed.orgId}/api/v1/connectors/con_nope/workspaces`,
        )
      ).status,
    ).toBe(404)

    const change = await app.request(
      `/${seed.orgId}/api/v1/workspaces/${slug}/sources`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: { provider: "slack", connectionId: slack, scope: {} },
        }),
      },
    )
    expect(change.status).toBe(409)
  })
})
