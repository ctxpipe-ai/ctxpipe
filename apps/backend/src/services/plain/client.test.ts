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
import { PLAIN_REQUIRED_PERMISSIONS } from "../../domain/workspace-sources/providers/plain.js"
import {
  createPlainWebhookTarget,
  listPlainHelpCenterArticles,
  listPlainHelpCenters,
  listPlainLabelThreads,
  listPlainLabelTypes,
  PlainUnauthorizedError,
  verifyPlainApiKey,
} from "./client.js"

const API = "https://core-api.uk.plain.com/graphql/v1"
const server = setupServer()
type Operation = {
  operationName: string
  query: string
  variables: Record<string, unknown>
}
const operations: Operation[] = []

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  operations.length = 0
  vi.useRealTimers()
})
afterAll(() => server.close())

/** One GraphQL endpoint: each operation name gives its own data. */
function plain(
  answers: Record<string, (variables: Record<string, unknown>) => unknown>,
) {
  server.use(
    http.post(API, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe("Bearer key")
      const body = (await request.json()) as Operation
      operations.push(body)
      const answer = answers[body.operationName]
      if (!answer) throw new Error(`Unexpected ${body.operationName}`)
      const data = answer(body.variables ?? {})
      return data instanceof Response ? data : HttpResponse.json({ data })
    }),
  )
}

const iso = (iso8601: string) => ({ iso8601 })
const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  edges: nodes.map((node) => ({ node })),
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
})

describe("verifyPlainApiKey", () => {
  it("gives the workspace of a key with every permission", async () => {
    plain({
      PlainAccess: () => ({
        myWorkspace: { id: "w_1", name: "Acme" },
        myPermissions: {
          permissions: [...PLAIN_REQUIRED_PERMISSIONS, "customer:edit"],
        },
      }),
    })
    expect(await verifyPlainApiKey("key")).toEqual({
      ok: true,
      workspace: { id: "w_1", name: "Acme" },
    })
  })

  it("names the permissions that the key does not have", async () => {
    plain({
      PlainAccess: () => ({
        myWorkspace: { id: "w_1", name: "Acme" },
        myPermissions: {
          permissions: PLAIN_REQUIRED_PERMISSIONS.filter(
            (permission) =>
              permission !== "timeline:read" &&
              permission !== "webhookTarget:create",
          ),
        },
      }),
    })
    expect(await verifyPlainApiKey("key")).toEqual({
      ok: false,
      error:
        "The Plain API key does not have these permissions: timeline:read, webhookTarget:create",
    })
  })

  it("refuses a key that Plain does not accept", async () => {
    plain({
      PlainAccess: () =>
        HttpResponse.json(
          {
            errors: [
              {
                message: "Invalid API key",
                extensions: { code: "UNAUTHENTICATED" },
              },
            ],
          },
          { status: 200 },
        ),
    })
    expect(await verifyPlainApiKey("key")).toEqual({
      ok: false,
      error: "Plain does not accept this API key",
    })
  })
})

