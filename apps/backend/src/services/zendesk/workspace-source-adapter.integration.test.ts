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
import {
  getZendeskConnection,
  getZendeskConnectionStatus,
} from "../../models/zendesk-connector.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import {
  ZENDESK_SYNC_MAX_TRIES,
  zendeskSourceAdapter,
} from "./workspace-source-adapter.js"

const API = "https://acme.zendesk.com/api/v2"

/** The Zendesk account that msw serves. */
const zd = {
  articles: new Map<string, Array<{ id: number; title: string }>>([
    [
      "36",
      [
        { id: 1, title: "Reset a password" },
        { id: 2, title: "Billing" },
      ],
    ],
    ["37", [{ id: 3, title: "Release notes" }]],
  ]),
  viewTickets: new Map<string, number[]>([["90", [11]]]),
  /** A status for a list read, for example 404 or 503. */
  status: new Map<string, number>(),
  unauthorized: false,
  reads: [] as string[],
}

const unauthorized = () =>
  zd.unauthorized ? HttpResponse.json({}, { status: 401 }) : undefined
const failing = (key: string) => {
  const status = zd.status.get(key)
  return status ? HttpResponse.json({}, { status }) : undefined
}

const server = setupServer(
  http.get(`${API}/help_center/categories/:id/articles`, ({ params }) => {
    const id = String(params.id)
    zd.reads.push(`articles:${id}`)
    return (
      unauthorized() ??
      failing(`category:${id}`) ??
      HttpResponse.json({
        articles: (zd.articles.get(id) ?? []).map((article) => ({
          ...article,
          body: `<p>${article.title} body</p>`,
          html_url: `https://acme.zendesk.com/hc/en-us/articles/${article.id}`,
          draft: false,
        })),
        meta: { has_more: false },
      })
    )
  }),
  http.get(`${API}/views/:id/tickets`, ({ params }) => {
    const id = String(params.id)
    zd.reads.push(`tickets:${id}`)
    return (
      unauthorized() ??
      failing(`view:${id}`) ??
      HttpResponse.json({
        tickets: (zd.viewTickets.get(id) ?? []).map((ticket) => ({
          id: ticket,
          subject: `Ticket ${ticket}`,
          status: "open",
          requester_id: 1,
          tags: [],
        })),
      })
    )
  }),
  http.get(`${API}/tickets/:id/comments`, () =>
    HttpResponse.json({
      comments: [
        {
          author_id: 1,
          plain_body: "It fails.",
          public: true,
          created_at: "t",
        },
      ],
      // The sideload carries the email; the file must not.
      users: [{ id: 1, name: "Alex Kim", email: "not-mirrored@example.com" }],
      meta: { has_more: false },
    }),
  ),
  http.get(`${API}/help_center/categories`, () => {
    zd.reads.push("categories")
    return HttpResponse.json({
      categories: [
        { id: 36, name: "Accounts" },
        { id: 37, name: "Releases" },
      ],
      meta: { has_more: false },
    })
  }),
  http.get(`${API}/views`, () => {
    zd.reads.push("views")
    return HttpResponse.json({
      views: [{ id: 90, title: "Escalations", active: true }],
      meta: { has_more: false },
    })
  }),
)

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>

const installed = () => ({
  subdomain: "acme",
  status: "installed",
  oauthClientId: "local-client",
  oauthClientSecretEnc: encryptConnectionSecret("local-secret", env),
  accessTokenEnc: encryptConnectionSecret("access-1", env),
  refreshTokenEnc: encryptConnectionSecret("refresh-1", env),
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
})

async function addSource(
  connectionId: string,
  slug: string,
  scope: { categories?: string[]; views?: string[] },
) {
  const workspaceId = await seed.addWorkspace(slug)
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: "a".repeat(40),
    rows: [
      {
        sourceKey: slug,
        provider: "zendesk",
        connectionId,
        scope,
        status: "ok",
        statusDetail: null,
      },
    ],
  })
  return workspaceId
}

