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
  getPlainConnection,
  getPlainConnectionStatus,
  markPlainConnectionRevoked,
} from "../../models/plain-connector.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import {
  PLAIN_SYNC_MAX_TRIES,
  plainSourceAdapter,
} from "./workspace-source-adapter.js"

/** The Plain workspace that msw serves. */
const pl = {
  articles: new Map<string, Array<{ id: string; slug: string }>>([
    [
      "hc_a",
      [
        { id: "a1", slug: "reset-a-password" },
        { id: "a2", slug: "billing" },
      ],
    ],
    ["hc_b", [{ id: "a3", slug: "release-notes" }]],
  ]),
  labelThreads: new Map<string, string[]>([["lt_bug", ["th_11"]]]),
  /** Keys (`helpCenter:<id>`, `label:<id>`) that Plain answers with null. */
  missing: new Set<string>(),
  /** An HTTP status for a read, for example 503. */
  status: new Map<string, number>(),
  unauthorized: false,
  reads: [] as string[],
}

const page = <T>(nodes: T[]) => ({
  edges: nodes.map((node) => ({ node })),
  pageInfo: { hasNextPage: false, endCursor: null },
})
const at = { iso8601: "2026-10-14T00:00:00.000Z" }

function answer(operationName: string, variables: Record<string, string>) {
  switch (operationName) {
    case "PlainHelpCenterArticles": {
      const id = variables.helpCenterId ?? ""
      pl.reads.push(`articles:${id}`)
      if (pl.missing.has(`helpCenter:${id}`)) return { helpCenter: null }
      return {
        helpCenter: {
          isDeleted: false,
          articles: page(
            (pl.articles.get(id) ?? []).map((article) => ({
              ...article,
              title: article.slug,
              contentHtml: `<p>${article.slug} body</p>`,
              status: "PUBLISHED",
              createdAt: at,
              updatedAt: at,
              articleGroup: null,
            })),
          ),
        },
      }
    }
    case "PlainLabelThreads": {
      const id = variables.labelTypeId ?? ""
      pl.reads.push(`threads:${id}`)
      return {
        labelType: pl.missing.has(`label:${id}`) ? null : { isArchived: false },
        threads: page(
          (pl.labelThreads.get(id) ?? []).map((threadId) => ({
            id: threadId,
            ref: "T-11",
            title: "Export fails",
            status: "TODO",
            priority: 2,
            createdAt: at,
            updatedAt: at,
            customer: { fullName: "Robin Lee" },
            labels: [{ labelType: { name: "Bug" } }],
            timelineEntries: page([
              {
                timestamp: at,
                // The text carries an email; the file must not.
                llmText: "It fails. Write to robin@example.com",
                entry: { __typename: "EmailEntry" },
                actor: {
                  __typename: "CustomerActor",
                  customer: { fullName: "Robin Lee" },
                },
              },
            ]),
          })),
        ),
      }
    }
    case "PlainHelpCenters":
      pl.reads.push("helpCenters")
      return {
        helpCenters: page([
          { id: "hc_a", internalName: "Docs", isDeleted: false },
          { id: "hc_b", internalName: "Releases", isDeleted: false },
        ]),
      }
    case "PlainLabelTypes":
      pl.reads.push("labelTypes")
      return { labelTypes: page([{ id: "lt_bug", name: "Bug" }]) }
    default:
      throw new Error(`Unexpected ${operationName}`)
  }
}

const server = setupServer(
  http.post("https://core-api.uk.plain.com/graphql/v1", async ({ request }) => {
    const { operationName, variables } = (await request.json()) as {
      operationName: string
      variables: Record<string, string>
    }
    if (pl.unauthorized) return new HttpResponse(null, { status: 401 })
    const key = variables.helpCenterId
      ? `helpCenter:${variables.helpCenterId}`
      : `label:${variables.labelTypeId}`
    const status = pl.status.get(key)
    if (status) {
      pl.reads.push(`failed:${key}`)
      return new HttpResponse(null, { status })
    }
    return HttpResponse.json({ data: answer(operationName, variables) })
  }),
)

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>

const installed = (apiKey = "key-1") => ({
  workspaceId: "w_1",
  workspaceName: "Acme",
  apiKeyEnc: encryptConnectionSecret(apiKey, env),
  status: "installed",
})

