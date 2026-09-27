import { OpenAPIHono } from "@hono/zod-openapi"
import type { hc } from "hono/client"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import { closeDb, initDb } from "../db/client.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../test/hono-test-logger.js"

import { registerOpenapiRoutes } from "./openapi.js"

let registerV1Routes: typeof import("./v1/index.js").registerV1Routes
let closeOpenWorkflowClient: typeof import("../openworkflow/client.js").closeOpenWorkflowClient

function assertOrgScopedRpcClient(
  client: ReturnType<
    typeof hc<ReturnType<typeof import("./v1/index.js").registerV1Routes>>
  >,
) {
  return client[":orgSlug"].api.v1.workspaces.$get
}
void assertOrgScopedRpcClient

describeWithDatabase("GET /.docs/openapi", () => {
  beforeAll(async () => {
    initDb(process.env.DATABASE_URL as string)
    ;({ registerV1Routes } = await import("./v1/index.js"))
    ;({ closeOpenWorkflowClient } = await import("../openworkflow/client.js"))
  })

  afterAll(async () => {
    await closeOpenWorkflowClient()
    await closeDb()
  })

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