describe("listPlainHelpCenterArticles", () => {
  it("reads every page of published articles, with their group names", async () => {
    const article = (id: string, status: "PUBLISHED" | "DRAFT") => ({
      id,
      title: `Title ${id}`,
      slug: `slug-${id}`,
      contentHtml: `<p>${id}</p>`,
      status,
      createdAt: iso("2026-01-01T00:00:00.000Z"),
      updatedAt: iso("2026-02-01T00:00:00.000Z"),
      articleGroup: id === "a1" ? { name: "Billing" } : null,
    })
    plain({
      PlainHelpCenterArticles: (variables) => ({
        helpCenter: {
          isDeleted: false,
          articles: variables.after
            ? page([article("a3", "PUBLISHED")])
            : page([article("a1", "PUBLISHED"), article("a2", "DRAFT")], "c1"),
        },
      }),
    })
    const articles = await listPlainHelpCenterArticles({
      apiKey: "key",
      helpCenterId: "hc_1",
    })
    expect(operations.map((operation) => operation.variables)).toEqual([
      { helpCenterId: "hc_1", after: null },
      { helpCenterId: "hc_1", after: "c1" },
    ])
    expect(articles).toEqual([
      {
        id: "a1",
        title: "Title a1",
        slug: "slug-a1",
        contentHtml: "<p>a1</p>",
        groupName: "Billing",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
      expect.objectContaining({ id: "a3", groupName: null }),
    ])
  })

  it("gives not_found for a missing or deleted Help Center", async () => {
    plain({ PlainHelpCenterArticles: () => ({ helpCenter: null }) })
    expect(
      await listPlainHelpCenterArticles({
        apiKey: "key",
        helpCenterId: "hc_1",
      }),
    ).toBe("not_found")
    plain({
      PlainHelpCenterArticles: () => ({
        helpCenter: { isDeleted: true, articles: page([]) },
      }),
    })
    expect(
      await listPlainHelpCenterArticles({
        apiKey: "key",
        helpCenterId: "hc_1",
      }),
    ).toBe("not_found")
  })
  it("refuses an article id that is not a Plain id, because the id is a path segment", async () => {
    plain({
      PlainHelpCenterArticles: () => ({
        helpCenter: {
          isDeleted: false,
          articles: page([
            {
              id: "../../../knowledge/owner",
              title: "Title",
              slug: "slug",
              contentHtml: "<p>text</p>",
              status: "PUBLISHED",
              createdAt: iso("2026-01-01T00:00:00.000Z"),
              updatedAt: iso("2026-02-01T00:00:00.000Z"),
              articleGroup: null,
            },
          ]),
        },
      }),
    })
    await expect(
      listPlainHelpCenterArticles({ apiKey: "key", helpCenterId: "hc_1" }),
    ).rejects.toThrow()
  })
})

describe("listPlainLabelThreads", () => {
  const thread = (id: string, entries: unknown[], more = false) => ({
    id,
    ref: "T-12",
    title: "Export fails",
    status: "TODO",
    priority: 1,
    createdAt: iso("2026-03-01T00:00:00.000Z"),
    updatedAt: iso("2026-03-02T00:00:00.000Z"),
    customer: { fullName: "Robin Lee" },
    labels: [{ labelType: { name: "Bug" } }],
    timelineEntries: {
      edges: entries.map((node) => ({ node })),
      pageInfo: { hasNextPage: more, endCursor: more ? "m1" : null },
    },
  })

  it("reads the newest threads of a label with their messages, in one request for each page", async () => {
    plain({
      PlainLabelThreads: () => ({
        labelType: { isArchived: false },
        threads: page([
          thread(
            "th_1",
            [
              {
                timestamp: iso("2026-03-01T01:00:00.000Z"),
                llmText: "The export button gives an error.",
                entry: { __typename: "EmailEntry" },
                actor: {
                  __typename: "CustomerActor",
                  customer: { fullName: "Robin Lee" },
                },
              },
              {
                timestamp: iso("2026-03-01T01:30:00.000Z"),
                llmText: null,
                entry: { __typename: "ChatEntry" },
                actor: { __typename: "SystemActor" },
              },
              {
                timestamp: iso("2026-03-01T02:00:00.000Z"),
                llmText: "Looking at the logs.",
                entry: { __typename: "NoteEntry" },
                actor: {
                  __typename: "UserActor",
                  user: { fullName: "Sam Rivera" },
                },
              },
            ],
            true,
          ),
        ]),
      }),
    })
    const threads = await listPlainLabelThreads({
      apiKey: "key",
      labelTypeId: "lt_1",
    })
    expect(operations.map((operation) => operation.variables)).toEqual([
      { labelTypeId: "lt_1", after: null },
    ])
    expect(operations[0]?.query).toContain(
      "sortBy: { field: CREATED_AT, direction: DESC }",
    )
    expect(operations[0]?.query).toContain("MERGED_THREAD_MESSAGE")
    expect(threads).toEqual([
      {
        id: "th_1",
        ref: "T-12",
        title: "Export fails",
        status: "TODO",
        priority: 1,
        customerName: "Robin Lee",
        labels: ["Bug"],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
        // An entry without text is skipped.
        messages: [
          {
            authorName: "Robin Lee",
            createdAt: "2026-03-01T01:00:00.000Z",
            internal: false,
            text: "The export button gives an error.",
          },
          {
            authorName: "Sam Rivera",
            createdAt: "2026-03-01T02:00:00.000Z",
            internal: true,
            text: "Looking at the logs.",
          },
        ],
        // The thread has more messages than one page: the file says so.
        moreMessages: true,
      },
    ])
  })

  it("refuses a thread id that is not a Plain id, because the id is a path segment", async () => {
    plain({
      PlainLabelThreads: () => ({
        labelType: { isArchived: false },
        threads: page([thread("th_1/../../../knowledge/owner", [])]),
      }),
    })
    await expect(
      listPlainLabelThreads({ apiKey: "key", labelTypeId: "lt_1" }),
    ).rejects.toThrow()
  })

  it("stops at 100 threads", async () => {
    let next = 0
    plain({
      PlainLabelThreads: () => {
        next += 1
        return {
          labelType: { isArchived: false },
          threads: {
            edges: Array.from({ length: 25 }, (_, n) => ({
              node: thread(`th_${next}_${n}`, []),
            })),
            pageInfo: { hasNextPage: true, endCursor: `c${next}` },
          },
        }
      },
    })
    const threads = await listPlainLabelThreads({
      apiKey: "key",
      labelTypeId: "lt_1",
    })
    expect(threads).toHaveLength(100)
    expect(operations).toHaveLength(4)
  })

  it.each([
    ["a missing label", null],
    ["an archived label", { isArchived: true }],
  ])("gives not_found for %s", async (_name, labelType) => {
    plain({ PlainLabelThreads: () => ({ labelType, threads: page([]) }) })
    expect(
      await listPlainLabelThreads({ apiKey: "key", labelTypeId: "lt_1" }),
    ).toBe("not_found")
  })
})

describe("catalog lists", () => {
  it("lists the Help Centers that are not deleted, and the labels that are not archived", async () => {
    plain({
      PlainHelpCenters: () => ({
        helpCenters: page([
          { id: "hc_1", internalName: "Docs", isDeleted: false },
          { id: "hc_2", internalName: "Old", isDeleted: true },
        ]),
      }),
      PlainLabelTypes: () => ({
        labelTypes: page([{ id: "lt_1", name: "Bug" }]),
      }),
    })
    expect(await listPlainHelpCenters("key")).toEqual([
      { id: "hc_1", name: "Docs" },
    ])
    expect(await listPlainLabelTypes("key")).toEqual([
      { id: "lt_1", name: "Bug" },
    ])
    expect(operations[1]?.query).toContain("filters: { isArchived: false }")
  })
})

describe("readPages", () => {
  it("stops when Plain gives the same cursor again", async () => {
    plain({
      PlainHelpCenters: () => ({
        helpCenters: {
          edges: [],
          pageInfo: { hasNextPage: true, endCursor: "same" },
        },
      }),
    })
    await expect(listPlainHelpCenters("key")).rejects.toThrow(
      "Plain gave the same page cursor two times",
    )
    expect(operations).toHaveLength(2)
  })
})

describe("plainRequest", () => {
  it("waits for Retry-After on a rate limit and sends the request again", async () => {
    vi.useFakeTimers()
    let calls = 0
    plain({
      PlainHelpCenters: () => {
        calls += 1
        return calls === 1
          ? new HttpResponse(null, {
              status: 429,
              headers: { "retry-after": "2" },
            })
          : { helpCenters: page([]) }
      },
    })
    const listed = listPlainHelpCenters("key")
    await vi.advanceTimersByTimeAsync(2000)
    expect(await listed).toEqual([])
    expect(calls).toBe(2)
  })

  it("stops the read of an answer above 32 MiB", async () => {
    const MiB = 1024 * 1024
    let pulledBytes = 0
    server.use(
      http.post(API, () => {
        let left = 64
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (left-- === 0) return controller.close()
            pulledBytes += MiB
            controller.enqueue(new Uint8Array(MiB).fill(0x20))
          },
        })
        return new HttpResponse(body, {
          headers: { "content-type": "application/json" },
        })
      }),
    )
    await expect(listPlainHelpCenters("key")).rejects.toThrow(/larger than/)
    expect(pulledBytes).toBeLessThan(40 * MiB)
  })

  it("sends every request with redirect set to error, so the API key goes to one URL", async () => {
    const redirects: string[] = []
    server.use(
      http.post(API, ({ request }) => {
        redirects.push(request.redirect)
        return HttpResponse.json({ data: { helpCenters: page([]) } })
      }),
    )
    await listPlainHelpCenters("key")
    expect(redirects).toEqual(["error"])
  })

  it("retries an admin request one time on a rate limit, and waits at most 5 seconds", async () => {
    vi.useFakeTimers()
    let calls = 0
    plain({
      PlainHelpCenters: () => {
        calls += 1
        return new HttpResponse(null, {
          status: 429,
          headers: { "retry-after": "60" },
        })
      },
    })
    const listed = listPlainHelpCenters("key")
    const outcome = expect(listed).rejects.toThrow(
      "Plain PlainHelpCenters failed (429)",
    )
    await vi.advanceTimersByTimeAsync(5000)
    await outcome
    expect(calls).toBe(2)
  })

  it("keeps the longer retries for a background sync", async () => {
    vi.useFakeTimers()
    let calls = 0
    plain({
      PlainHelpCenterArticles: () => {
        calls += 1
        return new HttpResponse(null, {
          status: 429,
          headers: { "retry-after": "60" },
        })
      },
    })
    const listed = listPlainHelpCenterArticles({
      apiKey: "key",
      helpCenterId: "hc_1",
    })
    const outcome = expect(listed).rejects.toThrow("failed (429)")
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    await outcome
    expect(calls).toBe(5)
  })

  it.each([
    ["a 401", () => new HttpResponse(null, { status: 401 })],
    [
      "a FORBIDDEN error",
      () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: "No", extensions: { code: "FORBIDDEN" } }],
        }),
    ],
  ])("throws a typed error for %s", async (_name, answer) => {
    plain({ PlainHelpCenters: answer })
    await expect(listPlainHelpCenters("key")).rejects.toBeInstanceOf(
      PlainUnauthorizedError,
    )
  })

  it("throws on another GraphQL error", async () => {
    plain({
      PlainHelpCenters: () =>
        HttpResponse.json({
          errors: [
            { message: "Boom", extensions: { code: "INTERNAL_SERVER_ERROR" } },
          ],
        }),
    })
    await expect(listPlainHelpCenters("key")).rejects.toThrow(
      "Plain PlainHelpCenters failed: Boom",
    )
  })
})