async function addSource(
  connectionId: string,
  slug: string,
  scope: { helpCenters?: string[]; labels?: string[] },
) {
  const workspaceId = await seed.addWorkspace(slug)
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: "a".repeat(40),
    rows: [
      {
        sourceKey: slug,
        provider: "plain",
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
  await withLogger(createLogger({ test: "plain-sources" }), () =>
    syncConnectionSources({
      orgId: seed.orgId,
      connectionId,
      env,
      adapter: plainSourceAdapter,
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

describe("Plain source adapter (Postgres + msw)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("wsrc_plain")
    env = parseEnv(process.env)
  })
  afterEach(() => {
    vi.useRealTimers()
    pl.unauthorized = false
    pl.reads.length = 0
    pl.missing.clear()
    pl.status.clear()
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  it("reads each Help Center and label once and writes each Workspace only its items", async () => {
    const connection = await seed.addConnection("plain", installed())
    const docs = await addSource(connection, "pl-docs", {
      helpCenters: ["hc_a"],
    })
    const both = await addSource(connection, "pl-both", {
      helpCenters: ["hc_a", "hc_b"],
      labels: ["lt_bug"],
    })

    const writes = await sync(connection)

    expect(pl.reads.sort()).toEqual([
      "articles:hc_a",
      "articles:hc_b",
      "threads:lt_bug",
    ])
    expect(paths(writes.get(docs))).toEqual([
      "plain/help-centers/hc_a/billing--a2.md",
      "plain/help-centers/hc_a/reset-a-password--a1.md",
    ])
    expect(paths(writes.get(both))).toEqual([
      "plain/help-centers/hc_a/billing--a2.md",
      "plain/help-centers/hc_a/reset-a-password--a1.md",
      "plain/help-centers/hc_b/release-notes--a3.md",
      "plain/threads/labels/lt_bug/th_11.md",
    ])
    const thread = writes
      .get(both)
      ?.files.find((file) => file.path.endsWith("/th_11.md"))?.content
    expect(thread).toContain("- Customer: Robin Lee")
    expect(thread).toContain("It fails. Write to \\[email removed\\]")
    expect(thread).not.toContain("robin@example.com")
  })

  it("reads only the labels on a thread event, and keeps the article files", async () => {
    const connection = await seed.addConnection("plain", installed())
    const both = await addSource(connection, "pl-event-both", {
      helpCenters: ["hc_a"],
      labels: ["lt_bug"],
    })
    const docs = await addSource(connection, "pl-event-docs", {
      helpCenters: ["hc_a"],
    })

    const writes = await sync(connection, [], { kind: "threads" })

    expect(pl.reads).toEqual(["threads:lt_bug"])
    expect(paths(writes.get(both))).toEqual([
      "plain/threads/labels/lt_bug/th_11.md",
    ])
    expect(writes.get(both)?.keepPrefixes).toEqual(["plain/help-centers/hc_a/"])
    // A source with only Help Centers does not take a thread event.
    expect(writes.has(docs)).toBe(false)
  })

  it("skips unchanged files and deletes the items that left the scope", async () => {
    const connection = await seed.addConnection("plain", installed())
    const docs = await addSource(connection, "pl-patch", {
      helpCenters: ["hc_a"],
    })
    const first = (await sync(connection)).get(docs)
    const kept = first?.files.find((file) => file.path.endsWith("--a1.md"))
    const gone = "plain/help-centers/hc_a/old-article--a9.md"

    const write = (
      await sync(connection, [
        { path: kept?.path ?? "", sha: blobSha(kept?.content ?? "") },
        { path: gone, sha: blobSha("old") },
      ])
    ).get(docs)

    expect(paths(write)).toEqual(["plain/help-centers/hc_a/billing--a2.md"])
    expect(write?.deletePaths).toEqual([gone])
  })

  it("keeps a missing label, counts only permanent failures, then marks its source", async () => {
    const connection = await seed.addConnection("plain", installed())
    const docs = await addSource(connection, "pl-fail-docs", {
      helpCenters: ["hc_a"],
    })
    const mixed = await addSource(connection, "pl-fail-mixed", {
      helpCenters: ["hc_b"],
      labels: ["lt_gone"],
    })

    // An outage keeps the copy and does not count.
    pl.status.set("label:lt_gone", 503)
    let writes = await sync(connection)
    expect(writes.get(mixed)?.keepPrefixes).toEqual([
      "plain/threads/labels/lt_gone/",
    ])

    pl.status.clear()
    pl.missing.add("label:lt_gone")
    vi.useFakeTimers({ toFake: ["Date"] })
    for (let cycle = 1; cycle <= PLAIN_SYNC_MAX_TRIES; cycle += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 14, cycle * 2)))
      writes = await sync(connection)
      expect(paths(writes.get(docs))).toHaveLength(2)
      expect(paths(writes.get(mixed))).toEqual([
        "plain/help-centers/hc_b/release-notes--a3.md",
      ])
    }

    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: mixed,
    })
    expect(row?.status).toBe("out_of_access")
    expect(row?.statusDetail).toContain("Plain label lt_gone does not exist")
  })

  it("names a Help Center or a label that the connection cannot read, from two list reads", async () => {
    const connection = await seed.addConnection("plain", installed())

    expect(
      await plainSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: { helpCenters: ["hc_a", "hc_x"], labels: ["lt_bug", "lt_x"] },
        env,
      }),
    ).toBe(
      "ctx| cannot read Plain Help Center hc_x. Check that it exists.; ctx| cannot read Plain label lt_x. Check that it exists and is not archived.",
    )
    expect(pl.reads.sort()).toEqual(["helpCenters", "labelTypes"])
  })

  it("keeps every file and marks the connection revoked when Plain refuses its key", async () => {
    const connection = await seed.addConnection("plain", installed())
    const docs = await addSource(connection, "pl-revoked", {
      helpCenters: ["hc_a"],
    })
    pl.unauthorized = true

    const writes = await sync(connection)

    expect(writes.has(docs)).toBe(false)
    expect(await getPlainConnectionStatus(seed.orgId, connection)).toBe(
      "revoked",
    )
    expect(
      await plainSourceAdapter.syncStatus?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: { helpCenters: ["hc_a"] },
      }),
    ).toEqual({
      status: "out_of_access",
      detail: expect.stringMatching(/Reconnect Plain/),
    })
    pl.reads.length = 0
    await sync(connection)
    expect(pl.reads).toEqual([])
  })

  it("does not revoke a key that a reconnect replaced during the sync", async () => {
    const connection = await seed.addConnection("plain", installed("key-new"))
    const stale = encryptConnectionSecret("key-old", env)

    await markPlainConnectionRevoked({
      orgId: seed.orgId,
      connectionId: connection,
      apiKeyEnc: stale,
    })

    expect(
      (await getPlainConnection(seed.orgId, connection, env))?.status,
    ).toBe("installed")
  })
})
