import { createHash } from "node:crypto"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { parseEnv } from "../../config/env.js"
import {
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "../../domain/workspace-sources/sync.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { loadNotionStoredConfig } from "./connection-load.js"
import {
  NOTION_SYNC_MAX_TRIES,
  notionSourceAdapter,
} from "./workspace-source-adapter.js"

const id = (n: number) =>
  `1a2b3c4d-0000-4000-8000-${String(n).padStart(12, "0")}`
const HANDBOOK = id(1)
const SETUP = id(2)
const TASKS = id(3)
const ROW = id(4)
const GONE = id(5)

/** The Notion workspace that msw serves. */
const notion = {
  titles: new Map<string, string>([
    [HANDBOOK, "Handbook"],
    [SETUP, "Setup"],
    [ROW, "Ship it"],
  ]),
  parents: new Map<string, string>([[SETUP, HANDBOOK]]),
  children: new Map<string, string[]>([[HANDBOOK, [SETUP]]]),
  failing: new Map<string, number>(),
  /** Notion refuses the access token (a revoked install). */
  unauthorized: false,
  reads: [] as string[],
  /** The id of the row that the database query returns. */
  rowId: ROW,
}

const page = (pageId: string) => ({
  object: "page",
  id: pageId,
  url: `https://www.notion.so/${pageId.replaceAll("-", "")}`,
  parent: notion.parents.has(pageId)
    ? { type: "page_id", page_id: notion.parents.get(pageId) }
    : pageId === ROW
      ? { type: "data_source_id", data_source_id: TASKS }
      : { type: "workspace", workspace: true },
  properties: {
    Name: {
      type: "title",
      title: [{ plain_text: notion.titles.get(pageId) ?? "Untitled" }],
    },
  },
})

const failure = (key: string) => {
  if (notion.unauthorized)
    return HttpResponse.json({ code: "unauthorized" }, { status: 401 })
  const status = notion.failing.get(key)
  return status
    ? HttpResponse.json({ message: "failed" }, { status })
    : undefined
}

const api = "https://api.notion.com/v1"
const server = setupServer(
  http.get(`${api}/pages/:pageId`, ({ params }) => {
    const pageId = String(params.pageId)
    notion.reads.push(`page:${pageId}`)
    return failure(pageId) ?? HttpResponse.json(page(pageId))
  }),
  http.post(`${api}/oauth/token`, () =>
    HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
  ),
  http.get(`${api}/blocks/:blockId/children`, ({ params }) => {
    const blockId = String(params.blockId)
    const failed = failure(blockId)
    if (failed) return failed
    return HttpResponse.json({
      results: [
        {
          object: "block",
          id: `${blockId.slice(0, -4)}b10c`,
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              { plain_text: `Body of ${notion.titles.get(blockId)}` },
            ],
          },
        },
        ...(notion.children.get(blockId) ?? []).map((child) => ({
          object: "block",
          id: child,
          type: "child_page",
          has_children: true,
          child_page: { title: notion.titles.get(child) },
        })),
      ],
      has_more: false,
    })
  }),
  http.get(`${api}/data_sources/:dataSourceId`, ({ params }) => {
    const dataSourceId = String(params.dataSourceId)
    return failure(dataSourceId) ?? HttpResponse.json({ id: dataSourceId })
  }),
  http.post(`${api}/data_sources/:dataSourceId/query`, ({ params }) => {
    const dataSourceId = String(params.dataSourceId)
    notion.reads.push(`database:${dataSourceId}`)
    return (
      failure(dataSourceId) ??
      HttpResponse.json({ results: [page(notion.rowId)], has_more: false })
    )
  }),
)

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>

const installed = {
  accessToken: "fixture-token",
  workspaceId: "notion-ws-fixture",
  status: "installed",
}

const notionRow = (
  sourceKey: string,
  connectionId: string,
  scope: Record<string, unknown>,
) => ({
  sourceKey,
  provider: "notion" as const,
  connectionId,
  scope,
  status: "ok" as const,
  statusDetail: null,
})

