import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { members } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type { SourceProvider } from "../../domain/workspace-sources/sources-file.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
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
  const id = `sync_now_${Date.now()}_${Math.random().toString(36).slice(2)}`
  vi.stubEnv("OPENWORKFLOW_NAMESPACE_ID", id)
  return id
})

describe("POST /connectors/{connectionId}/sync (Postgres)", () => {
  let seed: SeededOrg
  let backend: BackendPostgres
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

  const syncNow = (connectionId: string) =>
    createApp().request(
      `http://backend.test/${seed.orgSlug}/api/v1/connectors/${connectionId}/sync`,
      { method: "POST", headers: { cookie: seed.cookie } },
    )

  async function queuedSyncs(connectionId: string) {
    const runs = await backend.listWorkflowRuns({ limit: 1000 })
    return runs.data.filter(
      (run) =>
        run.workflowName === "workspace-sources-sync" &&
        (run.input as { connectionId?: string })?.connectionId === connectionId,
    )
  }

  async function addConnection(type: "pagerduty" | "notion" | "slack") {
    const id = `con_${type}_${Math.random().toString(36).slice(2)}`
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .insert(connections)
        .values({ id, orgId: seed.orgId, type, config: {} }),
    )
    return id
  }

  async function addSource(
    connectionId: string,
    source: { provider: SourceProvider; scope: Record<string, unknown> } = {
      provider: "pagerduty",
      scope: { services: ["PSVC001"] },
    },
  ) {
    const workspaceId = `ws_sync_now_${Math.random().toString(36).slice(2)}`
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId: seed.orgId,
        slug: workspaceId.replaceAll("_", "-"),
        displayName: "On call",
        workspaceRepositoryUrl: `https://github.com/acme/${workspaceId}.git`,
        desiredDefaultBranch: "main",
      }),
    )
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [
        {
          sourceKey: "on-call",
          provider: source.provider,
          connectionId,
          scope: source.scope,
          status: "ok",
          statusDetail: null,
        },
      ],
    })
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
    backend = await BackendPostgres.connect(process.env.DATABASE_URL, {
      runMigrations: false,
      namespaceId,
    })
  })

  afterAll(async () => {
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId))
      await db.delete(connections).where(eq(connections.orgId, seed.orgId))
    })
    await backend?.stop()
    const { closeOpenWorkflowClient } =
      await import("../../openworkflow/client.js")
    await closeOpenWorkflowClient()
    if (seed) await cleanupSeededOrg(seed)
    vi.unstubAllEnvs()
  })

  it("starts one full sync for a double click", async () => {
    const connectionId = await addConnection("pagerduty")
    await addSource(connectionId)

    const first = await syncNow(connectionId)
    const second = await syncNow(connectionId)

    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ accepted: true })
    expect(second.status).toBe(202)
    const runs = await queuedSyncs(connectionId)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.input).toMatchObject({
      kind: "connection",
      orgId: seed.orgId,
      connectionId,
      provider: "pagerduty",
      // A manual sync does not count toward the bounded failure tries.
      manual: true,
    })
    expect((runs[0]?.input as { event?: unknown }).event).toBeUndefined()
  })

  it("gives 404 for a Slack connection: Slack sources capture, they do not sync", async () => {
    const connectionId = await addConnection("slack")
    await addSource(connectionId, {
      provider: "slack",
      scope: { channels: ["C0FIXTURE1"] },
    })

    const res = await syncNow(connectionId)

    expect(res.status).toBe(404)
    expect(await queuedSyncs(connectionId)).toEqual([])
  })

  it("gives 404 for a connection without an ok source", async () => {
    const connectionId = await addConnection("notion")

    const res = await syncNow(connectionId)

    expect(res.status).toBe(404)
    expect(await queuedSyncs(connectionId)).toEqual([])
  })

  it("refuses an org member who is not an admin", async () => {
    const connectionId = await addConnection("pagerduty")
    await addSource(connectionId)
    await setRole("member")
    try {
      const res = await syncNow(connectionId)

      expect(res.status).toBe(403)
      expect(await queuedSyncs(connectionId)).toEqual([])
    } finally {
      await setRole("owner")
    }
  })
})