describe("text that goes into a heading", () => {
  const entry = {
    timestamp: iso("2026-03-01T01:00:00.000Z"),
    llmText: "Hello",
    entry: { __typename: "EmailEntry" },
    actor: { __typename: "SystemActor" },
  }
  const base = {
    id: "th_1",
    ref: "T-12",
    title: "Export fails",
    status: "TODO",
    priority: 1,
    createdAt: iso("2026-03-01T00:00:00.000Z"),
    updatedAt: iso("2026-03-02T00:00:00.000Z"),
    customer: null,
    labels: [],
    timelineEntries: page([entry]),
  }
  const read = (thread: Record<string, unknown>) => {
    plain({
      PlainLabelThreads: () => ({
        labelType: { isArchived: false },
        threads: page([{ ...base, ...thread }]),
      }),
    })
    return listPlainLabelThreads({ apiKey: "key", labelTypeId: "lt_1" })
  }

  it.each([
    ["a ref with a line break", { ref: "T-1\n# Injected" }],
    ["a ref with a space", { ref: "T 1" }],
    ["a status with a line break", { status: "TODO\n# Injected" }],
    ["a status with a digit", { status: "TODO2" }],
    [
      "a thread time that is not ISO 8601",
      { createdAt: iso("2026-03-01\n# Injected") },
    ],
    [
      "a message time that is not ISO 8601",
      { timelineEntries: page([{ ...entry, timestamp: iso("yesterday") }]) },
    ],
  ])("refuses %s", async (_name, thread) => {
    await expect(read(thread)).rejects.toThrow()
  })

  it("accepts a time zone offset and a status with an underscore", async () => {
    const [thread] = (await read({
      status: "IN_PROGRESS",
      createdAt: iso("2026-03-01T10:00:00+10:00"),
    })) as Array<{ status: string; createdAt: string }>
    expect(thread).toMatchObject({
      status: "IN_PROGRESS",
      createdAt: "2026-03-01T10:00:00+10:00",
    })
  })
})

