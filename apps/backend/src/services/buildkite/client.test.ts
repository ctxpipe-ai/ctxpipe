import { delay, HttpResponse, http } from "msw"
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
  BuildkiteUnauthorizedError,
  getBuildkitePipeline,
  listBuildkiteBuilds,
  listBuildkitePipelines,
  verifyBuildkiteAccess,
} from "./client.js"

const API = "https://api.buildkite.com/v2"
const GRAPHQL = "https://graphql.buildkite.com/v1"
const requests: string[] = []
const server = setupServer()

const job = (n: number, state = "passed") => ({
  type: "script",
  name: `Step ${n}`,
  state,
  web_url: `https://buildkite.com/acme/web-app/builds/2#job-${n}`,
})

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  requests.length = 0
  vi.useRealTimers()
})
afterAll(() => server.close())

describe("listBuildkiteBuilds", () => {
  const read = () =>
    listBuildkiteBuilds({
      apiToken: "token",
      organizationSlug: "acme",
      pipelineSlug: "web-app",
    })

  it("reads the latest finished builds and all their jobs in one request", async () => {
    server.use(
      http.get(`${API}/organizations/acme/pipelines/web-app/builds`, (c) => {
        requests.push(c.request.url)
        expect(c.request.headers.get("authorization")).toBe("Bearer token")
        return HttpResponse.json([
          {
            id: "b2",
            number: 2,
            web_url: "u2",
            state: "failed",
            creator: { name: "Sam Rivera", email: "not-mirrored@example.com" },
            pull_request: {
              id: "17",
              repository: "git@github.com:fork/web-app.git",
            },
            env: { DEPLOY_TOKEN: "not-mirrored" },
            jobs: [job(1, "failed"), job(2), job(3), { type: "waiter" }],
          },
          { id: "b1", number: 1, web_url: "u1", state: "passed", jobs: [] },
        ])
      }),
    )

    const builds = await read()

    expect(requests).toEqual([
      `${API}/organizations/acme/pipelines/web-app/builds?state=finished&per_page=25`,
    ])
    expect(builds.map((build) => build.jobs.length)).toEqual([4, 0])
    expect(builds[0]).toMatchObject({
      creatorName: "Sam Rivera",
      pullRequestNumber: "17",
    })
    expect(JSON.stringify(builds)).not.toContain("not-mirrored")
  })

  it("waits for the rate limit reset and sends the same request again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    server.use(
      http.get(`${API}/organizations/acme/pipelines/web-app/builds`, () => {
        requests.push("builds")
        return requests.length === 1
          ? HttpResponse.json(
              { message: "Too many requests" },
              { status: 429, headers: { "RateLimit-Reset": "7" } },
            )
          : HttpResponse.json([])
      }),
    )

    const builds = read()
    await vi.advanceTimersByTimeAsync(6_999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(await builds).toEqual([])
    expect(requests).toHaveLength(2)
  })

  it("aborts a request that Buildkite does not answer in the timeout", async () => {
    // Fake timers do not reach `AbortSignal.timeout`, so the test gives a
    // short timeout. Without the signal, the request never ends.
    server.use(
      http.get(`${API}/organizations/acme/pipelines/web-app/builds`, () =>
        delay("infinite"),
      ),
    )

    await expect(
      listBuildkiteBuilds({
        apiToken: "token",
        organizationSlug: "acme",
        pipelineSlug: "web-app",
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
  }, 5_000)

  it("throws a typed error when Buildkite refuses the token", async () => {
    server.use(
      http.get(`${API}/organizations/acme/pipelines/web-app/builds`, () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    )
    await expect(read()).rejects.toBeInstanceOf(BuildkiteUnauthorizedError)
  })
})

describe("verifyBuildkiteAccess", () => {
  const verify = () =>
    verifyBuildkiteAccess({ apiToken: "token", organizationSlug: "acme" })
  const token = (scopes: string[]) =>
    http.get(`${API}/access-token`, () => HttpResponse.json({ scopes }))
  // Buildkite refuses a GraphQL request when the token has no GraphQL access.
  const graphqlDisabled = (status = 401) =>
    http.post(GRAPHQL, () =>
      HttpResponse.json(
        { errors: [{ message: "GraphQL API access is not enabled" }] },
        { status },
      ),
    )
  const pipelines = () =>
    http.get(`${API}/organizations/acme/pipelines`, ({ request }) => {
      requests.push(new URL(request.url).search)
      return HttpResponse.json([{ slug: "web-app", name: "Web App" }])
    })

  it("accepts a token with the read scopes that lists the pipelines", async () => {
    server.use(
      token(["read_pipelines", "read_builds"]),
      graphqlDisabled(),
      pipelines(),
    )
    expect(await verify()).toEqual({ ok: true })
    // One pipeline is enough to prove access to the organization.
    expect(requests).toEqual(["?per_page=1"])
  })

  it.each([401, 403])(
    "accepts a token for which GraphQL answers %s (GraphQL access off)",
    async (status) => {
      server.use(
        token(["read_pipelines", "read_builds"]),
        graphqlDisabled(status),
        pipelines(),
      )
      expect(await verify()).toEqual({ ok: true })
    },
  )

  it("refuses a token with GraphQL access, which the REST scopes do not show", async () => {
    const queries: unknown[] = []
    server.use(
      token(["read_pipelines", "read_builds"]),
      http.post(GRAPHQL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer token")
        queries.push(await request.json())
        return HttpResponse.json({ data: { viewer: { id: "VXNlci0t" } } })
      }),
      pipelines(),
    )
    expect(await verify()).toEqual({
      ok: false,
      error:
        "The token has GraphQL API access. Edit the token in Buildkite and turn off GraphQL API access. The connector only reads.",
    })
    expect(queries).toEqual([{ query: "{ viewer { id } }" }])
    expect(requests).toEqual([])
  })

  it.each([
    ["a server error", () => new HttpResponse(null, { status: 500 })],
    ["a rate limit", () => new HttpResponse(null, { status: 429 })],
    ["a network error", () => HttpResponse.error()],
    [
      "a redirect",
      () => HttpResponse.redirect("https://elsewhere.example/graphql", 307),
    ],
  ])(
    "refuses the token when the GraphQL check gives %s",
    async (_name, answer) => {
      server.use(
        token(["read_pipelines", "read_builds"]),
        http.post(GRAPHQL, answer),
        pipelines(),
      )
      expect(await verify()).toEqual({
        ok: false,
        error:
          "ctxpipe cannot make sure that the token has no GraphQL API access. Try again later.",
      })
      expect(requests).toEqual([])
    },
  )

  it("accepts a 403 with the Buildkite message shape", async () => {
    server.use(
      token(["read_pipelines", "read_builds"]),
      http.post(GRAPHQL, () =>
        HttpResponse.json({ message: "Forbidden" }, { status: 403 }),
      ),
      pipelines(),
    )
    expect(await verify()).toEqual({ ok: true })
  })

  // A proxy or a firewall in front of Buildkite can also answer 401 or 403.
  it.each([
    [
      "an HTML 403",
      () =>
        new HttpResponse("<html><body>Blocked</body></html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    ],
    ["an empty 403", () => new HttpResponse(null, { status: 403 })],
    [
      "a 401 with other JSON",
      () => HttpResponse.json({ blocked: true }, { status: 401 }),
    ],
    [
      "a 403 above the size limit",
      () =>
        HttpResponse.json(
          { message: "x".repeat(1024 * 1024) },
          { status: 403 },
        ),
    ],
  ])(
    "refuses the token when the GraphQL check gives %s",
    async (_name, answer) => {
      server.use(
        token(["read_pipelines", "read_builds"]),
        http.post(GRAPHQL, answer),
        pipelines(),
      )
      expect(await verify()).toEqual({
        ok: false,
        error:
          "ctxpipe cannot make sure that the token has no GraphQL API access. Try again later.",
      })
      expect(requests).toEqual([])
    },
  )

  it("names the missing scopes", async () => {
    server.use(token(["read_pipelines"]))
    expect(await verify()).toEqual({
      ok: false,
      error: "Give the token these scopes: read_builds.",
    })
  })

  it("refuses a token with a write scope", async () => {
    server.use(token(["read_pipelines", "read_builds", "write_builds"]))
    expect(await verify()).toEqual({
      ok: false,
      error:
        "Remove the write scopes from the token: write_builds. The connector only reads.",
    })
  })

  it.each([
    "read_user",
    "read_organizations",
    "read_artifacts",
    "read_suites",
    "read_agents",
    "read_clusters",
    "read_teams",
    "graphql",
  ])("refuses a token that also has %s", async (extra) => {
    server.use(token(["read_pipelines", "read_builds", extra]))
    expect(await verify()).toEqual({
      ok: false,
      error: `Remove these scopes from the token: ${extra}. Use only read_pipelines and read_builds.`,
    })
  })

  it("refuses a token with a read scope outside the allowlist", async () => {
    server.use(token(["read_pipelines", "read_builds", "read_job_env"]))
    expect(await verify()).toEqual({
      ok: false,
      error:
        "Remove these scopes from the token: read_job_env. Use only read_pipelines and read_builds.",
    })
  })

  it("refuses a token that Buildkite does not accept", async () => {
    server.use(
      http.get(`${API}/access-token`, () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    )
    expect(await verify()).toEqual({
      ok: false,
      error: "Buildkite does not accept this API access token.",
    })
  })

  it("refuses an organization that the token cannot read", async () => {
    server.use(
      token(["read_pipelines", "read_builds"]),
      graphqlDisabled(),
      http.get(`${API}/organizations/acme/pipelines`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    )
    expect(await verify()).toMatchObject({
      ok: false,
      error: expect.stringContaining('"acme"'),
    })
  })
})

describe("rate limits in a browser request", () => {
  it("stops the wait of the pipeline picker after 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    server.use(
      http.get(`${API}/organizations/acme/pipelines`, () => {
        requests.push("pipelines")
        return HttpResponse.json(
          { message: "Too many requests" },
          { status: 429, headers: { "RateLimit-Reset": "6" } },
        )
      }),
    )

    const listed = listBuildkitePipelines({
      apiToken: "token",
      organizationSlug: "acme",
    })
    const failed = expect(listed).rejects.toThrow("failed (429)")
    // One wait of 6 s fits in the limit. A second wait of 6 s does not.
    await vi.advanceTimersByTimeAsync(6_000)

    await failed
    expect(requests).toEqual(["pipelines", "pipelines"])
  })

  it("stops the wait of the connect check after 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    server.use(
      http.get(`${API}/access-token`, () => {
        requests.push("token")
        return HttpResponse.json(
          { message: "Too many requests" },
          { status: 429, headers: { "RateLimit-Reset": "11" } },
        )
      }),
    )

    // The first wait of 11 s is over the limit, so there is no wait at all.
    await expect(
      verifyBuildkiteAccess({ apiToken: "token", organizationSlug: "acme" }),
    ).rejects.toThrow("failed (429)")
    expect(requests).toEqual(["token"])
  })
})

describe("listBuildkitePipelines", () => {
  it("reads the next page while Buildkite links one", async () => {
    server.use(
      http.get(`${API}/organizations/acme/pipelines`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page")
        requests.push(page ?? "")
        return page === "1"
          ? HttpResponse.json([{ slug: "a", name: "A" }], {
              headers: {
                Link: `<${API}/organizations/acme/pipelines?page=2&per_page=100>; rel="next"`,
              },
            })
          : HttpResponse.json([{ slug: "b", name: "B" }])
      }),
    )

    expect(
      await listBuildkitePipelines({
        apiToken: "token",
        organizationSlug: "acme",
      }),
    ).toEqual({
      pipelines: [
        { slug: "a", name: "A" },
        { slug: "b", name: "B" },
      ],
      truncated: false,
    })
    expect(requests).toEqual(["1", "2"])
  })
})

describe("getBuildkitePipeline", () => {
  const read = () =>
    getBuildkitePipeline({
      apiToken: "token",
      organizationSlug: "acme",
      pipelineSlug: "web-app",
    })
  const pipelineJson = (slug: string) => ({
    id: "p1",
    slug,
    name: "Web App",
    web_url: "https://buildkite.com/acme/web-app",
    repository: null,
    default_branch: "main",
  })

  it("keeps the slug of the scope, not the slug in the answer", async () => {
    server.use(
      http.get(`${API}/organizations/acme/pipelines/web-app`, () =>
        HttpResponse.json(pipelineJson("../../sources/github/x")),
      ),
    )
    expect(await read()).toMatchObject({ slug: "web-app", name: "Web App" })
  })

  it("does not follow a redirect away from the Buildkite API", async () => {
    const elsewhere: string[] = []
    server.use(
      http.get(`${API}/organizations/acme/pipelines/web-app`, () =>
        HttpResponse.redirect("https://elsewhere.example/pipeline", 302),
      ),
      http.get("https://elsewhere.example/pipeline", ({ request }) => {
        elsewhere.push(request.headers.get("authorization") ?? "")
        return HttpResponse.json(pipelineJson("web-app"))
      }),
    )
    await expect(read()).rejects.toThrow()
    expect(elsewhere).toEqual([])
  })

  it("stops the read of an answer above 32 MiB", async () => {
    const MiB = 1024 * 1024
    let pulledBytes = 0
    server.use(
      http.get(`${API}/organizations/acme/pipelines/web-app`, () => {
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
    await expect(read()).rejects.toThrow(/larger than/)
    expect(pulledBytes).toBeLessThan(40 * MiB)
  })
})
