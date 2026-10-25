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

const secret = "pagerduty-subscription-secret-for-sources"
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>
let subscription: string
let withSources: string

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

async function post(event: Record<string, unknown>) {
  // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
  const { registerPagerdutyWebhookRoute } = await import("./pagerduty.js")
  const hono = app()
  registerPagerdutyWebhookRoute(hono)
  const body = JSON.stringify({
    event: { occurred_at: new Date().toISOString(), ...event },
  })
  return hono.request("/api/v1/webhook/pagerduty", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pagerduty-subscription": subscription,
      "x-pagerduty-signature": `v1=${createHmac("sha256", secret).update(body).digest("hex")}`,
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

const incident = (id: string, incidentId: string, serviceId?: string) => ({
  id,
  event_type: "incident.triggered",
  data: {
    id: incidentId,
    ...(serviceId ? { service: { id: serviceId } } : {}),
  },
})

describe("PagerDuty webhook routes to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("pagerduty_hook")
    env = parseEnv(process.env)
    subscription = `PSUB${seed.suffix.replaceAll("_", "")}`.slice(0, 30)
    // Not live in the legacy setup: only the sources sync can take events.
    withSources = await seed.addConnection("pagerduty", {
      accessTokenEnc: encryptConnectionSecret("fixture-token", env),
      accountId: "PACCT01",
      accountName: "Acme Test",
      accountSubdomain: "acme-test",
      region: "us",
      ownerUserId: "user_fixture",
      status: "installed",
      webhookSubscriptionId: subscription,
      webhookSecretEnc: encryptConnectionSecret(secret, env),
    })
    await getSystemDb().insert(connectionDirectory).values({
      connectionId: withSources,
      orgId: seed.orgId,
      type: "pagerduty",
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: await seed.addWorkspace("pd-hook-on-call"),
      revision: "e".repeat(40),
      rows: [
        {
          sourceKey: "on-call",
          provider: "pagerduty",
          connectionId: withSources,
          scope: { services: ["PSVC001"] },
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

  it("enqueues one sources sync with the incident and its service", async () => {
    expect((await post(incident("evt_1", "PINC001", "PSVC001"))).status).toBe(
      200,
    )
    expect(await sourceRuns()).toEqual([
      {
        connectionId: withSources,
        event: { incidentId: "PINC001", serviceId: "PSVC001" },
      },
    ])
  })

  it("starts no second sources sync for a repeated delivery of one event", async () => {
    const before = (await sourceRuns()).length
    expect((await post(incident("evt_1", "PINC001", "PSVC001"))).status).toBe(
      200,
    )
    expect(await sourceRuns()).toHaveLength(before)
    expect((await post(incident("evt_2", "PINC001", "PSVC001"))).status).toBe(
      200,
    )
    expect(await sourceRuns()).toHaveLength(before + 1)
  })

  it("acks an incident without a service id without a sources sync", async () => {
    const before = (await sourceRuns()).length
    expect((await post(incident("evt_3", "PINC002"))).status).toBe(200)
    expect(await sourceRuns()).toHaveLength(before)
  })
})
