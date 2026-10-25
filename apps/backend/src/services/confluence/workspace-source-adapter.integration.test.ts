import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSpaces } from "../../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { repositories } from "../../db/schema/repositories.js"
import {
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "../../domain/workspace-sources/sync.js"
import { getForgeInstallationByConnectionId } from "../../models/atlassian-connector.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { connectorPathSegment } from "../connectors/path-segment.js"
import {
  CONFLUENCE_SYNC_MAX_TRIES,
  confluenceSourceAdapter,
} from "./workspace-source-adapter.js"
import { confluenceSourceMigrationHook } from "./workspace-source-migration.js"

const api = "https://api.atlassian.com/ex/confluence/cloud-acme/wiki"
const pageReads: string[] = []
/** The site's spaces; a test removes one to delete the space. */
const site = {
  spaces: [{ id: "100", key: "ENG", name: "Engineering", homepageId: "1" }],
  failingPages: new Set<string>(),
}
const server = setupServer(
  http.get(`${api}/api/v2/spaces`, () =>
    HttpResponse.json({ results: site.spaces }),
  ),
  http.get(`${api}/api/v2/pages`, () =>
    HttpResponse.json({
      results: [
        { id: "1", title: "Home", spaceId: "100" },
        { id: "2", title: "Guide", spaceId: "100", parentId: "1" },
        { id: "3", title: "Setup", spaceId: "100", parentId: "2" },
      ],
    }),
  ),
  http.get(`${api}/api/v2/pages/:pageId`, ({ params }) => {
    pageReads.push(String(params.pageId))
    if (site.failingPages.has(String(params.pageId)))
      return HttpResponse.json({ message: "Not found" }, { status: 404 })
    return HttpResponse.json({
      id: params.pageId,
      title: `Page ${params.pageId}`,
      body: { storage: { value: `<p>Body of ${params.pageId}</p>` } },
    })
  }),
  http.get(`${api}/api/v2/pages/:pageId/attachments`, () =>
    HttpResponse.json({ results: [] }),
  ),
)

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

const installed = {
  cloudId: "cloud-acme",
  appSystemToken: "fixture-token",
  status: "installed",
}

const status = (connectionId: string, pages: "all" | string[]) =>
  confluenceSourceAdapter.syncStatus?.({
    orgId: seed.orgId,
    connectionId,
    scope: { spaces: [{ key: "ENG", pages }] },
  }) ?? null

const confluenceRow = (
  sourceKey: string,
  connectionId: string,
  pages: "all" | string[],
) => ({
  sourceKey,
  provider: "confluence" as const,
  connectionId,
  scope: { spaces: [{ key: "ENG", pages }] },
  status: "ok" as const,
  statusDetail: null,
})

describe("Confluence source adapter (Postgres + msw)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("wsrc_confluence")
  })
  afterEach(() => {
    server.resetHandlers()
    pageReads.length = 0
    site.spaces = [
      { id: "100", key: "ENG", name: "Engineering", homepageId: "1" },
    ]
    site.failingPages.clear()
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  it("fetches each page once and writes each Workspace its own page tree", async () => {
    const forge = await seed.addConnection("forge", installed)
    const all = await seed.addWorkspace("conf-all")
    const guide = await seed.addWorkspace("conf-guide")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: all,
      revision: "a".repeat(40),
      rows: [confluenceRow("eng", forge, "all")],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: guide,
      revision: "b".repeat(40),
      rows: [confluenceRow("eng-guide", forge, ["2"])],
    })

    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter: confluenceSourceAdapter,
      write: async (write) => {
        writes.push(write)
      },
    })

    expect(pageReads.sort()).toEqual(["1", "2", "3"])
    const paths = new Map(
      writes.map((write) => [
        write.workspaceId,
        write.files.map((file) => file.path).sort(),
      ]),
    )
    expect(paths.get(all)).toHaveLength(3)
    // Alone in the selection, "Guide" is a leaf file, not a directory index.
    const guidePaths = paths.get(guide) ?? []
    expect(guidePaths).toHaveLength(1)
    expect(guidePaths[0]).toMatch(/^confluence\/ENG\/.*--2\.md$/)
    expect(paths.get(all)).not.toContain(guidePaths[0])
    for (const write of writes)
      expect(write.ownedPrefixes).toEqual(["confluence/ENG/"])

    // The cursor is on the connection, one entry for each space.
    const connection = await getForgeInstallationByConnectionId(
      seed.orgId,
      forge,
    )
    expect(connection?.sourceSync?.spaces.ENG?.lastSyncedAt).toEqual(
      expect.any(String),
    )
  })

  it("keeps a hostile page id and title from the provider under the space folder", async () => {
    const forge = await seed.addConnection("forge", installed)
    const workspaceId = await seed.addWorkspace("conf-hostile")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "9".repeat(40),
      rows: [confluenceRow("eng", forge, "all")],
    })
    const hostileId = "../../../../.ctxpipe/workspace"
    server.use(
      http.get(`${api}/api/v2/pages`, () =>
        HttpResponse.json({
          results: [
            { id: "1", title: "Home", spaceId: "100" },
            {
              id: hostileId,
              title: "../../sources/evil",
              spaceId: "100",
              parentId: "1",
            },
          ],
        }),
      ),
      http.get(`${api}/api/v2/pages/:pageId`, () =>
        HttpResponse.json({
          id: hostileId,
          title: "../../sources/evil",
          body: { storage: { value: "<p>Body</p>" } },
        }),
      ),
    )
    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter: confluenceSourceAdapter,
      write: async (write) => {
        writes.push(write)
      },
    })
    const paths = writes
      .filter((write) => write.workspaceId === workspaceId)
      .flatMap((write) => write.files.map((file) => file.path))
    expect(paths.length).toBeGreaterThan(0)
    const safeId = connectorPathSegment(hostileId)
    for (const path of paths) {
      expect(path.startsWith("confluence/ENG/")).toBe(true)
      for (const segment of path.split("/"))
        expect([".", "..", ""]).not.toContain(segment)
    }
    expect(paths.some((path) => path.endsWith(`--${safeId}.md`))).toBe(true)
  })

  it("writes the pages of two entries that share a space together, and deletes none of them", async () => {
    const forge = await seed.addConnection("forge", installed)
    const workspace = await seed.addWorkspace("conf-split")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: workspace,
      revision: "c".repeat(40),
      rows: [
        confluenceRow("eng-a", forge, ["2"]),
        confluenceRow("eng-b", forge, ["3"]),
      ],
    })

    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter: confluenceSourceAdapter,
      write: async (write) => {
        writes.push(write)
      },
    })

    expect(writes).toHaveLength(1)
    const paths = (writes[0]?.files ?? []).map((file) => file.path)
    expect(paths).toHaveLength(2)
    expect(new Set(paths).size).toBe(2)
    expect(paths.some((path) => path.endsWith("--2.md"))).toBe(true)
    expect(paths.some((path) => path.endsWith("--3.md"))).toBe(true)
    expect(writes[0]?.ownedPrefixes).toEqual(["confluence/ENG/"])
  })

  it("does not leak a Workspace scope into the legacy migration", async () => {
    const forge = await seed.addConnection("forge", installed)
    const hr = await seed.addWorkspace("conf-hr-page")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: hr,
      revision: "c".repeat(40),
      rows: [confluenceRow("eng-guide", forge, ["2"])],
    })
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: forge,
      env: parseEnv(process.env),
      adapter: confluenceSourceAdapter,
      write: async () => {},
    })
    // The legacy target of the same connection selected only OPS.
    const gitUrl = `https://github.com/acme/legacy-${seed.suffix}.git`
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(repositories).values({
        id: `repo_leak_${seed.suffix}`,
        orgId: seed.orgId,
        name: "legacy",
        gitUrl,
      })
      await db.insert(confluenceSyncTargets).values({
        id: `cst_leak_${seed.suffix}`,
        orgId: seed.orgId,
        connectionId: forge,
        repositoryId: `repo_leak_${seed.suffix}`,
        branch: "main",
        setupPhase: "live",
      })
      await db.insert(confluenceSpaces).values({
        id: `csp_leak_${seed.suffix}`,
        orgId: seed.orgId,
        connectionId: forge,
        spaceKey: "OPS",
      })
    })
    const bindings = await confluenceSourceMigrationHook.listLegacyBindings({
      orgId: seed.orgId,
      env: parseEnv(process.env),
    })
    expect(bindings.find((binding) => binding.connectionId === forge)).toEqual({
      provider: "confluence",
      connectionId: forge,
      syncRepositoryUrl: gitUrl,
      scope: { spaces: [{ key: "OPS", pages: "all" }] },
    })
  })

  it("isolates a failing page: other Workspaces sync, and it is skipped after bounded tries", async () => {
    const forge = await seed.addConnection("forge", installed)
    const all = await seed.addWorkspace("conf-fail-all")
    const guide = await seed.addWorkspace("conf-fail-guide")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: all,
      revision: "d".repeat(40),
      rows: [confluenceRow("eng", forge, "all")],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: guide,
      revision: "e".repeat(40),
      rows: [confluenceRow("eng-guide", forge, ["2"])],
    })
    site.failingPages.add("3")
    const sync = async () => {
      const writes: WorkspaceSliceWrite[] = []
      await syncConnectionSources({
        orgId: seed.orgId,
        connectionId: forge,
        env: parseEnv(process.env),
        adapter: confluenceSourceAdapter,
        write: async (write) => {
          writes.push(write)
        },
      })
      return writes
    }
    for (let attempt = 1; attempt < CONFLUENCE_SYNC_MAX_TRIES; attempt += 1) {
      // The failed scope keeps its last good copy; the other Workspace syncs.
      expect((await sync()).map((write) => write.workspaceId)).toEqual([guide])
      expect(await status(forge, "all")).toBeNull()
    }
    const last = await sync()
    expect(last.map((write) => write.workspaceId).sort()).toEqual(
      [all, guide].sort(),
    )
    const allWrite = last.find((write) => write.workspaceId === all)
    expect(allWrite?.files.some((file) => file.path.includes("--3"))).toBe(
      false,
    )
    expect(await status(forge, "all")).toMatchObject({
      status: "out_of_access",
      detail: expect.stringMatching(/page 3/),
    })
    expect(await status(forge, ["2"])).toBeNull()

    // A fixed page syncs again and clears the status.
    site.failingPages.clear()
    await sync()
    expect(await status(forge, "all")).toBeNull()
  })

  it.each([
    ["a typo space key", "ENGG", false],
    ["a deleted space", "ENG", true],
  ])(
    "reports %s after bounded tries, also when the site cannot answer",
    async (_name, key, deleteSpace) => {
      const forge = await seed.addConnection("forge", installed)
      const workspaceId = await seed.addWorkspace(`conf-space-${key}`)
      await replaceWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId,
        revision: "f".repeat(40),
        rows: [
          {
            ...confluenceRow("docs", forge, "all"),
            scope: { spaces: [{ key, pages: "all" }] },
          },
        ],
      })
      if (deleteSpace) site.spaces = []
      const writes: WorkspaceSliceWrite[] = []
      for (let attempt = 1; attempt <= CONFLUENCE_SYNC_MAX_TRIES; attempt += 1)
        await syncConnectionSources({
          orgId: seed.orgId,
          connectionId: forge,
          env: parseEnv(process.env),
          adapter: confluenceSourceAdapter,
          write: async (write) => {
            writes.push(write)
          },
        })
      // Only the last try writes: it removes the old content of the space.
      expect(writes).toHaveLength(1)
      expect(writes[0]?.files).toEqual([])
      const scope = { spaces: [{ key, pages: "all" as const }] }
      expect(
        await confluenceSourceAdapter.syncStatus?.({
          orgId: seed.orgId,
          connectionId: forge,
          scope,
        }),
      ).toMatchObject({
        status: "out_of_access",
        detail: expect.stringContaining(key),
      })
      // An outage of the site does not hide the recorded problem.
      server.use(
        http.get(`${api}/api/v2/spaces`, () =>
          HttpResponse.json({}, { status: 503 }),
        ),
      )
      expect(
        await confluenceSourceAdapter.checkAccess?.({
          orgId: seed.orgId,
          connectionId: forge,
          scope,
          env: parseEnv(process.env),
        }),
      ).toContain(key)
      server.resetHandlers()
    },
  )

  it("marks a space that the site does not have as out of access", async () => {
    const forge = await seed.addConnection("forge", installed)
    const check = (key: string) =>
      confluenceSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: forge,
        scope: { spaces: [{ key, pages: "all" }] },
        env: parseEnv(process.env),
      })
    expect(await check("ENG")).toBeNull()
    expect(await check("HR")).toMatch(/no space HR/)
  })

  it("matches a webhook event to the sources whose scope it touches", () => {
    const matches = (pages: "all" | string[], event: Record<string, unknown>) =>
      confluenceSourceAdapter.matchesEvent?.({
        event,
        scope: { spaces: [{ key: "ENG", pages }] },
      })
    expect(matches("all", { spaceKeys: ["ENG"], pageId: "9" })).toBe(true)
    expect(matches("all", { spaceKeys: ["HR"] })).toBe(false)
    expect(matches(["2"], { spaceKeys: ["ENG"], pageId: "2" })).toBe(true)
    expect(matches(["2"], { spaceKeys: ["ENG"], pageId: "9" })).toBe(false)
    expect(
      matches(["2"], {
        spaceKeys: ["ENG"],
        pageId: "9",
        eventType: "avi:confluence:deleted:page",
      }),
    ).toBe(true)
    expect(matches(["2"], { spaceKeys: ["ENG"] })).toBe(true)
  })
})
