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

const secret = "slack-signing-secret-for-sources"
const ENG = "C0ENG0001"
const BOT = "U0BOT0001"
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let slack: string
let teamId: string

function app() {
  const env = parseEnv({ ...process.env, SLACK_SIGNING_SECRET: secret })
  const hono = new OpenAPIHono<AppEnv>()
  hono.use(contextStorage())
  hono.use("*", async (c, next) => {
    c.set("env", env)
    c.set("log", createLogger())
    await next()
  })
  return hono
}

async function post(eventId: string, event: Record<string, unknown>) {
  // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
  const { registerSlackWebhookRoute } = await import("./slack.js")
  const hono = app()
  registerSlackWebhookRoute(hono)
  const body = JSON.stringify({
    type: "event_callback",
    team_id: teamId,
    event_id: eventId,
    event,
  })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`
  return hono.request("/api/v1/webhook/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  })
}

async function runs() {
  const result = await getSystemDb().execute(
    sql`select input->>'connectionId' as "connectionId", input->'event' as "event" from openworkflow.workflow_runs where workflow_name = 'workspace-sources-sync' and input->>'orgId' = ${seed.orgId} order by created_at`,
  )
  return result.rows as Array<{ connectionId: string; event: unknown }>
}

const reply = (ts: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  channel: ENG,
  channel_type: "channel",
  user: "U0PERSON1",
  ts,
  thread_ts: "1790000000.000100",
  ...extra,
})

describe("Slack webhook routes messages to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    seed = await seedSourcesOrg("slack_hook")
    teamId = `T0${seed.suffix}`.toUpperCase().slice(0, 20)
    slack = await seed.addConnection("slack", {
      teamId,
      teamName: "Example",
      botUserId: BOT,
      status: "installed",
    })
    await getSystemDb().insert(connectionDirectory).values({
      connectionId: slack,
      orgId: seed.orgId,
      type: "slack",
      slackTeamId: teamId,
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: await seed.addWorkspace("eng"),
      revision: "d".repeat(40),
      rows: [
        {
          sourceKey: "eng-channels",
          provider: "slack",
          connectionId: slack,
          scope: { channels: [ENG] },
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

  it("enqueues one sources sync for a thread reply in a source channel", async () => {
    expect((await post("Ev0REPLY1", reply("1790000600.000100"))).status).toBe(
      200,
    )
    expect(await runs()).toEqual([
      {
        connectionId: slack,
        event: { channelId: ENG, threadTs: "1790000000.000100" },
      },
    ])
  })

  it("starts no second sync for a repeated delivery of the same event", async () => {
    const before = (await runs()).length
    await post("Ev0REPLY1", reply("1790000600.000100"))
    expect(await runs()).toHaveLength(before)
  })

  it("enqueues nothing for a channel without a source, a message without a thread, or the own bot", async () => {
    const before = (await runs()).length
    await post(
      "Ev0OTHER1",
      reply("1790000601.000100", { channel: "C0OPS0001" }),
    )
    await post(
      "Ev0ROOT01",
      reply("1790000602.000100", { thread_ts: undefined }),
    )
    await post("Ev0BOT001", reply("1790000603.000100", { user: BOT }))
    expect(await runs()).toHaveLength(before)
  })
})