async function addSource(
  connectionId: string,
  slug: string,
  scope: Record<string, unknown>,
) {
  const workspaceId = await seed.addWorkspace(slug)
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: "a".repeat(40),
    rows: [notionRow(slug, connectionId, scope)],
  })
  return workspaceId
}

async function sync(
  connectionId: string,
  extra: {
    event?: unknown
    blobs?: Array<{ path: string; sha: string }>
  } = {},
) {
  const writes: WorkspaceSliceWrite[] = []
  await withLogger(createLogger({ test: "notion-sources" }), () =>
    syncConnectionSources({
      orgId: seed.orgId,
      connectionId,
      env,
      adapter: notionSourceAdapter,
      event: extra.event,
      readExisting: extra.blobs ? async () => extra.blobs ?? [] : undefined,
      write: async (write) => {
        writes.push(write)
      },
    }),
  )
  return new Map(writes.map((write) => [write.workspaceId, write]))
}

const paths = (write: WorkspaceSliceWrite | undefined) =>
  (write?.files ?? []).map((file) => file.path).sort()

const blobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex")

describe("Notion source adapter (Postgres + msw)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("wsrc_notion")
    env = parseEnv(process.env)
  })
  afterEach(() => {
    vi.useRealTimers()
    notion.unauthorized = false
    notion.reads.length = 0
    notion.failing.clear()
    notion.rowId = ROW
    notion.titles.set(HANDBOOK, "Handbook")
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  it("fetches each root once and writes each Workspace its own roots", async () => {
    const connection = await seed.addConnection("notion", installed)
    const docs = await addSource(connection, "notion-docs", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })
    const ops = await addSource(connection, "notion-ops", {
      pages: [{ id: SETUP, title: "Setup" }],
      databases: [{ id: TASKS, title: "Tasks" }],
    })
    const both = await addSource(connection, "notion-both", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })

    const writes = await sync(connection)

    // The Handbook tree is read one time for two Workspaces.
    expect(
      notion.reads.filter((read) => read === `page:${HANDBOOK}`),
    ).toHaveLength(1)
    expect(paths(writes.get(docs))).toEqual([
      `notion/pages/handbook--${HANDBOOK}/index.md`,
      `notion/pages/handbook--${HANDBOOK}/setup--${SETUP}/index.md`,
    ])
    expect(paths(writes.get(both))).toEqual(paths(writes.get(docs)))
    // A root inside another root still syncs its full subtree on its own.
    expect(paths(writes.get(ops))).toEqual(
      expect.arrayContaining([
        `notion/pages/setup--${SETUP}/index.md`,
        `notion/databases/tasks--${TASKS}/index.md`,
      ]),
    )
    expect(writes.get(ops)?.ownedPrefixes).toEqual([
      `notion/databases/tasks--${TASKS}/`,
      `notion/pages/setup--${SETUP}/`,
    ])
  })

  it("names the root folder with the source title after a rename in Notion", async () => {
    const connection = await seed.addConnection("notion", installed)
    const docs = await addSource(connection, "notion-renamed", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })
    notion.titles.set(HANDBOOK, "Company handbook")

    const writes = await sync(connection)

    expect(paths(writes.get(docs))).toEqual([
      `notion/pages/handbook--${HANDBOOK}/index.md`,
      `notion/pages/handbook--${HANDBOOK}/setup--${SETUP}/index.md`,
    ])
  })

  it("skips unchanged files and deletes stale ones as a patch", async () => {
    const connection = await seed.addConnection("notion", installed)
    const docs = await addSource(connection, "notion-patch", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })
    const first = (await sync(connection)).get(docs)
    const root = first?.files.find((file) =>
      file.path.endsWith(`${HANDBOOK}/index.md`),
    )
    const stale = `notion/pages/handbook--${HANDBOOK}/old--${GONE}/index.md`

    const writes = await sync(connection, {
      blobs: [
        { path: root?.path ?? "", sha: blobSha(root?.content ?? "") },
        { path: stale, sha: blobSha("old") },
      ],
    })

    const write = writes.get(docs)
    expect(paths(write)).toEqual([
      `notion/pages/handbook--${HANDBOOK}/setup--${SETUP}/index.md`,
    ])
    expect(write?.deletePaths).toEqual([stale])
  })

  it("keeps a failing root, counts only permanent failures, then marks the source", async () => {
    const connection = await seed.addConnection("notion", installed)
    const docs = await addSource(connection, "notion-fail-docs", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })
    const mixed = await addSource(connection, "notion-fail-mixed", {
      pages: [{ id: GONE, title: "Gone" }],
      databases: [{ id: TASKS, title: "Tasks" }],
    })

    // An outage keeps the copy and does not count.
    notion.failing.set(GONE, 503)
    let writes = await sync(connection)
    expect(writes.get(mixed)?.keepPrefixes).toEqual([
      `notion/pages/gone--${GONE}/`,
    ])
    expect(
      (await loadNotionStoredConfig(seed.orgId, connection))?.sourceSync
        ?.failures,
    ).toEqual({})

    notion.failing.set(GONE, 404)
    vi.useFakeTimers({ toFake: ["Date"] })
    for (let cycle = 1; cycle <= NOTION_SYNC_MAX_TRIES; cycle += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, cycle * 2)))
      writes = await sync(connection)
      // The other roots and Workspaces still sync.
      expect(paths(writes.get(docs))).toHaveLength(2)
      expect(paths(writes.get(mixed))).toContain(
        `notion/databases/tasks--${TASKS}/index.md`,
      )
      expect(writes.get(mixed)?.keepPrefixes).toEqual([
        `notion/pages/gone--${GONE}/`,
      ])
    }

    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: mixed,
    })
    expect(row?.status).toBe("out_of_access")
    expect(row?.statusDetail).toContain(`Notion page "Gone" (${GONE})`)
    const [docsRow] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: docs,
    })
    expect(docsRow?.status).toBe("ok")
  })

  it("counts a burst of failing syncs in one hour one time", async () => {
    const connection = await seed.addConnection("notion", installed)
    const gone = await addSource(connection, "notion-burst", {
      pages: [{ id: GONE, title: "Gone" }],
    })
    notion.failing.set(GONE, 404)
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, 9)))
    for (let sync_ = 0; sync_ < NOTION_SYNC_MAX_TRIES + 1; sync_ += 1)
      await sync(connection, {
        event: { entityType: "page", externalId: GONE, action: "upsert" },
        blobs: [],
      })
    const stored = await loadNotionStoredConfig(seed.orgId, connection)
    expect(stored?.sourceSync?.failures[`page:${GONE}`]?.tries).toBe(1)
    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: gone,
    })
    expect(row?.status).toBe("ok")
  })

  it("skips an unreadable child page, keeps its files, and does not blame the root", async () => {
    const connection = await seed.addConnection("notion", installed)
    const docs = await addSource(connection, "notion-child", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })
    notion.failing.set(SETUP, 403)
    const child = `notion/pages/handbook--${HANDBOOK}/setup--${SETUP}/index.md`

    const writes = await sync(connection, {
      blobs: [{ path: child, sha: blobSha("old setup") }],
    })

    const write = writes.get(docs)
    expect(paths(write)).toEqual([
      `notion/pages/handbook--${HANDBOOK}/index.md`,
    ])
    expect(write?.deletePaths ?? []).not.toContain(child)
    expect(write?.keepPrefixes).toContain(child)
    expect(
      (await loadNotionStoredConfig(seed.orgId, connection))?.sourceSync
        ?.failures,
    ).toEqual({})
  })

  it("keeps a hostile database row id from Notion under the database folder", async () => {
    const connection = await seed.addConnection("notion", installed)
    const docs = await addSource(connection, "notion-hostile-row", {
      databases: [{ id: TASKS, title: "Tasks" }],
    })
    const hostile = "../../../../.ctxpipe/workspace"
    notion.rowId = hostile
    notion.titles.set(hostile, "../Evil/../Row")

    const writes = await sync(connection)

    const written = paths(writes.get(docs))
    const row = `notion/databases/tasks--${TASKS}/rows/evil-row---.-..-..-..-.ctxpipe-workspace/index.md`
    expect(written).toContain(row)
    for (const path of written) {
      expect(path.startsWith(`notion/databases/tasks--${TASKS}/`)).toBe(true)
      expect(
        path.split("/").some((part) => ["", ".", ".."].includes(part)),
      ).toBe(false)
    }
  })

  it("marks the connection revoked when Notion refuses its token", async () => {
    const connection = await seed.addConnection("notion", installed)
    const docs = await addSource(connection, "notion-revoked", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })
    notion.unauthorized = true

    const writes = await sync(connection)

    expect(writes.has(docs)).toBe(false)
    expect((await loadNotionStoredConfig(seed.orgId, connection))?.status).toBe(
      "revoked",
    )
    const scope = { pages: [{ id: HANDBOOK, title: "Handbook" }] }
    expect(
      await notionSourceAdapter.syncStatus?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope,
      }),
    ).toEqual({
      status: "out_of_access",
      detail: expect.stringMatching(/Reconnect Notion/),
    })
    expect(
      await notionSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope,
        env,
      }),
    ).toMatch(/Reconnect Notion/)
  })

  it("marks the connection revoked when the token refresh fails", async () => {
    const connection = await seed.addConnection("notion", {
      ...installed,
      refreshToken: "fixture-refresh-token",
      oauthClientId: "fixture-client-id",
      oauthClientSecretEnc: encryptConnectionSecret("fixture-secret", env),
    })
    await addSource(connection, "notion-refresh", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })
    notion.unauthorized = true

    await sync(connection)

    expect((await loadNotionStoredConfig(seed.orgId, connection))?.status).toBe(
      "revoked",
    )
  })

  it("syncs only the roots that a webhook event touches", async () => {
    const connection = await seed.addConnection("notion", installed)
    const docs = await addSource(connection, "notion-event-docs", {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
    })
    const tasks = await addSource(connection, "notion-event-tasks", {
      databases: [{ id: TASKS, title: "Tasks" }],
    })

    const writes = await sync(connection, {
      event: { entityType: "page", externalId: SETUP, action: "upsert" },
      blobs: [],
    })

    expect(notion.reads).not.toContain(`database:${TASKS}`)
    expect(paths(writes.get(docs))).toHaveLength(2)
    expect(writes.has(tasks)).toBe(false)
    expect(
      notionSourceAdapter.matchesEvent?.({
        event: {
          entityType: "data_source",
          externalId: TASKS,
          action: "upsert",
        },
        scope: { pages: [{ id: HANDBOOK, title: "Handbook" }] },
      }),
    ).toBe(false)
  })

  it("tells a missing root from a Notion outage in the access check", async () => {
    const connection = await seed.addConnection("notion", installed)
    const check = (scope: Record<string, unknown>) =>
      notionSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: scope as never,
        env,
      })

    expect(
      await check({
        pages: [{ id: HANDBOOK, title: "Handbook" }],
        databases: [{ id: TASKS, title: "Tasks" }],
      }),
    ).toBeNull()
    notion.failing.set(TASKS, 404)
    notion.failing.set(HANDBOOK, 500)
    expect(
      await check({
        pages: [{ id: HANDBOOK, title: "Handbook" }],
        databases: [{ id: TASKS, title: "Tasks" }],
      }),
    ).toBe(
      `Notion database "Tasks" (${TASKS}) does not exist, or it is not shared with the ctx| integration`,
    )
  })
})
