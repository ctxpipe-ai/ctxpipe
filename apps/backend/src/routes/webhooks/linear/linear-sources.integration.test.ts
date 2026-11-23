import { createHmac } from "node:crypto"

import { OpenAPIHono } from "@hono/zod-openapi"
import { eq, sql } from "drizzle-orm"
import { createLogger } from "evlog"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../../db/client.js"
import { connectionDirectory } from "../../../db/schema/connections.js"
import { repositories } from "../../../db/schema/repositories.js"
import { replaceWorkspaceSourceRows } from "../../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../../test/workspace-sources-fixture.js"

const secret = "linear-webhook-secret-for-sources"
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let retired: string
let parallel: string
let withoutSources: string
let linearOrg: string
const repositoryIds: string[] = []

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

async function runs(workflow: string) {
  const result = await getSystemDb().execute(
    sql`select input->>'connectionId' as "connectionId", input->'event' as "event" from openworkflow.workflow_runs where workflow_name = ${workflow} and input->>'orgId' = ${seed.orgId} order by created_at`,
  )
  return result.rows as Array<{ connectionId: string; event: unknown }>
}

/** The events that wait for the coalesced sync of each connection. */
async function waitingEvents() {
  const result = await withOrgDbContext(seed.orgId, (db) =>
    db.execute(
      sql`select connection_id as "connectionId", event from source_sync_events order by created_at, id`,
    ),
  )
  return result.rows as Array<{ connectionId: string; event: unknown }>
}

/** A Linear connection with a live legacy binding to a new sync repository. */
async function legacyConnection(name: string) {
  const id = `repo_${name}_${seed.suffix}`
  const gitUrl = `https://github.com/example/${name}-${seed.suffix}.git`
  await withOrgDbContext(seed.orgId, (db) =>
    db.insert(repositories).values({
      id,
      orgId: seed.orgId,
      name: `example/${name}-${seed.suffix}`,
      gitUrl,
    }),
  )
  repositoryIds.push(id)
  const connectionId = await seed.addConnection("linear", {
    status: "installed",
    workspaceId: linearOrg,
    workspaceName: "Example",
    repositoryId: id,
    branch: "main",
    enabled: true,
    setupPhase: "live",
  })
  return { connectionId, gitUrl }
}

async function addSource(connectionId: string, workspaceId: string) {
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: "d".repeat(40),
    rows: [
      {
        sourceKey: "ops-issues",
        provider: "linear",
        connectionId,
        scope: { teams: ["OPS"] },
        status: "ok",
        statusDetail: null,
      },
    ],
  })
}

describe("Linear webhook routes to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("linear_hook")
    linearOrg = `linear-org-${seed.suffix}`
    // Its source writes into the old sync repository: the legacy mirror stops.
    const moved = await legacyConnection("moved")
    retired = moved.connectionId
    await addSource(
      retired,
      await seed.addWorkspace("moved", moved.gitUrl.replace(/\.git$/, "")),
    )
    // Its source writes into another repository: both mirrors run.
    parallel = (await legacyConnection("parallel")).connectionId
    await addSource(parallel, await seed.addWorkspace("ops"))
    withoutSources = await seed.addConnection("linear", {
      status: "installed",
      workspaceId: linearOrg,
    })
    await getSystemDb()
      .insert(connectionDirectory)
      .values(
        [retired, parallel, withoutSources].map((connectionId) => ({
          connectionId,
          orgId: seed.orgId,
          type: "linear" as const,
          linearWorkspaceId: linearOrg,
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
    for (const id of repositoryIds)
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(repositories).where(eq(repositories.id, id)),
      )
    await seed.cleanup()
    const { closeOpenWorkflowClient } =
      await import("../../../openworkflow/client.js")
    await closeOpenWorkflowClient()
  })

  const issueEvent = {
    type: "Issue",
    action: "update",
    data: {
      id: "issue-1",
      identifier: "OPS-1",
      teamId: "team-ops",
      projectId: "project-1",
      updatedAt: "2026-10-11T10:00:00.000Z",
    },
  }

  const byConnection = <T extends { connectionId: string }>(rows: T[]) =>
    rows.sort((a, b) => a.connectionId.localeCompare(b.connectionId))

  it("queues the event for one coalesced sources sync of each connection with sources, and the legacy sync only where it does not share the repository", async () => {
    const response = await post(issueEvent)
    expect(response.status).toBe(200)
    const event = {
      teamKeys: ["OPS"],
      projectIds: ["project-1"],
      entity: { entityType: "issue", externalId: "issue-1", action: "upsert" },
    }
    expect(byConnection(await waitingEvents())).toEqual(
      byConnection([
        { connectionId: retired, event },
        { connectionId: parallel, event },
      ]),
    )
    // The sync reads the events from the table, not from its input.
    expect(byConnection(await runs("workspace-sources-sync"))).toEqual(
      byConnection([
        { connectionId: retired, event: null },
        { connectionId: parallel, event: null },
      ]),
    )
    expect(
      (await runs("linear-sync-entity")).map((run) => run.connectionId),
    ).toEqual([parallel])
  })

  it("joins a burst of webhooks, also a repeated delivery, to the waiting sync of each connection (CTX-1595)", async () => {
    const before = (await runs("workspace-sources-sync")).length
    expect((await post(issueEvent)).status).toBe(200)
    const burst = await Promise.all(
      [2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
        post({
          ...issueEvent,
          data: {
            ...issueEvent.data,
            id: `issue-${n}`,
            identifier: `OPS-${n}`,
            updatedAt: `2026-10-11T10:0${n}:00.000Z`,
          },
        }),
      ),
    )
    expect(burst.map((response) => response.status)).toEqual(
      burst.map(() => 200),
    )
    expect(await runs("workspace-sources-sync")).toHaveLength(before)
    expect(
      (await waitingEvents()).filter((row) => row.connectionId === parallel),
    ).toHaveLength(10)
  })

  it("does not enqueue a sources sync for an event that has no entity", async () => {
    const before = (await runs("workspace-sources-sync")).length
    const response = await post({
      type: "Reaction",
      action: "create",
      data: { id: "reaction-1" },
    })
    expect(response.status).toBe(200)
    expect(await runs("workspace-sources-sync")).toHaveLength(before)
  })
})
