import { OpenAPIHono } from "@hono/zod-openapi"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { projectWorkspaceSources } from "../../domain/workspace-sources/project.js"
import { encodeSlackBotTokenForDb } from "../../lib/connection-config.js"
import { contextStorage } from "../../test/hono-test-logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"

const server = useMswServer()

// The routes import the OpenWorkflow client, which reads DATABASE_URL on import.
let routes: typeof import("./workspace-sources-routes.js")

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

/** As `withNetworkOrgContext`: the org context, and no request-wide SQL transaction. */
function createApp({ signedIn = true } = {}) {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    if (signedIn) {
      c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    }
    return withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, () => next())
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
    // The Slack source check reads each channel; the bot is in both.
    server.use(
      http.get("https://slack.com/api/conversations.info", ({ request }) =>
        HttpResponse.json({
          ok: true,
          channel: {
            id: new URL(request.url).searchParams.get("channel"),
            name: "support",
            is_member: true,
          },
        }),
      ),
    )
    const slack = await seed.addConnection("slack", {
      teamName: "Acme Support",
      status: "installed",
      botTokenEnc: encodeSlackBotTokenForDb("xoxb-test", parseEnv(process.env)),
    })
    const repo = await seed.gitRepository()
    // The list reads the source file bodies from this remote.
    const workspaceId = await seed.addWorkspace("support", repo.dir)
    const sha = await repo.commit({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  - id: support-channels
    provider: slack
    connection: ${slack}
    channels: [C0SUP0001, C0SUP0002]
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
      path: "sources",
      revision: sha,
      fileError: null,
      canEdit: false,
      pendingChanges: [],
    })
    expect(
      body.items.map((item: { path: string; status: string }) => [
        item.path,
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
          stat: "2 Slack channels",
          sources: [{ path: "support-channels", status: "ok" }],
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

    const badKey = await app.request(
      `/${seed.orgId}/api/v1/workspaces/${slug}/sources?path=Bad%20Path.md`,
      { method: "DELETE" },
    )
    expect(badKey.status).toBe(400)

    await seed.removeConnection(slack)
    const afterRemoval = await (
      await app.request(`/${seed.orgId}/api/v1/workspaces/${slug}/sources`)
    ).json()
    expect(afterRemoval.items[1]).toMatchObject({
      path: "support-channels",
      status: "connection_missing",
    })
  })
  it("refuses a batch without a session, with no source, and with more than 20 sources", async () => {
    const batch = (sources: unknown[], options?: { signedIn: boolean }) =>
      createApp(options).request(
        `/${seed.orgId}/api/v1/workspaces/any-workspace/sources/batch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sources }),
        },
      )
    const source = {
      source: { provider: "linear", connectionId: "con_x", scope: {} },
    }

    expect((await batch([source], { signedIn: false })).status).toBe(401)
    expect((await batch([])).status).toBe(400)
    expect((await batch(Array.from({ length: 21 }, () => source))).status).toBe(
      400,
    )
    // 1 and 20 sources pass the bounds and reach the Workspace lookup.
    expect((await batch([source])).status).toBe(404)
    expect((await batch(Array.from({ length: 20 }, () => source))).status).toBe(
      404,
    )
  })
})
