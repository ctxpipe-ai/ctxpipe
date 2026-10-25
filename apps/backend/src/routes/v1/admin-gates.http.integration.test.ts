import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { members } from "../../db/schema/auth.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at
// import time. The OpenWorkflow client reads its namespace on import: keep
// these runs apart from other files.
vi.hoisted(() => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  const id = `admin_gates_${Date.now()}_${Math.random().toString(36).slice(2)}`
  vi.stubEnv("OPENWORKFLOW_NAMESPACE_ID", id)
})

describe("admin-gated connector routes (Postgres)", () => {
  let seed: SeededOrg
  const env = parseEnv(process.env as Record<string, string | undefined>)

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use(evlog())
    app.use(withTestRequestLogger)
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("user", null)
      c.set("session", null)
      c.set("oauthReferenceId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    registerV1Routes(app)
    return app
  }

  // A route is "METHOD path".
  const call = (route: string) => {
    const [method, path] = route.split(" ")
    return createApp().request(
      `http://backend.test/${seed.orgSlug}/api/v1/${path}`,
      { method, headers: { cookie: seed.cookie } },
    )
  }

  async function setRole(role: string) {
    await getSystemDb()
      .update(members)
      .set({ role })
      .where(
        and(
          eq(members.organizationId, seed.orgId),
          eq(members.userId, seed.userId),
        ),
      )
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    seed = await seedOrg()
  })

  afterAll(async () => {
    const { closeOpenWorkflowClient } =
      await import("../../openworkflow/client.js")
    await closeOpenWorkflowClient()
    if (seed) await cleanupSeededOrg(seed)
    vi.unstubAllEnvs()
  })

  // One real route of each admin group, with the success status an owner gets
  // from an org with no connection. A 403 for a member comes from the gate. A
  // 200 for an owner shows that the route is mounted.
  const routes = [
    "POST github/installation/draft/placeholder",
    "GET connectors/atlassian/status",
    "GET connectors/slack/status",
    "GET connectors/linear/status",
    "GET connectors/notion/status",
    "GET connectors/pagerduty/status",
  ]

  it.each(routes)(
    "%s refuses an org member who is not an admin",
    async (path) => {
      await setRole("member")
      try {
        expect((await call(path)).status).toBe(403)
      } finally {
        await setRole("owner")
      }
    },
  )

  it.each(routes)("%s answers 200 for an owner", async (path) => {
    expect((await call(path)).status).toBe(200)
  })
})
