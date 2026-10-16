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
const namespaceId = vi.hoisted(() => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  const id = `admin_gates_${Date.now()}_${Math.random().toString(36).slice(2)}`
  vi.stubEnv("OPENWORKFLOW_NAMESPACE_ID", id)
  return id
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

  const del = (path: string) =>
    createApp().request(`http://backend.test/${seed.orgSlug}/api/v1/${path}`, {
      method: "DELETE",
      headers: { cookie: seed.cookie },
    })

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
    const { closeOpenWorkflowClient } = await import(
      "../../openworkflow/client.js"
    )
    await closeOpenWorkflowClient()
    if (seed) await cleanupSeededOrg(seed)
    vi.unstubAllEnvs()
  })

  // A DELETE with no connection never gives 403 from a handler, so a 403 here
  // comes from the gate.
  it.each([
    "github/installation",
    "connectors/atlassian",
    "connectors/slack",
    "connectors/linear",
    "connectors/notion",
    "connectors/pagerduty",
  ])("%s refuses an org member who is not an admin", async (path) => {
    await setRole("member")
    try {
      expect((await del(path)).status).toBe(403)
    } finally {
      await setRole("owner")
    }
  })

  it.each([
    "github/installation",
    "connectors/atlassian",
    "connectors/slack",
    "connectors/linear",
    "connectors/notion",
    "connectors/pagerduty",
  ])("%s lets an owner through the gate", async (path) => {
    expect((await del(path)).status).not.toBe(403)
  })
})
