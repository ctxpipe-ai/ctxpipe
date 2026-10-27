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

import {
  createZendeskArticleWebhook,
  listZendeskCategoryArticles,
  listZendeskViewTickets,
  revokeZendeskAccessToken,
} from "./client.js"
import { ZendeskAuthorizationRevokedError } from "./oauth.js"

const API = "https://acme.zendesk.com/api/v2"
const ctx = { subdomain: "acme", accessToken: "token" }
const requests: string[] = []
const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  requests.length = 0
  vi.useRealTimers()
})
afterAll(() => server.close())

const record = (request: Request) => {
  const url = new URL(request.url)
  requests.push(url.pathname + url.search)
  expect(request.headers.get("authorization")).toBe("Bearer token")
}

describe("listZendeskCategoryArticles", () => {
  it("reads every page with section and author names, and skips drafts", async () => {
    server.use(
      http.get(`${API}/help_center/categories/36/articles`, ({ request }) => {
        record(request)
        const second = new URL(request.url).searchParams.get("page[after]")
        return HttpResponse.json(
          second
            ? {
                articles: [
                  {
                    id: 3,
                    title: "C",
                    body: "<p>c</p>",
                    html_url: "u3",
                    section_id: 7,
                    author_id: 9,
                    draft: false,
                  },
                ],
                users: [{ id: 9, name: "Sam Rivera" }],
                sections: [{ id: 7, name: "Accounts" }],
                meta: { has_more: false },
              }
            : {
                articles: [
                  {
                    id: 1,
                    title: "A",
                    body: "<p>a</p>",
                    html_url: "u1",
                    section_id: 7,
                    author_id: 9,
                    draft: false,
                    label_names: ["x"],
                    locale: "en-us",
                  },
                  {
                    id: 2,
                    title: "Draft",
                    body: "<p>d</p>",
                    html_url: "u2",
                    section_id: 7,
                    draft: true,
                  },
                ],
                users: [{ id: 9, name: "Sam Rivera" }],
                sections: [{ id: 7, name: "Accounts" }],
                meta: { has_more: true },
                links: {
                  next: `${API}/help_center/categories/36/articles?page[after]=abc`,
                },
              },
        )
      }),
    )

    const articles = await listZendeskCategoryArticles({
      ...ctx,
      categoryId: "36",
    })

    expect(articles).toMatchObject([
      {
        id: "1",
        sectionName: "Accounts",
        authorName: "Sam Rivera",
        labels: ["x"],
      },
      { id: "3", sectionName: "Accounts", authorName: "Sam Rivera" },
    ])
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain("include=users%2Csections")
  })

  it("does not follow a next page on another host", async () => {
    server.use(
      http.get(`${API}/help_center/categories/36/articles`, () =>
        HttpResponse.json({
          articles: [],
          meta: { has_more: true },
          links: { next: "https://attacker.example/steal" },
        }),
      ),
    )
    await expect(
      listZendeskCategoryArticles({ ...ctx, categoryId: "36" }),
    ).rejects.toThrow(/another host/)
  })

  it("does not follow a redirect to another host with the token", async () => {
    const stolen: string[] = []
    server.use(
      http.get(
        `${API}/help_center/categories/36/articles`,
        () =>
          new HttpResponse(null, {
            status: 307,
            headers: { location: "https://attacker.example/steal" },
          }),
      ),
      http.get("https://attacker.example/steal", ({ request }) => {
        stolen.push(request.headers.get("authorization") ?? "")
        return HttpResponse.json({ articles: [] })
      }),
    )
    await expect(
      listZendeskCategoryArticles({ ...ctx, categoryId: "36" }),
    ).rejects.toSatisfy(
      // The fetch refuses the redirect itself; it does not send a second
      // request that fails later.
      (error) => String((error as Error).cause).includes("unexpected redirect"),
    )
    expect(stolen).toEqual([])
  })

  it("gives not_found for a deleted category", async () => {
    server.use(
      http.get(`${API}/help_center/categories/36/articles`, () =>
        HttpResponse.json({ error: "RecordNotFound" }, { status: 404 }),
      ),
    )
    expect(
      await listZendeskCategoryArticles({ ...ctx, categoryId: "36" }),
    ).toBe("not_found")
  })

  it("stops the read of an answer above 32 MiB", async () => {
    const MiB = 1024 * 1024
    let pulledBytes = 0
    server.use(
      http.get(`${API}/help_center/categories/36/articles`, () => {
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
    await expect(
      listZendeskCategoryArticles({ ...ctx, categoryId: "36" }),
    ).rejects.toThrow(/larger than/)
    expect(pulledBytes).toBeLessThan(40 * MiB)
  })

  it("waits for Retry-After on a rate limit and sends the request again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    server.use(
      http.get(`${API}/help_center/categories/36/articles`, ({ request }) => {
        record(request)
        return requests.length === 1
          ? HttpResponse.json(
              {},
              { status: 429, headers: { "Retry-After": "3" } },
            )
          : HttpResponse.json({ articles: [], meta: { has_more: false } })
      }),
    )
    const read = listZendeskCategoryArticles({ ...ctx, categoryId: "36" })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await read).toEqual([])
    expect(requests).toHaveLength(2)
  })

  it("throws a typed error when Zendesk refuses the token", async () => {
    server.use(
      http.get(`${API}/help_center/categories/36/articles`, () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    )
    await expect(
      listZendeskCategoryArticles({ ...ctx, categoryId: "36" }),
    ).rejects.toBeInstanceOf(ZendeskAuthorizationRevokedError)
  })
})

describe("listZendeskViewTickets", () => {
  it("reads the latest tickets, and the comments of each ticket with their authors", async () => {
    server.use(
      http.get(`${API}/views/90/tickets`, ({ request }) => {
        record(request)
        return HttpResponse.json({
          tickets: [
            {
              id: 11,
              subject: "S1",
              status: "open",
              priority: "high",
              type: "problem",
              tags: ["a"],
              requester_id: 1,
              assignee_id: 2,
              created_at: "c",
              updated_at: "u",
            },
            {
              id: 12,
              subject: "S2",
              status: "pending",
              requester_id: 3,
              assignee_id: null,
              tags: [],
            },
          ],
        })
      }),
      http.get(`${API}/tickets/:id/comments`, ({ request, params }) => {
        record(request)
        return HttpResponse.json({
          comments: [
            {
              id: 100,
              author_id: 1,
              plain_body: `Body ${params.id}`,
              public: true,
              created_at: "t",
              attachments: [
                {
                  file_name: "a.log",
                  content_url:
                    "https://acme.zendesk.com/attachments/token/secret/?name=a.log",
                },
              ],
            },
            {
              id: 101,
              author_id: 2,
              plain_body: "Note",
              public: false,
              created_at: "t2",
              attachments: [],
            },
          ],
          users: [
            { id: 1, name: "Alex Kim" },
            { id: 2, name: "Sam Rivera" },
          ],
          meta: { has_more: false },
        })
      }),
    )

    const tickets = await listZendeskViewTickets({ ...ctx, viewId: "90" })

    expect(requests.map((path) => path.split("?")[0])).toEqual([
      "/api/v2/views/90/tickets",
      "/api/v2/tickets/11/comments",
      "/api/v2/tickets/12/comments",
    ])
    expect(requests[0]).toContain(
      "sort_by=updated&sort_order=desc&per_page=100",
    )
    expect(tickets).toMatchObject([
      {
        id: "11",
        url: "https://acme.zendesk.com/agent/tickets/11",
        requesterName: "Alex Kim",
        assigneeName: "Sam Rivera",
        comments: [
          {
            authorName: "Alex Kim",
            body: "Body 11",
            public: true,
            attachments: ["a.log"],
          },
          {
            authorName: "Sam Rivera",
            body: "Note",
            public: false,
            attachments: [],
          },
        ],
      },
      // A requester who never commented has no name in the comment sideload.
      { id: "12", requesterName: null, assigneeName: null },
    ])
    expect(JSON.stringify(tickets)).not.toContain("not-mirrored")
    expect(JSON.stringify(tickets)).not.toContain("secret")
  })

  it("skips a ticket whose id is not a number, and sends no request for it", async () => {
    server.use(
      http.get(`${API}/views/90/tickets`, ({ request }) => {
        record(request)
        return HttpResponse.json({
          tickets: [
            { id: "1/../../users", status: "open" },
            { id: 13, status: "open" },
          ],
        })
      }),
      http.get(`${API}/tickets/:id/comments`, ({ request }) => {
        record(request)
        return HttpResponse.json({ comments: [], meta: { has_more: false } })
      }),
    )

    const tickets = await listZendeskViewTickets({ ...ctx, viewId: "90" })

    expect(requests.map((path) => path.split("?")[0])).toEqual([
      "/api/v2/views/90/tickets",
      "/api/v2/tickets/13/comments",
    ])
    expect(tickets).toMatchObject([{ id: "13" }])
  })

  it("stops at 10 pages of comments for one ticket, and marks the ticket as cut", async () => {
    let commentRequests = 0
    server.use(
      http.get(`${API}/views/90/tickets`, () =>
        HttpResponse.json({ tickets: [{ id: 14, status: "open" }] }),
      ),
      http.get(`${API}/tickets/14/comments`, () => {
        commentRequests += 1
        return HttpResponse.json({
          comments: [{ id: commentRequests, public: true, plain_body: "hi" }],
          meta: { has_more: true },
          links: { next: `${API}/tickets/14/comments?page[after]=x` },
        })
      }),
    )

    const tickets = await listZendeskViewTickets({ ...ctx, viewId: "90" })

    expect(commentRequests).toBe(10)
    if (typeof tickets === "string") throw new Error(tickets)
    expect(tickets).toHaveLength(1)
    const comments = tickets[0]?.comments ?? []
    expect(comments).toHaveLength(11)
    expect(comments.at(-1)?.body).toBe("[More comments in Zendesk.]")
  })
})

describe("createZendeskArticleWebhook", () => {
  it("subscribes one webhook to article events and reads its signing secret", async () => {
    const bodies: unknown[] = []
    server.use(
      http.post(`${API}/webhooks`, async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ webhook: { id: "01WH" } }, { status: 201 })
      }),
      http.get(`${API}/webhooks/01WH/signing_secret`, () =>
        HttpResponse.json({
          signing_secret: { secret: "s3cret", algorithm: "SHA256" },
        }),
      ),
    )

    expect(
      await createZendeskArticleWebhook({
        ...ctx,
        endpoint: "https://app.example.com/api/v1/webhook/zendesk/con_1",
      }),
    ).toEqual({ webhookId: "01WH", signingSecret: "s3cret" })
    expect(bodies).toEqual([
      {
        webhook: {
          name: "ctxpipe Help Center sync",
          endpoint: "https://app.example.com/api/v1/webhook/zendesk/con_1",
          http_method: "POST",
          request_format: "json",
          status: "active",
          subscriptions: [
            "zen:event-type:article.published",
            "zen:event-type:article.unpublished",
          ],
        },
      },
    ])
  })

  it("refuses a webhook id that is not letters and digits, and sends no request with it", async () => {
    server.use(
      http.post(`${API}/webhooks`, ({ request }) => {
        record(request)
        return HttpResponse.json(
          { webhook: { id: "1/../../users" } },
          { status: 201 },
        )
      }),
    )

    await expect(
      createZendeskArticleWebhook({
        ...ctx,
        endpoint: "https://app.example.com/api/v1/webhook/zendesk/con_1",
      }),
    ).rejects.toThrow("webhook id that is not valid")
    expect(requests).toEqual(["/api/v2/webhooks"])
  })
})

describe("revokeZendeskAccessToken", () => {
  it("revokes the token that sends the request", async () => {
    server.use(
      http.delete(`${API}/oauth/tokens/current`, ({ request }) => {
        record(request)
        return new HttpResponse(null, { status: 204 })
      }),
    )

    await revokeZendeskAccessToken(ctx)

    expect(requests).toEqual(["/api/v2/oauth/tokens/current"])
  })

  it("is a success when the token is already invalid", async () => {
    server.use(
      http.delete(
        `${API}/oauth/tokens/current`,
        () => new HttpResponse(null, { status: 401 }),
      ),
    )

    await expect(revokeZendeskAccessToken(ctx)).resolves.toBeUndefined()
  })

  it("throws when Zendesk fails", async () => {
    server.use(
      http.delete(
        `${API}/oauth/tokens/current`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    )

    await expect(revokeZendeskAccessToken(ctx)).rejects.toThrow(
      "Zendesk token revoke failed (500)",
    )
  })
})
