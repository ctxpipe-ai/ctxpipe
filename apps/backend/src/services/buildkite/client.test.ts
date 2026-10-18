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

  it("aborts a request that Buildkite does not answer in 15 seconds", async () => {
    // Fake timers do not reach `AbortSignal.timeout`, so this waits in real time.
    server.use(
      http.get(`${API}/organizations/acme/pipelines/web-app/builds`, () =>
        delay("infinite"),
      ),
    )

    const startedAt = Date.now()
    await expect(read()).rejects.toMatchObject({ name: "TimeoutError" })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(14_900)
  }, 20_000)

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

  it("accepts a token with the read scopes that lists the pipelines", async () => {
    server.use(
      token(["read_pipelines", "read_builds", "read_organizations"]),
      http.get(`${API}/organizations/acme/pipelines`, ({ request }) => {
        requests.push(new URL(request.url).search)
        return HttpResponse.json([{ slug: "web-app", name: "Web App" }])
      }),
    )
    expect(await verify()).toEqual({ ok: true })
    // One pipeline is enough to prove access to the organization.
    expect(requests).toEqual(["?per_page=1"])
  })

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
})
