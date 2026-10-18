import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { slackSourceAdapter } from "../../services/slack/source-adapter.js"
import { fakeSourceAdapter } from "../../test/fake-source-adapter.js"
import { commitGitTree, removeGitTrees } from "../../test/git-tree.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { listExistingBlobs } from "./existing-blobs.js"
import { gitBlobSha, stampSources } from "./stamp-sources.js"
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
    removeGitTrees()
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

  it("stamps each mirror file with the path of the source that owns it", async () => {
    const forge = await seed.addConnection("forge")
    const docs = await seed.addWorkspace("stamp-docs")
    const eng = await seed.addWorkspace("stamp-eng")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: docs,
      revision: "a".repeat(40),
      rows: [
        source("sources/confluence/all-docs.md", forge, ["ENG"]),
        source("sources/confluence/hr.md", forge, ["HR"]),
        // A key that is not a source path (the YAML dual read) gets no stamp.
        source("legacy-key", forge, ["OPS"]),
      ],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: eng,
      revision: "b".repeat(40),
      rows: [source("sources/confluence/team/eng.md", forge, ["ENG"])],
    })
    const writes: WorkspaceSliceWrite[] = []
    const page = (title: string) => `---\nsource: confluence\n---\n# ${title}\n`
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter: {
        provider: "confluence",
        managedPaths: (scope) =>
          (scope.spaces as string[]).map((space) => `confluence/${space}/`),
        async fetch() {
          return [
            { path: "confluence/ENG/home.md", content: page("ENG") },
            { path: "confluence/HR/policy.md", content: page("HR") },
            { path: "confluence/OPS/run.md", content: page("OPS") },
            {
              path: "confluence/ENG/logo.png",
              content: "AA==",
              encoding: "base64" as const,
            },
          ]
        },
      },
      write: async (write) => {
        writes.push(write)
      },
    })
    const contents = (workspaceId: string) =>
      Object.fromEntries(
        writes
          .find((write) => write.workspaceId === workspaceId)
          ?.files.map((file) => [file.path, file.content]) ?? [],
      )
    expect(contents(docs)).toEqual({
      "confluence/ENG/home.md":
        "---\nsource: confluence\nsources:\n  - sources/confluence/all-docs.md\n---\n# ENG\n",
      "confluence/HR/policy.md":
        "---\nsource: confluence\nsources:\n  - sources/confluence/hr.md\n---\n# HR\n",
      "confluence/OPS/run.md": page("OPS"),
      "confluence/ENG/logo.png": "AA==",
    })
    expect(contents(eng)["confluence/ENG/home.md"]).toBe(
      "---\nsource: confluence\nsources:\n  - sources/confluence/team/eng.md\n---\n# ENG\n",
    )
  })

  it("gives the adapter the sha of its own text and restamps, from Git, the files it does not write again", async () => {
    const forge = await seed.addConnection("forge")
    const docs = await seed.addWorkspace("restamp")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: docs,
      revision: "c".repeat(40),
      rows: [source("sources/confluence/renamed.md", forge, ["ENG"])],
    })
    const page = (title: string) => `---\nsource: confluence\n---\n# ${title}\n`
    const dir = commitGitTree({
      "confluence/ENG/ok.md": stampSources(page("ok"), [
        "sources/confluence/renamed.md",
      ]),
      // Stamped with the old path before a rename.
      "confluence/ENG/old.md": stampSources(page("old"), [
        "sources/confluence/before.md",
      ]),
      // Written before the stamp existed.
      "confluence/ENG/none.md": page("none"),
      // No front matter: the sync does not stamp it.
      "confluence/ENG/asset.md": "plain\n",
    })
    const seen: Array<ReadonlyArray<{ path: string; sha: string | null }>> = []
    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter: {
        provider: "confluence",
        managedPaths: () => ["confluence/ENG/"],
        async fetch({ existing }) {
          seen.push(existing ?? [])
          // An incremental patch: the adapter writes nothing again.
          return { files: [], deletePaths: [] }
        },
      },
      write: async (write) => {
        writes.push(write)
      },
      readExisting: (_workspaceId, owners) =>
        listExistingBlobs(dir, "HEAD", owners),
    })
    expect(
      Object.fromEntries(seen[0]?.map((f) => [f.path, f.sha]) ?? []),
    ).toEqual({
      "confluence/ENG/ok.md": gitBlobSha(page("ok")),
      "confluence/ENG/old.md": gitBlobSha(page("old")),
      "confluence/ENG/none.md": gitBlobSha(page("none")),
      "confluence/ENG/asset.md": gitBlobSha("plain\n"),
    })
    expect(writes).toHaveLength(1)
    expect(
      Object.fromEntries(
        writes[0]?.files.map((file) => [file.path, file.content]) ?? [],
      ),
    ).toEqual({
      "confluence/ENG/old.md": stampSources(page("old"), [
        "sources/confluence/renamed.md",
      ]),
      "confluence/ENG/none.md": stampSources(page("none"), [
        "sources/confluence/renamed.md",
      ]),
    })
  })

  it("stamps a Slack thread from before the stamp, and restamps it after a rename", async () => {
    const slack = await seed.addConnection("slack")
    const docs = await seed.addWorkspace("slack-restamp")
    const thread = "---\nsource: slack\nchannel_id: C0123ABCD\n---\n# Thread\n"
    const sync = async (sourceKey: string, files: Record<string, string>) => {
      await replaceWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId: docs,
        revision: "d".repeat(40),
        rows: [
          {
            sourceKey,
            provider: "slack",
            connectionId: slack,
            scope: { channels: ["C0123ABCD"] },
            status: "ok",
            statusDetail: null,
          },
        ],
      })
      const dir = commitGitTree(files)
      const writes: WorkspaceSliceWrite[] = []
      await syncConnectionSources({
        orgId: seed.orgId,
        connectionId: slack,
        env: parseEnv(process.env),
        adapter: slackSourceAdapter,
        write: async (write) => {
          writes.push(write)
        },
        readExisting: (_workspaceId, owners) =>
          listExistingBlobs(dir, "HEAD", owners),
      })
      return writes
    }
    const before = await sync("sources/slack/eng.md", {
      "slack/channels/C0123ABCD/1.md": thread,
    })
    const stamped = stampSources(thread, ["sources/slack/eng.md"])
    expect(before[0]?.files).toEqual([
      { path: "slack/channels/C0123ABCD/1.md", content: stamped },
    ])
    // The next sync after the commit writes nothing.
    expect(
      await sync("sources/slack/eng.md", {
        "slack/channels/C0123ABCD/1.md": stamped,
      }),
    ).toEqual([])
    const renamed = await sync("sources/slack/team/eng.md", {
      "slack/channels/C0123ABCD/1.md": stamped,
    })
    expect(renamed[0]?.files).toEqual([
      {
        path: "slack/channels/C0123ABCD/1.md",
        content: stampSources(thread, ["sources/slack/team/eng.md"]),
      },
    ])
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
        removed: [
          {
            provider: "confluence",
            connectionId: forge,
            scope: { spaces: ["ENG", "HR"] },
          },
        ],
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

  it("keeps the files of a remaining source whose entry is invalid for now", async () => {
    const forge = await seed.addConnection("forge")
    const workspaceId = await seed.addWorkspace("held")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [source("eng-docs", forge, ["ENG"])],
    })
    // An entry without a readable id can be `eng-docs`, so its row stays as
    // `invalid` with its last good scope.
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "b".repeat(40),
      rows: [
        {
          ...source(".entry-1", forge, []),
          scope: {},
          status: "invalid",
          statusDetail: "The id is not valid",
        },
      ],
    })
    const { adapter } = fakeSourceAdapter({})
    const writes: WorkspaceSliceWrite[] = []
    await cleanupRemovedSources({
      orgId: seed.orgId,
      workspaceId,
      revision: "b".repeat(40),
      removed: [
        {
          provider: "confluence",
          connectionId: forge,
          scope: { spaces: ["ENG", "HR"] },
        },
      ],
      adapters: { confluence: adapter },
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(writes).toMatchObject([{ ownedPrefixes: ["confluence/HR/"] }])
  })

  it("keeps the files of a held source in a full sync of a wider source", async () => {
    const forge = await seed.addConnection("forge")
    const workspaceId = await seed.addWorkspace("held-sync")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [source("eng-docs", forge, ["ENG"])],
    })
    // `eng-docs` is held as `invalid`; a new `all` source owns every space.
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "b".repeat(40),
      rows: [
        source("all", forge, ["*"]),
        {
          ...source(".entry-2", forge, []),
          scope: {},
          status: "invalid",
          statusDetail: "The id is not valid",
        },
      ],
    })
    const { adapter } = fakeSourceAdapter({ HR: { policy: "# HR" } })
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

  describe("refuses a fetched path that is not safe", () => {
    let count = 0
    async function syncWith(result: {
      files?: string[]
      deletePaths?: string[]
      keepPaths?: string[]
    }) {
      const forge = await seed.addConnection("forge")
      count += 1
      const workspaceId = await seed.addWorkspace(`paths-${count}`)
      await replaceWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId,
        revision: "f".repeat(40),
        rows: [source("eng-docs", forge, ["ENG"])],
      })
      const writes: WorkspaceSliceWrite[] = []
      const run = syncConnectionSources({
        orgId: seed.orgId,
        connectionId: forge,
        env: parseEnv(process.env),
        adapter: {
          provider: "confluence",
          managedPaths: (scope) =>
            (scope.spaces as string[]).map((space) => `confluence/${space}/`),
          fetch: async () => ({
            files: (result.files ?? []).map((path) => ({
              path,
              content: "# Page\n",
            })),
            deletePaths: result.deletePaths ?? [],
            keepPaths: result.keepPaths ?? [],
          }),
        },
        write: async (write) => {
          writes.push(write)
        },
      })
      return { run, writes, workspaceId }
    }

    it.each([
      ["a parent segment", "confluence/ENG/../../.ctxpipe/workspace.yaml"],
      ["a parent segment to a near folder", "confluence/ENG/../HR/page.md"],
      ["a current segment", "confluence/ENG/./page.md"],
      ["an empty segment", "confluence/ENG//page.md"],
      ["an absolute path", "/confluence/ENG/page.md"],
      ["a backslash", "confluence/ENG/..\\..\\page.md"],
      ["a NUL character", "confluence/ENG/page\u0000.md"],
      ["a control character", "confluence/ENG/page\n.md"],
      ["a form that NFC changes", "confluence/ENG/cafe\u0301.md"],
      ["a path of another source", "confluence/HR/page.md"],
    ])("refuses a file with %s", async (_, path) => {
      const { run, writes } = await syncWith({
        files: ["confluence/ENG/home.md", path],
      })
      await expect(run).rejects.toThrow(
        /The confluence sync refused the path .*Nothing was written/,
      )
      expect(writes).toEqual([])
    })

    it("refuses a deleted or kept path with a parent segment", async () => {
      const deleted = await syncWith({
        files: ["confluence/ENG/home.md"],
        deletePaths: ["confluence/ENG/../../sources/docs.md"],
      })
      await expect(deleted.run).rejects.toThrow(/refused the path/)
      expect(deleted.writes).toEqual([])
      const kept = await syncWith({
        files: ["confluence/ENG/home.md"],
        keepPaths: ["confluence/../linear/"],
      })
      await expect(kept.run).rejects.toThrow(/refused the path/)
      expect(kept.writes).toEqual([])
    })

    it("still writes a normal path", async () => {
      const { run, writes, workspaceId } = await syncWith({
        files: ["confluence/ENG/home.md", "confluence/ENG/team/page.md"],
        deletePaths: ["confluence/ENG/old.md"],
      })
      await expect(run).resolves.toEqual({
        fetchedScopes: 1,
        workspaces: [workspaceId],
      })
      expect(writes).toMatchObject([
        {
          files: [
            { path: "confluence/ENG/home.md" },
            { path: "confluence/ENG/team/page.md" },
          ],
          deletePaths: ["confluence/ENG/old.md"],
        },
      ])
    })
  })
})
