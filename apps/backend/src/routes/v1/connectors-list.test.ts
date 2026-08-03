import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getSuggestedConnectorSyncTargetMock = vi.hoisted(() => vi.fn())
const listOrgConnectionsMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/connector-sync-target.js", () => ({
  getSuggestedConnectorSyncTarget: getSuggestedConnectorSyncTargetMock,
}))

vi.mock("../../models/org-connections.js", () => ({
  listOrgConnections: listOrgConnectionsMock,
}))

import { connectorsListRoutes } from "./connectors-list.js"

function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "session_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    await next()
  })
  app.route("/connectors", connectorsListRoutes)
  return app
}

describe("connector routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listOrgConnectionsMock.mockResolvedValue([])
    getSuggestedConnectorSyncTargetMock.mockResolvedValue(null)
  })

  it("returns the repository already shared by connector targets", async () => {
    getSuggestedConnectorSyncTargetMock.mockResolvedValueOnce({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      gitUrl: "https://github.com/acme/context.git",
      branch: "main",
      usedBy: ["confluence"],
    })

    const response = await createApp().request(
      "/connectors/suggested-sync-target",
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      target: {
        repositoryId: "repo_1",
        repositoryName: "acme/context",
        gitUrl: "https://github.com/acme/context.git",
        branch: "main",
        usedBy: ["confluence"],
      },
    })
    expect(getSuggestedConnectorSyncTargetMock).toHaveBeenCalledWith("org_1")
  })
})
