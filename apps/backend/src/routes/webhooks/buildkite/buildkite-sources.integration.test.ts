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

const webhookToken = "buildkite-webhook-token-for-sources"
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

async function post(input: {
  event: string
  token?: string
  path?: string
  at?: number
}) {
  // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
  const { registerBuildkiteWebhookRoute } = await import("./buildkite.js")
  const hono = app()
  registerBuildkiteWebhookRoute(hono)
  const body = JSON.stringify({
    event: input.event,
    build: { number: 1 },
  })
  const timestamp = String(Math.floor((input.at ?? Date.now()) / 1000))
  const signature = createHmac("sha256", input.token ?? webhookToken)
    .update(`${timestamp}.${body}`)
    .digest("hex")
  return hono.request(
    input.path ?? `/api/v1/webhook/buildkite/${connectionId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-buildkite-event": input.event,
        "x-buildkite-signature": `timestamp=${timestamp},signature=${signature}`,
      },
      body,
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

describe("Buildkite webhook routes to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("buildkite_hook")
    env = parseEnv(process.env)
    connectionId = await seed.addConnection("buildkite", {
      organizationSlug: "acme",
      apiTokenEnc: encryptConnectionSecret("fixture-api-token", env),
      webhookTokenEnc: encryptConnectionSecret(webhookToken, env),
      status: "installed",
    })
    await getSystemDb().insert(connectionDirectory).values({
      connectionId,
      orgId: seed.orgId,
      type: "buildkite",
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: await seed.addWorkspace("bk-hook-ci"),
      revision: "e".repeat(40),
      rows: [
        {
          sourceKey: "ci",
          provider: "buildkite",
          connectionId,
          scope: { pipelines: ["web-app"] },
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

  it("refuses a delivery signed with another token", async () => {
    expect(
      (await post({ event: "build.finished", token: "not-the-token" })).status,
    ).toBe(401)
    expect(await sourceRuns()).toEqual([])
  })

  it("refuses a delivery for an unknown connection", async () => {
    expect(
      (
        await post({
          event: "build.finished",
          path: "/api/v1/webhook/buildkite/con_unknown",
        })
      ).status,
    ).toBe(401)
  })

  it("refuses a delivery for a connection with a malformed config", async () => {
    const malformedId = await seed.addConnection("buildkite", {
      organizationSlug: 42,
      status: "unknown",
    })
    await getSystemDb().insert(connectionDirectory).values({
      connectionId: malformedId,
      orgId: seed.orgId,
      type: "buildkite",
    })
    expect(
      (
        await post({
          event: "build.finished",
          path: `/api/v1/webhook/buildkite/${malformedId}`,
        })
      ).status,
    ).toBe(401)
    expect(await sourceRuns()).toEqual([])
  })

  it("refuses a delivery whose secret does not decrypt, as an unknown connection", async () => {
    const tampered = encryptConnectionSecret(webhookToken, env)
    const brokenId = await seed.addConnection("buildkite", {
      organizationSlug: "acme",
      apiTokenEnc: encryptConnectionSecret("fixture-api-token", env),
      webhookTokenEnc: `${tampered.slice(0, -8)}AAAAAAAA`,
      status: "installed",
    })
    await getSystemDb().insert(connectionDirectory).values({
      connectionId: brokenId,
      orgId: seed.orgId,
      type: "buildkite",
    })

    const broken = await post({
      event: "build.finished",
      path: `/api/v1/webhook/buildkite/${brokenId}`,
    })
    const unknown = await post({
      event: "build.finished",
      path: "/api/v1/webhook/buildkite/con_unknown",
    })

    expect(broken.status).toBe(401)
    expect(await broken.json()).toEqual(await unknown.json())
    expect(await sourceRuns()).toEqual([])
  })

  it("acks a ping without a sync", async () => {
    expect((await post({ event: "ping" })).status).toBe(200)
    expect(await sourceRuns()).toEqual([])
  })

  it("queues one sync at the end of the window for many finished builds", async () => {
    expect((await post({ event: "build.finished" })).status).toBe(200)
    expect((await post({ event: "build.finished" })).status).toBe(200)
    const runs = await sourceRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ connectionId, event: null })
    const windowMs = 10 * 60 * 1000
    expect(new Date(runs[0]?.availableAt ?? 0).getTime() % windowMs).toBe(0)
    expect(new Date(runs[0]?.availableAt ?? 0).getTime()).toBeGreaterThan(
      Date.now(),
    )
  })
})
