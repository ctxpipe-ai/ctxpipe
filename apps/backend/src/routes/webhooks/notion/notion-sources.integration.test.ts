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
import { replaceWorkspaceSourceRows } from "../../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../../test/workspace-sources-fixture.js"

const secret = "notion-webhook-secret-for-sources"
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let withSources: string
let revoked: string
let withoutSources: string
let notionWorkspace: string

function app() {
  const env = parseEnv({ ...process.env, NOTION_WEBHOOK_SECRET: secret })
  const hono = new OpenAPIHono<AppEnv>()
  hono.use(contextStorage())
  hono.use("*", async (c, next) => {
    c.set("env", env)
    c.set("log", createLogger())
    await next()
  })
  return hono
}

async function post(payload: Record<string, unknown>) {
  // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
  const { registerNotionWebhookRoute } = await import("./notion.js")
  const hono = app()
  registerNotionWebhookRoute(hono)
  const body = JSON.stringify({ workspace_id: notionWorkspace, ...payload })
  return hono.request("/api/v1/webhook/notion", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-notion-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  })
}

async function sourceRuns() {
  const result = await getSystemDb().execute(
    sql`select input->>'connectionId' as "connectionId", input->'event' as "event" from openworkflow.workflow_runs where workflow_name = 'workspace-sources-sync' and input->>'orgId' = ${seed.orgId} order by created_at`,
  )
  return result.rows as Array<{ connectionId: string; event: unknown }>
}

async function addSource(connectionId: string, slug: string) {
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId: await seed.addWorkspace(slug),
    revision: "e".repeat(40),
    rows: [
      {
        sourceKey: "notes",
        provider: "notion",
        connectionId,
        scope: {
          pages: [
            { id: "1a2b3c4d-0000-4000-8000-000000000001", title: "Handbook" },
          ],
        },
        status: "ok",
        statusDetail: null,
      },
    ],
  })
}

describe("Notion webhook routes to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("notion_hook")
    notionWorkspace = `notion-ws-${seed.suffix}`
    const connection = (status: string) =>
      seed.addConnection("notion", {
        status,
        accessToken: "fixture-token",
        workspaceId: notionWorkspace,
      })
    withSources = await connection("installed")
    await addSource(withSources, "notion-hook-notes")
    revoked = await connection("revoked")
    await addSource(revoked, "notion-hook-revoked")
    withoutSources = await connection("installed")
    await getSystemDb()
      .insert(connectionDirectory)
      .values(
        [withSources, revoked, withoutSources].map((connectionId) => ({
          connectionId,
          orgId: seed.orgId,
          type: "notion" as const,
          notionWorkspaceId: notionWorkspace,
        })),
      )
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

  const pageEvent = {
    id: "evt_page_1",
    type: "page.content_updated",
    entity: { id: "page-1", type: "page" },
  }

  it("enqueues a sources sync only for an installed connection with ok sources", async () => {
    expect((await post(pageEvent)).status).toBe(200)
    expect(await sourceRuns()).toEqual([
      {
        connectionId: withSources,
        event: { entityType: "page", externalId: "page-1", action: "upsert" },
      },
    ])
  })

  it("starts no second sources sync for a repeated delivery of one event", async () => {
    const before = (await sourceRuns()).length
    expect((await post(pageEvent)).status).toBe(200)
    expect(await sourceRuns()).toHaveLength(before)
    expect((await post({ ...pageEvent, id: "evt_page_2" })).status).toBe(200)
    expect(await sourceRuns()).toHaveLength(before + 1)
  })
})
