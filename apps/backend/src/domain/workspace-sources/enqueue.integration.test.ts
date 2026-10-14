import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { closeOpenWorkflowClient } from "../../openworkflow/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { enqueueSourceProjectionFollowUps } from "./enqueue.js"
import {
  FILE_ERROR_SOURCE_KEY,
  type PlannedSourceRow,
} from "./projection-plan.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let backend: BackendPostgres

describe("Source projection follow-ups (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_follow")
    backend = await BackendPostgres.connect(process.env.DATABASE_URL ?? "", {
      runMigrations: false,
      namespaceId: openWorkflowNamespaceId(),
    })
  })
  afterAll(async () => {
    await closeOpenWorkflowClient()
    await backend?.stop()
    await seed.cleanup()
  })

  /**
   * Project each revision of one Workspace in turn and run the follow-ups.
   * Returns the cleanup runs queued for the Workspace.
   */
  async function project(slug: string, revisions: PlannedSourceRow[][]) {
    const workspaceId = await seed.addWorkspace(slug)
    for (const [index, rows] of revisions.entries()) {
      const revision = String(index).repeat(40)
      const projected = await replaceWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId,
        revision,
        rows,
      })
      await enqueueSourceProjectionFollowUps({
        orgId: seed.orgId,
        workspaceId,
        revision,
        projected,
      })
    }
    const runs = await backend.listWorkflowRuns({ limit: 1000 })
    return runs.data
      .map((run) => run.input as Record<string, unknown>)
      .filter(
        (input) =>
          input.kind === "cleanup" && input.workspaceId === workspaceId,
      )
  }

  /** A new Linear connection and an `ok` source row that uses it. */
  async function linearSourceRow(
    row: Partial<PlannedSourceRow> = {},
  ): Promise<PlannedSourceRow> {
    return {
      sourceKey: "issues",
      provider: "linear",
      connectionId: await seed.addConnection("linear"),
      scope: { teams: ["ENG"] },
      status: "ok",
      statusDetail: null,
      ...row,
    }
  }

  it("keeps the files of a source whose connection was removed", async () => {
    const source = await linearSourceRow()
    const cleanups = await project("removed-connection", [
      [source],
      [{ ...source, status: "connection_missing" }],
    ])

    expect(cleanups).toEqual([])
  })

  it("cleans up the old scope of a source whose scope changed", async () => {
    const source = await linearSourceRow()
    const cleanups = await project("changed-scope", [
      [source],
      [{ ...source, scope: { teams: ["OPS"] } }],
    ])

    expect(cleanups).toEqual([
      expect.objectContaining({
        removed: [expect.objectContaining({ scope: { teams: ["ENG"] } })],
      }),
    ])
  })

  it("cleans up a removed source whose connection was removed before", async () => {
    const source = await linearSourceRow()
    const cleanups = await project("removed-later", [
      [source],
      [{ ...source, status: "connection_missing" }],
      [],
    ])

    expect(cleanups).toEqual([
      expect.objectContaining({
        removed: [expect.objectContaining({ scope: { teams: ["ENG"] } })],
      }),
    ])
  })

  it("keeps the files of a source whose entry became invalid", async () => {
    const source = await linearSourceRow()
    const cleanups = await project("invalid-entry", [
      [source],
      [{ ...source, scope: {}, status: "invalid", statusDetail: "Bad scope" }],
    ])

    expect(cleanups).toEqual([])
  })

  it("keeps every file while the sources file cannot be read", async () => {
    const cleanups = await project("file-error", [
      [await linearSourceRow()],
      [
        {
          sourceKey: FILE_ERROR_SOURCE_KEY,
          provider: null,
          connectionId: null,
          scope: {},
          status: "invalid",
          statusDetail: "The file is not valid YAML",
        },
      ],
    ])

    expect(cleanups).toEqual([])
  })
})
