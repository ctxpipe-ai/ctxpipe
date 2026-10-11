import { and, eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSpaces } from "../../db/schema/confluenceSpaces.js"
import {
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "../../domain/workspace-sources/sync.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { confluenceSourceAdapter } from "./workspace-source-adapter.js"

const api = "https://api.atlassian.com/ex/confluence/cloud-acme/wiki"
const pageReads: string[] = []
const server = setupServer(
  http.get(`${api}/api/v2/spaces`, () =>
    HttpResponse.json({
      results: [
        { id: "100", key: "ENG", name: "Engineering", homepageId: "1" },
      ],
    }),
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
    pageReads.length = 0
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  it("fetches each page once and writes each Workspace its own page tree", async () => {
    const forge = await seed.addConnection("forge", {
      cloudId: "cloud-acme",
      appSystemToken: "fixture-token",
      status: "installed",
    })
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

    const [cursor] = await withOrgDbContext(seed.orgId, (db) =>
      db
        .select()
        .from(confluenceSpaces)
        .where(
          and(
            eq(confluenceSpaces.connectionId, forge),
            eq(confluenceSpaces.spaceKey, "ENG"),
          ),
        ),
    )
    expect(cursor?.lastSyncedAt).toBeInstanceOf(Date)
    expect(cursor?.selectedPageIds).toBeNull()
  })

  it("marks a space that the site does not have as out of access", async () => {
    const forge = await seed.addConnection("forge", {
      cloudId: "cloud-acme",
      appSystemToken: "fixture-token",
      status: "installed",
    })
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
