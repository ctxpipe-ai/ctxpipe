import { createHmac } from "node:crypto"
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

const signingSecret = "zendesk-webhook-secret-for-sources"
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>
let connectionId: string

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

async function post(input: { type: string; secret?: string; path?: string }) {
  // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
  const { registerZendeskWebhookRoute } = await import("./zendesk.js")
  const hono = app()
  registerZendeskWebhookRoute(hono)
  const body = JSON.stringify({
    type: input.type,
    account_id: 1,
    detail: { id: "1" },
  })
  const timestamp = new Date().toISOString()
  const signature = createHmac("sha256", input.secret ?? signingSecret)
    .update(`${timestamp}${body}`)
    .digest("base64")
  return hono.request(input.path ?? `/api/v1/webhook/zendesk/${connectionId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zendesk-webhook-signature": signature,
      "x-zendesk-webhook-signature-timestamp": timestamp,
    },
    body,
  })
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

describe("Zendesk webhook routes to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("zendesk_hook")
    env = parseEnv(process.env)
    connectionId = await seed.addConnection("zendesk", {
      subdomain: "acme",
      status: "installed",
      accessTokenEnc: encryptConnectionSecret("access", env),
      webhookId: "01WH",
      webhookSecretEnc: encryptConnectionSecret(signingSecret, env),
    })
    await getSystemDb().insert(connectionDirectory).values({
      connectionId,
      orgId: seed.orgId,
      type: "zendesk",
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: await seed.addWorkspace("zd-hook-docs"),
      revision: "e".repeat(40),
      rows: [
        {
          sourceKey: "docs",
          provider: "zendesk",
          connectionId,
          scope: { categories: ["36"] },
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
    const { closeOpenWorkflowClient } = await import(
      "../../../openworkflow/client.js"
    )
    await closeOpenWorkflowClient()
  })

  it("refuses a delivery signed with another secret", async () => {
    expect(
      (
        await post({
          type: "zen:event-type:article.published",
          secret: "not-the-secret",
        })
      ).status,
    ).toBe(401)
    expect(await sourceRuns()).toEqual([])
  })

  it("refuses a delivery for an unknown connection", async () => {
    expect(
      (
        await post({
          type: "zen:event-type:article.published",
          path: "/api/v1/webhook/zendesk/con_unknown",
        })
      ).status,
    ).toBe(401)
  })

  it("acks another event type without a sync", async () => {
    expect(
      (await post({ type: "zen:event-type:article.vote_created" })).status,
    ).toBe(200)
    expect(await sourceRuns()).toEqual([])
  })

  it("queues one sync at the end of the window for many article events", async () => {
    expect(
      (await post({ type: "zen:event-type:article.published" })).status,
    ).toBe(200)
    expect(
      (await post({ type: "zen:event-type:article.unpublished" })).status,
    ).toBe(200)
    const runs = await sourceRuns()
    expect(runs).toHaveLength(1)
    // The sync reads only the Help Center: ticket views have no events.
    expect(runs[0]).toMatchObject({ connectionId, event: { kind: "articles" } })
    const windowMs = 10 * 60 * 1000
    expect(new Date(runs[0]?.availableAt ?? 0).getTime() % windowMs).toBe(0)
  })
})
