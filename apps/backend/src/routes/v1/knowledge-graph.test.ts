import { OpenAPIHono } from "@hono/zod-openapi"
import { contextStorage } from "hono/context-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const getKnowledgeGraphSnapshotMock = vi.hoisted(() => vi.fn())
const getKnowledgeGraphReviewMock = vi.hoisted(() => vi.fn())

vi.mock("../../domain/knowledgeGraphSnapshot.js", () => ({
  getKnowledgeGraphSnapshot: getKnowledgeGraphSnapshotMock,
}))

vi.mock("../../domain/knowledgeGraphReview.js", () => ({
  getKnowledgeGraphReview: getKnowledgeGraphReviewMock,
}))

import { knowledgeGraphRoutes } from "./knowledge-graph.js"

function appForKnowledgeGraph(options?: { authenticated?: boolean }) {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    if (options?.authenticated !== false) {
      c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    } else {
      c.set("user", null)
      c.set("session", null)
    }
    c.set("orgId", "org_1")
    c.set("orgSlug", "acme")
    await next()
  })
  app.route("/:orgSlug/knowledge-graph", knowledgeGraphRoutes)
  return app
}

describe("knowledge graph routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getKnowledgeGraphSnapshotMock.mockResolvedValue({
      metrics: {
        totalNodes: 0,
        totalEdges: 0,
        lastUpdatedAt: null,
        nodesReturned: 0,
        edgesReturned: 0,
        truncated: false,
      },
      nodes: [],
      edges: [],
    })
    getKnowledgeGraphReviewMock.mockResolvedValue({
      total: 1,
      confidenceBelow: 0.6,
      limit: 10,
      items: [],
    })
  })

  it("returns low-confidence review items for the current org", async () => {
    const res = await appForKnowledgeGraph().request(
      "/acme/knowledge-graph/review?confidenceBelow=0.6&limit=10",
    )

    expect(res.status).toBe(200)
    expect(getKnowledgeGraphReviewMock).toHaveBeenCalledWith({
      orgId: "org_1",
      orgSlug: "acme",
      confidenceBelow: 0.6,
      limit: 10,
    })
    expect(await res.json()).toEqual({
      total: 1,
      confidenceBelow: 0.6,
      limit: 10,
      items: [],
    })
  })

  it("rejects unauthenticated review requests", async () => {
    const res = await appForKnowledgeGraph({ authenticated: false }).request(
      "/acme/knowledge-graph/review",
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
    expect(getKnowledgeGraphReviewMock).not.toHaveBeenCalled()
  })
})
