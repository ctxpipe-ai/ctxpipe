import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import type { SourceAdapter, SourceFetchResult } from "./adapter.js"
import { syncConnectionSources, type WorkspaceSliceWrite } from "./sync.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

const source = (sourceKey: string, connectionId: string, spaces: string[]) => ({
  sourceKey,
  provider: "confluence" as const,
  connectionId,
  scope: { spaces },
  status: "ok" as const,
  statusDetail: null,
})

/** An adapter whose fetch returns `result` and records what it saw. */
function adapterReturning(result: SourceFetchResult) {
  const seen: Array<Parameters<NonNullable<SourceAdapter["fetch"]>>[0]> = []
  const adapter: SourceAdapter = {
    provider: "confluence",
    managedPaths: (scope) =>
      (scope.spaces as string[]).map((space) => `confluence/${space}/`),
    async fetch(input) {
      seen.push(input)
      return result
    },
  }
  return { adapter, seen }
}

describe("Workspace source sync frame results (Postgres)", () => {
  let forge: string
  let both: string
  let engOnly: string
  let hrOnly: string

  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_results")
    forge = await seed.addConnection("forge")
    both = await seed.addWorkspace("both")
    engOnly = await seed.addWorkspace("eng-only")
    hrOnly = await seed.addWorkspace("hr-only")
    for (const [workspaceId, spaces, letter] of [
      [both, ["ENG", "HR"], "a"],
      [engOnly, ["ENG"], "b"],
      [hrOnly, ["HR"], "c"],
    ] as const)
      await replaceWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId,
        revision: letter.repeat(40),
        rows: [source("docs", forge, [...spaces])],
      })
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("keeps the files of a failed path and writes the other paths", async () => {
    const { adapter } = adapterReturning({
      files: [{ path: "confluence/ENG/home.md", content: "# ENG" }],
      keepPaths: ["confluence/HR/"],
    })
    const writes: WorkspaceSliceWrite[] = []
    const result = await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter,
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(result.workspaces.sort()).toEqual([both, engOnly].sort())
    expect(writes.find((write) => write.workspaceId === both)).toMatchObject({
      ownedPrefixes: ["confluence/ENG/", "confluence/HR/"],
      keepPrefixes: ["confluence/HR/"],
      files: [{ path: "confluence/ENG/home.md" }],
    })
  })

  it("sets the status of the sources that own an unreachable path and keeps their files", async () => {
    const { adapter } = adapterReturning({
      files: [{ path: "confluence/ENG/home.md", content: "# ENG" }],
      unreachable: [
        {
          path: "confluence/HR/",
          status: "out_of_access",
          detail: "Space HR is gone",
        },
      ],
    })
    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter,
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(writes.map((write) => write.workspaceId).sort()).toEqual(
      [both, engOnly].sort(),
    )
    expect(
      writes.find((write) => write.workspaceId === both)?.keepPrefixes,
    ).toEqual(["confluence/HR/"])
    for (const [workspaceId, status] of [
      [hrOnly, "out_of_access"],
      [both, "out_of_access"],
      [engOnly, "ok"],
    ] as const) {
      const [row] = await listWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId,
      })
      expect(row?.status).toBe(status)
    }
    const [lost] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: hrOnly,
    })
    expect(lost?.statusDetail).toBe("Space HR is gone")
  })

  it("sends a patch and gives the adapter the blobs that all owners share", async () => {
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: hrOnly,
      revision: "d".repeat(40),
      rows: [source("docs", forge, ["HR"])],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: both,
      revision: "e".repeat(40),
      rows: [source("docs", forge, ["ENG", "HR"])],
    })
    const { adapter, seen } = adapterReturning({
      files: [{ path: "confluence/ENG/new.md", content: "new" }],
      deletePaths: ["confluence/ENG/old.md", "confluence/HR/old.md"],
    })
    const trees: Record<string, Array<{ path: string; sha: string }>> = {
      [both]: [
        { path: "confluence/ENG/home.md", sha: "1" },
        { path: "confluence/HR/policy.md", sha: "2" },
        { path: "notes/user.md", sha: "9" },
      ],
      [engOnly]: [{ path: "confluence/ENG/home.md", sha: "1" }],
      [hrOnly]: [{ path: "confluence/HR/policy.md", sha: "3" }],
    }
    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter,
      readExisting: async (workspaceId) => trees[workspaceId] ?? [],
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(
      [...(seen[0]?.existing ?? [])].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    ).toEqual([
      { path: "confluence/ENG/home.md", sha: "1" },
      { path: "confluence/HR/policy.md", sha: null },
    ])
    expect(writes.find((write) => write.workspaceId === hrOnly)).toMatchObject({
      files: [],
      deletePaths: ["confluence/HR/old.md"],
    })
    expect(writes.find((write) => write.workspaceId === engOnly)).toMatchObject(
      {
        files: [{ path: "confluence/ENG/new.md" }],
        deletePaths: ["confluence/ENG/old.md"],
      },
    )
  })
})
