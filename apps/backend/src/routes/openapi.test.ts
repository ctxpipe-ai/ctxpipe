import { OpenAPIHono } from "@hono/zod-openapi"
import type { hc } from "hono/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../test/hono-test-logger.js"

// Import-time BackendPostgres.connect against DATABASE_URL.
vi.mock("../openworkflow/client.js", () => ({
  ow: { runWorkflow: vi.fn() },
  runWorkflowWithWorkerWake: vi.fn(),
}))

import { registerOpenapiRoutes } from "./openapi.js"
import { registerV1Routes } from "./v1/index.js"

function assertOrgScopedRpcClient(
  client: ReturnType<typeof hc<ReturnType<typeof registerV1Routes>>>,
) {
  return client[":orgSlug"].api.v1.workspaces.$get
}
void assertOrgScopedRpcClient

describe("GET /.docs/openapi", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns a valid OpenAPI 3.1 document", async () => {
    const app = new OpenAPIHono<AppEnv>()
    const v1 = registerV1Routes(app)
    registerOpenapiRoutes(app, v1 as OpenAPIHono<AppEnv>)

    const res = await app.request("http://localhost/.docs/openapi")

    expect(res.status).toBe(200)
    const spec = (await res.json()) as {
      openapi?: unknown
      info?: unknown
      paths?: Record<string, unknown>
    }
    expect(spec).toEqual(
      expect.objectContaining({
        openapi: "3.1.0",
        info: { title: "Backend API", version: "0.1.0" },
      }),
    )
    expect(spec.paths).toEqual(
      expect.objectContaining({
        "/{orgSlug}/api/v1/connectors": expect.objectContaining({
          get: expect.any(Object),
        }),
        "/{orgSlug}/api/v1/workspaces": expect.objectContaining({
          get: expect.any(Object),
        }),
      }),
    )
  })

  it("serves GET /:orgSlug/api/v1/workspaces on the mounted app", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/ctxpipe")
    vi.stubEnv("AUTH_SECRET", "abcdefghijklmnopqrstuvwxyz123456")

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", contextStorage())
    app.use("*", withTestRequestLogger)
    registerV1Routes(app)

    const mounted = await app.request("/some-org/api/v1/workspaces")
    const unmounted = await app.request("/some-org/no-such-api/workspaces")

    expect(mounted.status).toBe(401)
    expect(await mounted.json()).toEqual({ error: "Unauthorized" })
    expect(unmounted.status).toBe(404)
  })
})
