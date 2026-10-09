import { OpenAPIHono } from "@hono/zod-openapi"
import { describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

const { getAccessibleRepositoryMock } = vi.hoisted(() => ({
  getAccessibleRepositoryMock: vi.fn(),
}))

vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
}))

import { registerGraphRoutes } from "./graph.js"

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  // The route reads one checkout row before it resolves the file path.
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ id: "chk_test" }] }),
      }),
    }),
  }
  app.use("*", async (c, next) => {
    c.set("db", db as unknown as AppEnv["Variables"]["db"])
    c.set("auth", {
      sub: "user_test",
      orgId: "org_mock123",
      principal: "user",
    } as AppEnv["Variables"]["auth"])
    await next()
  })
  registerGraphRoutes(app)
  return app
}

describe("POST /{repoId}/graph", () => {
  it.each([".git/config", "../outside.ts"])(
    "answers 404 for the file path %s",
    async (filePath) => {
      getAccessibleRepositoryMock.mockResolvedValue({
        id: "repo_abcdef27",
        orgId: "org_mock123",
      })

      const res = await createTestApp().request("/repo_abcdef27/graph", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ primitive: "get_imports", filePath }),
      })

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "Path not found" })
    },
  )
})
