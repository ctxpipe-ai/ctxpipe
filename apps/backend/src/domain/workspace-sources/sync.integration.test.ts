import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { fakeSourceAdapter } from "../../test/fake-source-adapter.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import {
  cleanupRemovedSources,
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "./sync.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

const source = (sourceKey: string, connectionId: string, spaces: string[]) => ({
  sourceKey,
  provider: "confluence" as const,
  connectionId,
  scope: { spaces },
  status: "ok" as const,
  statusDetail: null,
})

describe("Workspace source sync frame (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_sync")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("fetches once for a connection and writes one slice for each Workspace", async () => {
    const forge = await seed.addConnection("forge")
    const docs = await seed.addWorkspace("docs")
    const eng = await seed.addWorkspace("eng")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: docs,
      revision: "a".repeat(40),
      rows: [source("all-docs", forge, ["ENG", "HR"])],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: eng,
      revision: "b".repeat(40),
      rows: [
        source("eng-docs", forge, ["ENG"]),
        { ...source("broken", forge, ["OPS"]), status: "invalid" },
      ],
    })
    const { adapter, fetches } = fakeSourceAdapter({
      ENG: { home: "# ENG" },
      HR: { policy: "# HR" },
      OPS: { runbook: "# OPS" },
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
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toHaveLength(2)
    expect(result.workspaces.sort()).toEqual([docs, eng].sort())
    const byWorkspace = new Map(
      writes.map((write) => [write.workspaceId, write]),
    )
    expect(byWorkspace.get(docs)).toMatchObject({
      ownedPrefixes: ["confluence/ENG/", "confluence/HR/"],
      files: [
        { path: "confluence/ENG/home.md" },
        { path: "confluence/HR/policy.md" },
      ],
    })
    expect(byWorkspace.get(eng)).toMatchObject({
      ownedPrefixes: ["confluence/ENG/"],
      files: [{ path: "confluence/ENG/home.md" }],
    })

    writes.length = 0
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter,
      event: { space: "HR" },
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(writes.map((write) => write.workspaceId)).toEqual([docs])
  })

  it("with filesByScope, gives each Workspace only the files of its own scopes", async () => {
    const forge = await seed.addConnection("forge")
    const all = await seed.addWorkspace("each-all")
    const some = await seed.addWorkspace("each-some")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: all,
      revision: "d".repeat(40),
      rows: [source("docs", forge, ["ENG"])],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: some,
      revision: "e".repeat(40),
      rows: [source("docs", forge, ["ENG", "one-page"])],
    })
    const fetched: Array<readonly Record<string, unknown>[]> = []
    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter: {
        provider: "confluence",
        managedPaths: () => ["confluence/ENG/"],
        async fetch({ scopes }) {
          fetched.push(scopes)
          // The same page has a different path in each layout.
          return {
            filesByScope: scopes.map((scope) =>
              (scope.spaces as string[]).includes("one-page")
                ? [{ path: "confluence/ENG/home--1.md", content: "# Home" }]
                : [{ path: "confluence/ENG/1/index.md", content: "# Home" }],
            ),
          }
        },
      },
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(fetched).toHaveLength(1)
    expect(
      Object.fromEntries(
        writes.map((write) => [
          write.workspaceId,
          write.files.map((file) => file.path),
        ]),
      ),
    ).toEqual({
      [all]: ["confluence/ENG/1/index.md"],
      [some]: ["confluence/ENG/home--1.md"],
    })
  })

  it("with filesByScope, skips the write of a Workspace whose scope failed", async () => {
    const forge = await seed.addConnection("forge")
    const ok = await seed.addWorkspace("each-ok")
    const failed = await seed.addWorkspace("each-failed")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: ok,
      revision: "d".repeat(40),
      rows: [source("docs", forge, ["ENG"])],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: failed,
      revision: "e".repeat(40),
      rows: [source("docs", forge, ["ENG", "broken"])],
    })
    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter: {
        provider: "confluence",
        managedPaths: () => ["confluence/ENG/"],
        async fetch({ scopes }) {
          return {
            filesByScope: scopes.map((scope) =>
              (scope.spaces as string[]).includes("broken")
                ? null
                : [{ path: "confluence/ENG/1/index.md", content: "# Home" }],
            ),
          }
        },
      },
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(writes.map((write) => write.workspaceId)).toEqual([ok])
  })

  it("deletes only the managed paths that no remaining source owns", async () => {
    const forge = await seed.addConnection("forge")
    const workspaceId = await seed.addWorkspace("cleanup")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "c".repeat(40),
      rows: [source("eng-docs", forge, ["ENG"])],
    })
    const { adapter } = fakeSourceAdapter({})
    const writes: WorkspaceSliceWrite[] = []
    await cleanupRemovedSources({
      orgId: seed.orgId,
      workspaceId,
      revision: "f".repeat(40),
      removed: [
        {
          provider: "confluence",
          connectionId: forge,
          scope: { spaces: ["ENG", "HR"] },
        },
        { provider: "slack", connectionId: forge, scope: {} },
      ],
      adapters: { confluence: adapter },
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(writes).toEqual([
      {
        orgId: seed.orgId,
        workspaceId,
        provider: "confluence",
        connectionId: forge,
        files: [],
        ownedPrefixes: ["confluence/HR/"],
        keepPrefixes: [],
        sourcesRevision: "f".repeat(40),
      },
    ])
  })

  it("keeps the files of a remaining source when a removed source owned a wider path", async () => {
    const forge = await seed.addConnection("forge")
    const workspaceId = await seed.addWorkspace("overlap")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "d".repeat(40),
      rows: [source("eng-docs", forge, ["ENG"])],
    })
    const { adapter } = fakeSourceAdapter({})
    const writes: WorkspaceSliceWrite[] = []
    await cleanupRemovedSources({
      orgId: seed.orgId,
      workspaceId,
      revision: "f".repeat(40),
      removed: [
        {
          provider: "confluence",
          connectionId: forge,
          scope: { spaces: ["*"] },
        },
        {
          provider: "confluence",
          connectionId: forge,
          scope: { spaces: ["ENG/archive"] },
        },
      ],
      adapters: { confluence: adapter },
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(writes).toMatchObject([
      { ownedPrefixes: ["confluence/"], keepPrefixes: ["confluence/ENG/"] },
    ])
  })

  it("refuses managed paths that leave the provider root", async () => {
    const forge = await seed.addConnection("forge")
    const workspaceId = await seed.addWorkspace("guard")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "e".repeat(40),
      rows: [source("eng-docs", forge, ["ENG"])],
    })
    for (const bad of [
      "confluence/../secrets/",
      "confluence//x/",
      "/confluence/x/",
      "confluence\\x/",
      "confluence/x",
    ]) {
      await expect(
        syncConnectionSources({
          orgId: seed.orgId,
          connectionId: forge,
          env: parseEnv(process.env),
          adapter: {
            provider: "confluence",
            managedPaths: () => [bad],
            fetch: async () => [],
          },
          write: async () => {},
        }),
      ).rejects.toThrow(/Managed path/)
    }
  })
})
