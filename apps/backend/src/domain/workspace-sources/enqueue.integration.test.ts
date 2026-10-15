import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { closeOpenWorkflowClient } from "../../openworkflow/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { enqueueSourceProjectionFollowUps } from "./enqueue.js"
import { projectWorkspaceSources } from "./project.js"
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
    return cleanupRuns(workspaceId)
  }

  /**
   * Commit each text of `.ctxpipe/sources.yaml` to a git repository in turn,
   * project each commit as hydrate does, and run the follow-ups. Each text
   * can use `{linear}`, the id of one new Linear connection. Returns the
   * cleanup runs queued for the Workspace.
   */
  async function projectFile(slug: string, texts: string[]) {
    const env = parseEnv(process.env)
    const linear = await seed.addConnection("linear")
    const workspaceId = await seed.addWorkspace(slug)
    const repo = await seed.gitRepository()
    for (const text of texts) {
      const revision = await repo.commit({
        ".ctxpipe/sources.yaml": text.replaceAll("{linear}", linear),
      })
      const projected = await projectWorkspaceSources({
        orgId: seed.orgId,
        workspaceId,
        revision,
        text: await repo.sourcesText(revision),
        env,
        // No access check: the Linear API is not part of this test.
        adapters: {
          linear: {
            provider: "linear",
            managedPaths: () => ["linear/"],
            fetch: async () => [],
          },
        },
      })
      await enqueueSourceProjectionFollowUps({
        orgId: seed.orgId,
        workspaceId,
        revision,
        projected,
      })
    }
    return cleanupRuns(workspaceId)
  }

  async function cleanupRuns(workspaceId: string) {
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

  const eng = (id = "issues") => `version: 1
sources:
  - id: ${id}
    provider: linear
    connection: "{linear}"
    teams: [ENG]
`
  const ops = eng().replace("[ENG]", "[OPS]")
  const invalid = eng().replace("[ENG]", "5")
  const noSources = "version: 1\nsources: []\n"
  const broken = "version: [\n"
  const cleanedEng = [
    expect.objectContaining({
      removed: [expect.objectContaining({ scope: { teams: ["ENG"] } })],
    }),
  ]

  it("cleans up the last good scope when an invalid entry gets a new scope", async () => {
    expect(
      await projectFile("invalid-then-new-scope", [eng(), invalid, ops]),
    ).toEqual(cleanedEng)
  })

  it("cleans up the last good scope when an invalid entry is removed", async () => {
    expect(
      await projectFile("invalid-then-removed", [eng(), invalid, noSources]),
    ).toEqual(cleanedEng)
  })

  it("keeps the files when an invalid entry gets its old scope again", async () => {
    expect(
      await projectFile("invalid-then-same", [eng(), invalid, eng()]),
    ).toEqual([])
  })

  it("cleans up a source removed while the sources file could not be read", async () => {
    expect(
      await projectFile("file-error-then-removed", [eng(), broken, noSources]),
    ).toEqual(cleanedEng)
  })

  it("keeps the files when the sources file can be read again unchanged", async () => {
    expect(
      await projectFile("file-error-then-same", [eng(), broken, eng()]),
    ).toEqual([])
  })

  it("keeps the files while an entry has an id that cannot be read", async () => {
    expect(
      await projectFile("unreadable-id", [eng(), eng("Not An Id")]),
    ).toEqual([])
    expect(
      await projectFile("unreadable-id-fixed", [
        eng(),
        eng("Not An Id"),
        eng(),
      ]),
    ).toEqual([])
  })

  it("cleans up a source removed after its entry had an id that cannot be read", async () => {
    expect(
      await projectFile("unreadable-id-then-removed", [
        eng(),
        eng("Not An Id"),
        noSources,
      ]),
    ).toEqual(cleanedEng)
  })
})