describe("createPlainWebhookTarget", () => {
  it("subscribes one target to timeline events, with the token in a header", async () => {
    plain({
      PlainCreateWebhookTarget: () => ({
        createWebhookTarget: { webhookTarget: { id: "wht_1" }, error: null },
      }),
    })
    expect(
      await createPlainWebhookTarget({
        apiKey: "key",
        url: "https://ctx.example.com/api/v1/webhook/plain/con_1",
        token: "secret-token",
      }),
    ).toBe("wht_1")
    expect(operations[0]?.variables).toEqual({
      input: {
        url: "https://ctx.example.com/api/v1/webhook/plain/con_1",
        description: "ctx| Workspace sources",
        isEnabled: true,
        version: "2026-10-06",
        eventSubscriptions: [{ eventType: "timeline.timeline_entry_changed" }],
        headers: [{ name: "X-Ctxpipe-Webhook-Token", value: "secret-token" }],
      },
    })
  })

  it("throws Plain's message when Plain refuses the target", async () => {
    plain({
      PlainCreateWebhookTarget: () => ({
        createWebhookTarget: {
          webhookTarget: null,
          error: { message: "Too many webhook targets" },
        },
      }),
    })
    await expect(
      createPlainWebhookTarget({ apiKey: "key", url: "https://x", token: "t" }),
    ).rejects.toThrow(
      "Plain refused the webhook target: Too many webhook targets",
    )
  })
})
