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

const secret = "linear-webhook-secret-for-sources"
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let withSources: string
let withoutSources: string
let linearOrg: string

function app() {
  const env = parseEnv({ ...process.env, LINEAR_WEBHOOK_SECRET: secret })
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
  const { registerLinearWebhookRoute } = await import("./linear.js")
  const hono = app()
  registerLinearWebhookRoute(hono)
  const body = JSON.stringify({
    organizationId: linearOrg,
    webhookTimestamp: Date.now(),
    ...payload,
  })
  return hono.request("/api/v1/webhook/linear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", secret)
        .update(body)
        .digest("hex"),
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

describe("Linear webhook routes to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("linear_hook")
    linearOrg = `linear-org-${seed.suffix}`
    const config = { status: "installed", workspaceId: linearOrg }
    withSources = await seed.addConnection("linear", config)
    withoutSources = await seed.addConnection("linear", config)
    await getSystemDb()
      .insert(connectionDirectory)
      .values(
        [withSources, withoutSources].map((connectionId) => ({
          connectionId,
          orgId: seed.orgId,
          type: "linear" as const,
          linearWorkspaceId: linearOrg,
        })),
      )
    const workspaceId = await seed.addWorkspace("ops")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "d".repeat(40),
      rows: [
        {
          sourceKey: "ops-issues",
          provider: "linear",
          connectionId: withSources,
          scope: { teams: ["OPS"] },
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

  it("enqueues one sources sync for the connection with sources, with the event's team and project", async () => {
    const response = await post({
      type: "Issue",
      action: "update",
      data: {
        id: "issue-1",
        identifier: "OPS-1",
        teamId: "team-ops",
        projectId: "project-1",
      },
    })
    expect(response.status).toBe(200)
    expect(await sourceRuns()).toEqual([
      {
        connectionId: withSources,
        event: { teamKeys: ["OPS"], projectIds: ["project-1"] },
      },
    ])
  })

  it("does not enqueue a sources sync for an event that has no entity", async () => {
    const before = (await sourceRuns()).length
    const response = await post({
      type: "Reaction",
      action: "create",
      data: { id: "reaction-1" },
    })
    expect(response.status).toBe(200)
    expect(await sourceRuns()).toHaveLength(before)
  })
})
