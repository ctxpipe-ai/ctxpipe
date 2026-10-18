import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../domain/ingestion/ingestion-run.js"
import { generateObjectId } from "../lib/id.js"
import { closeOpenWorkflowClient } from "./client.js"
import { startIngestionV2Shadow } from "./enqueue-ingestion-v2-shadow.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/*
 * The shadow trigger (T09): after the old pipeline ingested a repository of
 * a test organization, it queues one ingestion v2 run at the same SHA. No
 * worker runs here; the test reads the queued run.
 */

const orgId = generateObjectId("org")
const connectionId = generateObjectId("con")
const repositoryId = generateObjectId("repo")
const sha = "c".repeat(40)

async function v2Runs() {
  const result = await getSystemDb().execute<{
    id: string
    input: Record<string, unknown>
  }>(sql`
    select id, input from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
      and input->>'orgId' = ${orgId}
  `)
  return result.rows
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the shadow trigger")
  initDb(url)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Shadow trigger proof",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, async (db) => {
    await db
      .insert(connections)
      .values({ id: connectionId, orgId, type: "github", config: {} })
    await db.insert(repositories).values({
      id: repositoryId,
      orgId,
      name: "acme/checkout-api",
      gitUrl: "https://github.com/acme/checkout-api.git",
      githubConnectionId: connectionId,
    })
  })
})

afterAll(async () => {
  await withOrgDbContext(orgId, async (db) => {
    await db.delete(repositories).where(eq(repositories.orgId, orgId))
    await db.delete(connections).where(eq(connections.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeOpenWorkflowClient()
  await closeDb()
})

describe("ingestion v2 shadow trigger", () => {
  it("queues one shadow run at the same SHA, also when the trigger replays", async () => {
    const start = () =>
      startIngestionV2Shadow({
        orgId,
        repositoryId,
        sha,
        triggerRunId: "trigger-2",
      })
    const first = await start()
    const second = await start()
    expect(first).toMatchObject({ started: true })
    expect(second).toEqual(first)
    const runs = await v2Runs()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.input).toMatchObject({
      orgId,
      shadow: true,
      source: {
        url: "https://github.com/acme/checkout-api",
        githubConnectionId: connectionId,
      },
      sha,
    })
  })

  it("queues a plain git run for a public HTTPS repository without a GitHub connection", async () => {
    const plain = generateObjectId("repo")
    await withOrgDbContext(orgId, (db) =>
      db.insert(repositories).values({
        id: plain,
        orgId,
        name: "acme/plain",
        gitUrl: "https://git.example.com/acme/plain.git",
      }),
    )
    await expect(
      startIngestionV2Shadow({
        orgId,
        repositoryId: plain,
        sha,
        triggerRunId: "trigger-3",
      }),
    ).resolves.toMatchObject({ started: true })
    expect(
      (await v2Runs()).find(
        (run) =>
          (run.input.source as { kind?: string } | undefined)?.kind === "git",
      )?.input,
    ).toMatchObject({
      source: { kind: "git", url: "https://git.example.com/acme/plain.git" },
      sha,
    })
  })

  it("queues nothing for a repository URL that ctx| does not read as plain git", async () => {
    for (const [index, gitUrl] of [
      "http://git.example.com/acme/plain.git",
      "https://token@git.example.com/acme/plain.git",
      "https://git.example.com:8443/acme/plain.git",
      "https://10.0.0.5/acme/plain.git",
    ].entries()) {
      const other = generateObjectId("repo")
      await withOrgDbContext(orgId, (db) =>
        db.insert(repositories).values({
          id: other,
          orgId,
          name: `acme/refused-${index}`,
          gitUrl,
        }),
      )
      await expect(
        startIngestionV2Shadow({
          orgId,
          repositoryId: other,
          sha,
          triggerRunId: `trigger-refused-${index}`,
        }),
      ).resolves.toEqual({ started: false, reason: "unsupported_url" })
    }
  })
})
