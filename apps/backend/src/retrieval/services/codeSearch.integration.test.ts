import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest"
import { describeWithDatabase } from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { generateObjectId } from "../../lib/id.js"
import { codeSearch } from "./codeSearch.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const events: Record<string, unknown>[] = []

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const orgId = generateObjectId("org")
const repositoryId = generateObjectId("repo")
const repositoryName = `acme/search-${suffix}`

describeWithDatabase("codeSearch (Postgres)", () => {
  let zoektRepoId = 0

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) return
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
      silent: true,
      drain: async (ctx) => {
        const batch = Array.isArray(ctx) ? ctx : [ctx]
        for (const item of batch) {
          events.push(item.event as Record<string, unknown>)
        }
      },
    })
    initDb(databaseUrl)
    const db = getSystemDb()
    await db.insert(organizations).values({
      id: orgId,
      name: `Code search ${suffix}`,
      slug: `code-search-${suffix}`,
      createdAt: new Date(),
    })
    await db.insert(repositories).values({
      id: repositoryId,
      orgId,
      name: repositoryName,
      gitUrl: `https://github.com/acme/search-${suffix}.git`,
    })
    const [checkout] = await db
      .insert(repositoryCheckouts)
      .values({
        id: generateObjectId("checkout"),
        repositoryId,
        checkoutKey: "default",
      })
      .returning({ zoektRepoId: repositoryCheckouts.zoektRepoId })
    if (!checkout) throw new Error("checkout insert did not return a row")
    zoektRepoId = checkout.zoektRepoId
  })

  beforeEach(() => {
    events.length = 0
    vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
    if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
      vi.stubEnv(
        "AUTH_SECRET",
        "test-only-auth-secret-with-at-least-32-characters",
      )
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    if (!process.env.DATABASE_URL) return
    const db = getSystemDb()
    await db.delete(repositories).where(eq(repositories.id, repositoryId))
    await db.delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("quotes a rejected query and returns the literal search", async () => {
    const queries: string[] = []
    server.use(
      http.post("http://codesearch.test/search", async ({ request }) => {
        const body = (await request.json()) as { Q: string }
        queries.push(body.Q)
        if (body.Q === "file:((") {
          return HttpResponse.json(
            {
              error: "Zoekt rejected the query: parse error",
              code: "query_rejected",
            },
            { status: 400 },
          )
        }
        return HttpResponse.json({ Files: [{ FileName: "src/a.ts" }] })
      }),
    )

    const results = await codeSearch(orgId, { query: "file:((" })

    expect(queries).toEqual(["file:((", '"file:(("'])
    expect(results).toEqual([
      {
        repositoryId,
        repositoryName,
        zoektRepoId,
        query: '"file:(("',
        response: { Files: [{ FileName: "src/a.ts" }] },
      },
    ])
    expect(
      events.filter((event) => event.step === "advisor.code_search.rejected"),
    ).toEqual([])
  })

  it("returns no code results when the literal query is also rejected", async () => {
    const queries: string[] = []
    server.use(
      http.post("http://codesearch.test/search", async ({ request }) => {
        const body = (await request.json()) as { Q: string }
        queries.push(body.Q)
        const error =
          body.Q === "file:(("
            ? "Zoekt rejected the query: parse error"
            : "Zoekt rejected the query: still invalid"
        return HttpResponse.json(
          { error, code: "query_rejected" },
          { status: 400 },
        )
      }),
    )

    const results = await codeSearch(orgId, { query: "file:((" })

    expect(queries).toEqual(["file:((", '"file:(("'])
    expect(results).toEqual([])
    const rejected = events.filter(
      (event) => event.step === "advisor.code_search.rejected",
    )
    expect(rejected).toEqual([
      expect.objectContaining({
        "upstream.status_code": 400,
        error: "zoekt_query_rejected",
      }),
    ])
    expect(JSON.stringify(rejected)).not.toContain("file:((")
    expect(JSON.stringify(rejected)).not.toContain("Zoekt rejected")
  })

  it("throws when codesearch is unavailable", async () => {
    server.use(
      http.post("http://codesearch.test/search", () =>
        HttpResponse.text("unavailable", { status: 500 }),
      ),
    )

    await expect(codeSearch(orgId, { query: "file:((" })).rejects.toThrow(
      "codesearch failed with status 500",
    )
    expect(
      events.filter((event) => event.step === "advisor.code_search.rejected"),
    ).toEqual([])
  })
})
