import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"

// The OpenWorkflow client reads its namespace on import: keep these runs apart.
const namespaceId = vi.hoisted(() => {
  const id = `wsrc_follow_${Date.now()}_${Math.random().toString(36).slice(2)}`
  process.env.OPENWORKFLOW_NAMESPACE_ID = id
  return id
})

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let enqueue: typeof import("./enqueue.js")
let backend: BackendPostgres

/** The cleanup runs queued for one Workspace in this test's namespace. */
async function cleanups(workspaceId: string) {
  const runs = await backend.listWorkflowRuns({ limit: 1000 })
  return runs.data
    .map((run) => run.input as Record<string, unknown>)
    .filter(
      (input) => input.kind === "cleanup" && input.workspaceId === workspaceId,
    )
}

describe("Source projection follow-ups (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_follow")
    enqueue = await import("./enqueue.js")
    backend = await BackendPostgres.connect(process.env.DATABASE_URL ?? "", {
      runMigrations: false,
      namespaceId,
    })
  })
  afterAll(async () => {
    const { closeOpenWorkflowClient } = await import(
      "../../openworkflow/client.js"
    )
    await closeOpenWorkflowClient()
    await backend?.stop()
    await seed.cleanup()
  })

  /** Project `entry` as `ok`, then project it again as `next`. */
  async function projectTwice(
    slug: string,
    next: {
      scope: Record<string, unknown>
      status: "ok" | "connection_missing"
    },
  ) {
    const linear = await seed.addConnection("linear")
    const workspaceId = await seed.addWorkspace(slug)
    const entry = {
      sourceKey: "issues",
      provider: "linear" as const,
      connectionId: linear,
      scope: { teams: ["ENG"] },
      statusDetail: null,
    }
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [{ ...entry, status: "ok" }],
    })
    const projected = await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "b".repeat(40),
      rows: [{ ...entry, ...next }],
    })
    await enqueue.enqueueSourceProjectionFollowUps({
      orgId: seed.orgId,
      workspaceId,
      revision: "b".repeat(40),
      projected,
    })
    return workspaceId
  }

  it("keeps the files of a source whose connection was removed", async () => {
    const workspaceId = await projectTwice("removed-connection", {
      scope: { teams: ["ENG"] },
      status: "connection_missing",
    })

    expect(await cleanups(workspaceId)).toEqual([])
  })

  it("cleans up the old scope of a source whose scope changed", async () => {
    const workspaceId = await projectTwice("changed-scope", {
      scope: { teams: ["OPS"] },
      status: "ok",
    })

    expect(await cleanups(workspaceId)).toEqual([
      expect.objectContaining({
        removed: [expect.objectContaining({ scope: { teams: ["ENG"] } })],
      }),
    ])
  })
})
