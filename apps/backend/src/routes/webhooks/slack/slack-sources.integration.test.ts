import { createHmac } from "node:crypto"

import { OpenAPIHono } from "@hono/zod-openapi"
import { sql } from "drizzle-orm"
import { createLogger } from "evlog"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import { getSystemDb } from "../../../db/client.js"
import { connectionDirectory } from "../../../db/schema/connections.js"
import { encodeSlackBotTokenForDb } from "../../../lib/connection-config.js"
import { seedSourcesOrg } from "../../../test/workspace-sources-fixture.js"

const secret = "slack-signing-secret-for-sources"
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

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

/** A signed `app_mention` reply inside a thread of the team. */
async function mention(teamId: string, mentionTs: string) {
  // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
  const { registerSlackWebhookRoute } = await import("./slack.js")
  const hono = app()
  registerSlackWebhookRoute(hono)
  const body = JSON.stringify({
    type: "event_callback",
    team_id: teamId,
    event_id: `Ev${mentionTs}`,
    event: {
      type: "app_mention",
      channel: "C0ENG0001",
      channel_type: "channel",
      ts: mentionTs,
      thread_ts: "1790000000.000100",
      text: "<@U0BOT0001>",
      user: "U0PERSON1",
    },
  })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`
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

async function runs(connectionId: string) {
  const result = await getSystemDb().execute(
    sql`select input->>'threadTs' as "threadTs" from openworkflow.workflow_runs where workflow_name = 'slack-mention-agent' and input->>'connectionId' = ${connectionId}`,
  )
  return result.rows as Array<{ threadTs: string }>
}

/** A Slack connection of its own team, with a directory row for the webhook. */
async function slackConnection(name: string, config: object) {
  const teamId = `T${name}${seed.suffix}`
  const connectionId = await seed.addConnection("slack", {
    botTokenEnc: encodeSlackBotTokenForDb(
      "xoxb-fixture",
      parseEnv(process.env),
    ),
    teamId,
    teamName: "Example",
    botUserId: "U0BOT0001",
    ownerUserId: "fixture-owner",
    ...config,
  })
  await getSystemDb().insert(connectionDirectory).values({
    connectionId,
    orgId: seed.orgId,
    type: "slack",
    slackTeamId: teamId,
  })
  return { connectionId, teamId }
}

describe("Slack webhook starts the mention agent for Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("slack_hook")
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

  // Setup does not write a repository binding, and the ADR-050 migration
  // sets `enabled: false` on an old binding. The agent routes the capture to
  // the sources of the channel, or replies that no source has it.
  it.each([
    { name: "unbound", legacyConfig: {} },
    {
      name: "migrated",
      legacyConfig: {
        repositoryId: "repo_old",
        branch: "main",
        enabled: false,
      },
    },
  ])(
    "enqueues the agent for a $name installed connection",
    async ({ name, legacyConfig }) => {
      const { connectionId, teamId } = await slackConnection(name, {
        status: "installed",
        ...legacyConfig,
      })
      expect((await mention(teamId, "1790000100.000100")).status).toBe(200)
      await vi.waitFor(async () =>
        expect(await runs(connectionId)).toEqual([
          { threadTs: "1790000000.000100" },
        ]),
      )
    },
  )
})