async function sync(
  connectionId: string,
  blobs?: Array<{ path: string; sha: string }>,
  event?: unknown,
) {
  const writes: WorkspaceSliceWrite[] = []
  await withLogger(createLogger({ test: "zendesk-sources" }), () =>
    syncConnectionSources({
      orgId: seed.orgId,
      connectionId,
      env,
      adapter: zendeskSourceAdapter,
      event,
      readExisting: blobs ? async () => blobs : undefined,
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

describe("Zendesk source adapter (Postgres + msw)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("wsrc_zendesk")
    env = parseEnv(process.env)
  })
  afterEach(() => {
    vi.useRealTimers()
    zd.unauthorized = false
    zd.reads.length = 0
    zd.status.clear()
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  it("reads each category and view once and writes each Workspace only its items", async () => {
    const connection = await seed.addConnection("zendesk", installed())
    const docs = await addSource(connection, "zd-docs", { categories: ["36"] })
    const both = await addSource(connection, "zd-both", {
      categories: ["36", "37"],
      views: ["90"],
    })

    const writes = await sync(connection)

    expect(zd.reads.sort()).toEqual([
      "articles:36",
      "articles:37",
      "tickets:90",
    ])
    expect(paths(writes.get(docs))).toEqual([
      "zendesk/help-center/categories/36/billing--2.md",
      "zendesk/help-center/categories/36/reset-a-password--1.md",
    ])
    expect(paths(writes.get(both))).toEqual([
      "zendesk/help-center/categories/36/billing--2.md",
      "zendesk/help-center/categories/36/reset-a-password--1.md",
      "zendesk/help-center/categories/37/release-notes--3.md",
      "zendesk/tickets/views/90/11.md",
    ])
    const ticket = writes
      .get(both)
      ?.files.find((file) => file.path.endsWith("/11.md"))?.content
    expect(ticket).toContain("- Requester: Alex Kim")
    expect(ticket).toContain("It fails.")
    expect(ticket).not.toContain("not-mirrored")
  })

  it("reads only the categories on an article event, and keeps the ticket files", async () => {
    const connection = await seed.addConnection("zendesk", installed())
    const both = await addSource(connection, "zd-event-both", {
      categories: ["36"],
      views: ["90"],
    })
    const tickets = await addSource(connection, "zd-event-tickets", {
      views: ["90"],
    })

    const writes = await sync(connection, [], { kind: "articles" })

    expect(zd.reads).toEqual(["articles:36"])
    expect(paths(writes.get(both))).toHaveLength(2)
    expect(writes.get(both)?.keepPrefixes).toEqual([
      "zendesk/tickets/views/90/",
    ])
    // A source with only views does not take an article event.
    expect(writes.has(tickets)).toBe(false)
  })

  it("skips unchanged files and deletes the items that left the scope", async () => {
    const connection = await seed.addConnection("zendesk", installed())
    const docs = await addSource(connection, "zd-patch", { categories: ["36"] })
    const first = (await sync(connection)).get(docs)
    const kept = first?.files.find((file) => file.path.endsWith("--1.md"))
    const gone = "zendesk/help-center/categories/36/old-article--9.md"

    const write = (
      await sync(connection, [
        { path: kept?.path ?? "", sha: blobSha(kept?.content ?? "") },
        { path: gone, sha: blobSha("old") },
      ])
    ).get(docs)

    expect(paths(write)).toEqual([
      "zendesk/help-center/categories/36/billing--2.md",
    ])
    expect(write?.deletePaths).toEqual([gone])
  })

  it("keeps a missing view, counts only permanent failures, then marks its source", async () => {
    const connection = await seed.addConnection("zendesk", installed())
    const docs = await addSource(connection, "zd-fail-docs", {
      categories: ["36"],
    })
    const mixed = await addSource(connection, "zd-fail-mixed", {
      categories: ["37"],
      views: ["91"],
    })

    // An outage keeps the copy and does not count.
    zd.status.set("view:91", 503)
    let writes = await sync(connection)
    expect(writes.get(mixed)?.keepPrefixes).toEqual([
      "zendesk/tickets/views/91/",
    ])

    zd.status.set("view:91", 404)
    vi.useFakeTimers({ toFake: ["Date"] })
    for (let cycle = 1; cycle <= ZENDESK_SYNC_MAX_TRIES; cycle += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 14, cycle * 2)))
      writes = await sync(connection)
      expect(paths(writes.get(docs))).toHaveLength(2)
      expect(paths(writes.get(mixed))).toEqual([
        "zendesk/help-center/categories/37/release-notes--3.md",
      ])
    }

    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: mixed,
    })
    expect(row?.status).toBe("out_of_access")
    expect(row?.statusDetail).toContain("Zendesk view 91 does not exist")
  })

  it("names a category or a view that the connection cannot read, from two list reads", async () => {
    const connection = await seed.addConnection("zendesk", installed())

    expect(
      await zendeskSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: { categories: ["36", "38"], views: ["90", "92"] },
        env,
      }),
    ).toBe(
      "ctx| cannot read Zendesk Help Center category 38. Check that it exists, and that the Zendesk user can read it.; ctx| cannot read Zendesk view 92. Check that it exists, is active, and is shared with the Zendesk user.",
    )
    expect(zd.reads.sort()).toEqual(["categories", "views"])
  })

  it("does not revoke a connection whose token expired during the sync", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const start = Date.UTC(2026, 9, 14, 12)
    vi.setSystemTime(new Date(start))
    const connection = await seed.addConnection("zendesk", {
      ...installed(),
      // Valid at the start, expired when the view is read.
      accessTokenExpiresAt: new Date(start + 90_000).toISOString(),
    })
    const both = await addSource(connection, "zd-expiry", {
      categories: ["36"],
      views: ["90"],
    })
    server.use(
      http.get(`${API}/views/:id/tickets`, () => {
        vi.setSystemTime(new Date(start + 120_000))
        return HttpResponse.json({}, { status: 401 })
      }),
    )

    const writes = await sync(connection)

    expect(writes.get(both)?.keepPrefixes).toEqual([
      "zendesk/tickets/views/90/",
    ])
    expect(await getZendeskConnectionStatus(seed.orgId, connection)).toBe(
      "installed",
    )
    server.resetHandlers()
  })

  it("keeps every file and marks the connection revoked when Zendesk refuses its token", async () => {
    const connection = await seed.addConnection("zendesk", installed())
    const docs = await addSource(connection, "zd-revoked", {
      categories: ["36"],
    })
    zd.unauthorized = true

    const writes = await sync(connection)

    expect(writes.has(docs)).toBe(false)
    expect(await getZendeskConnectionStatus(seed.orgId, connection)).toBe(
      "revoked",
    )
    expect(
      await zendeskSourceAdapter.syncStatus?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: { categories: ["36"] },
      }),
    ).toEqual({
      status: "out_of_access",
      detail: expect.stringMatching(/Reconnect Zendesk/),
    })
    zd.reads.length = 0
    await sync(connection)
    expect(zd.reads).toEqual([])
    expect(
      (await getZendeskConnection(seed.orgId, connection, env))?.status,
    ).toBe("revoked")
  })
})
