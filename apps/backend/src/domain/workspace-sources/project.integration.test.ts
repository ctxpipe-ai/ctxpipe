import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { projectWorkspaceSources } from "./project.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

describe("projectWorkspaceSources (Postgres + git)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_project")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("follows the file through revisions, with a status for each bad entry", async () => {
    const env = parseEnv(process.env)
    // Slack has no setup-draft state, so listOrgConnections keeps it.
    const slack = await seed.addConnection("slack")
    const forge = await seed.addConnection("forge")
    const workspaceId = await seed.addWorkspace("docs")
    const repo = await seed.gitRepository()
    const project = (sha: string) =>
      projectWorkspaceSources({
        orgId: seed.orgId,
        revision: repo.revision(workspaceId, sha),
        env,
        adapters: {
          confluence: {
            provider: "confluence",
            managedPaths: () => ["confluence/"],
            fetch: async () => [],
            checkAccess: async ({ scope }) =>
              scope.spaces ? null : "Pick at least one space",
          },
        },
      })
    const rows = () =>
      listWorkspaceSourceRows({ orgId: seed.orgId, workspaceId })

    const noFile = await repo.commit({ "AGENTS.md": "# Docs\n" })
    await project(noFile)
    expect(await rows()).toEqual([])

    const first = await repo.commit({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  - id: eng-issues
    provider: slack
    connection: ${slack}
    teams: [ENG]
  - id: eng-docs
    provider: confluence
    connection: ${forge}
  - id: wrong
    provider: notion
    connection: ${slack}
  - id: unknown
    provider: linear
    connection: con_doesnotexist
`,
    })
    const added = await project(first)
    expect(added.added).toHaveLength(4)
    expect(
      (await rows()).map((row) => [row.sourceKey, row.status, row.revision]),
    ).toEqual([
      ["eng-docs", "out_of_access", first],
      ["eng-issues", "ok", first],
      ["unknown", "connection_missing", first],
      ["wrong", "invalid", first],
    ])

    expect(await project(first)).toEqual({
      added: [],
      changed: [],
      removed: [],
    })

    const second = await repo.commit({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  - id: eng-issues
    provider: slack
    connection: ${slack}
    teams: [ENG, OPS]
`,
    })
    const next = await project(second)
    expect(next.removed.map((row) => row.sourceKey).sort()).toEqual([
      "eng-docs",
      "unknown",
      "wrong",
    ])
    expect(next.changed.map((change) => change.before.scope)).toEqual([
      { teams: ["ENG"] },
    ])

    const broken = await repo.commit({
      ".ctxpipe/sources.yaml": "version: [\n",
    })
    await project(broken)
    expect((await rows()).map((row) => [row.sourceKey, row.status])).toEqual([
      [".file", "invalid"],
    ])

    const removed = await repo.commit({ ".ctxpipe/sources.yaml": null })
    await project(removed)
    expect(await rows()).toEqual([])
  })
})
