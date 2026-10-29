import { OpenAPIHono } from "@hono/zod-openapi"
import { sql } from "drizzle-orm"
import { createLogger } from "evlog"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import { getSystemDb } from "../../../db/client.js"
import { connectionDirectory } from "../../../db/schema/connections.js"
import { encryptConnectionSecret } from "../../../lib/connection-secrets.js"
import { replaceWorkspaceSourceRows } from "../../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../../test/workspace-sources-fixture.js"

const webhookToken = "plain-webhook-token-for-sources"
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>
let connectionId: string
let revokedId: string

function app() {
  const hono = new OpenAPIHono<AppEnv>()
  hono.use(contextStorage())
  hono.use("*", async (c, next) => {
    c.set("env", env)
    c.set("log", createLogger())
    await next()
  })
  return hono
}

async function post(input: { token?: string | null; connection?: string }) {
  // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
  const { registerPlainWebhookRoute } = await import("./plain.js")
  const hono = app()
  registerPlainWebhookRoute(hono)
  const token = input.token === undefined ? webhookToken : input.token
  return hono.request(
    `/api/v1/webhook/plain/${input.connection ?? connectionId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { "x-ctxpipe-webhook-token": token }),
      },
      body: JSON.stringify({
        id: "evt_1",
        type: "timeline.timeline_entry_changed",
        payload: {},
      }),
    },
  )
}

async function sourceRuns() {
  const result = await getSystemDb().execute(
    sql`select input->>'connectionId' as "connectionId", input->'event' as "event", available_at as "availableAt" from openworkflow.workflow_runs where workflow_name = 'workspace-sources-sync' and input->>'orgId' = ${seed.orgId} order by created_at`,
  )
  return result.rows as Array<{
    connectionId: string
    event: unknown
    availableAt: Date
  }>
}

async function addConnection(status: "installed" | "revoked") {
  const id = await seed.addConnection("plain", {
    workspaceId: "w_1",
    workspaceName: "Acme",
    apiKeyEnc: encryptConnectionSecret("key", env),
    status,
    webhookTargetId: "wht_1",
    webhookTokenEnc: encryptConnectionSecret(webhookToken, env),
  })
  await getSystemDb()
    .insert(connectionDirectory)
    .values({ connectionId: id, orgId: seed.orgId, type: "plain" })
  return id
}

describe("Plain webhook routes to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("plain_hook")
    env = parseEnv(process.env)
    connectionId = await addConnection("installed")
    revokedId = await addConnection("revoked")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: await seed.addWorkspace("pl-hook-bugs"),
      revision: "e".repeat(40),
      rows: [
        {
          sourceKey: "bugs",
          provider: "plain",
          connectionId,
          scope: { labels: ["lt_bug"] },
          status: "ok",
          statusDetail: null,
        },
      ],
    })
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${seed.orgId}`,
    )
    await getSystemDb().execute(
      sql`delete from connection_directory where org_id = ${seed.orgId}`,
    )
    await seed.cleanup()
    const { closeOpenWorkflowClient } =
      await import("../../../openworkflow/client.js")
    await closeOpenWorkflowClient()
  })

  it.each([
    ["another token", "not-the-token"],
    ["no token", null],
  ])("refuses a delivery with %s", async (_name, token) => {
    expect((await post({ token })).status).toBe(401)
    expect(await sourceRuns()).toEqual([])
  })

  it("refuses a delivery for an unknown connection", async () => {
    expect((await post({ connection: "con_unknown" })).status).toBe(401)
  })

  it("refuses a delivery whose token does not decrypt, as an unknown connection", async () => {
    const tampered = encryptConnectionSecret(webhookToken, env)
    const brokenId = await seed.addConnection("plain", {
      workspaceId: "w_1",
      workspaceName: "Acme",
      apiKeyEnc: encryptConnectionSecret("key", env),
      status: "installed",
      webhookTargetId: "wht_2",
      webhookTokenEnc: `${tampered.slice(0, -8)}AAAAAAAA`,
    })
    await getSystemDb()
      .insert(connectionDirectory)
      .values({ connectionId: brokenId, orgId: seed.orgId, type: "plain" })

    const broken = await post({ connection: brokenId })
    const unknown = await post({ connection: "con_unknown" })

    expect(broken.status).toBe(401)
    expect(await broken.json()).toEqual(await unknown.json())
    expect(await sourceRuns()).toEqual([])
  })

  it("acks a delivery for a revoked connection without a sync", async () => {
    expect((await post({ connection: revokedId })).status).toBe(200)
    expect(await sourceRuns()).toEqual([])
  })

  it("queues one sync of the labels at the end of the window for many events", async () => {
    expect((await post({})).status).toBe(200)
    expect((await post({})).status).toBe(200)
    const runs = await sourceRuns()
    expect(runs).toHaveLength(1)
    // The sync reads only the labels: Help Center articles have no events.
    expect(runs[0]).toMatchObject({ connectionId, event: { kind: "threads" } })
    const windowMs = 10 * 60 * 1000
    expect(new Date(runs[0]?.availableAt ?? 0).getTime() % windowMs).toBe(0)
  })
})
