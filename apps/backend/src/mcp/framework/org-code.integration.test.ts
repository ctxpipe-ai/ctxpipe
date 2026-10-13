import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { useMswServer } from "../../../test/msw.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  findSymbolAcrossRepositories,
  resolveCodeScope,
  SCIP_FAN_OUT_LIMIT,
  searchCodeText,
  structuralSearchAcrossRepositories,
} from "./org-code.js"
import { McpToolError } from "./tool-errors.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const CODESEARCH = "http://codesearch.test"

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = { id: generateObjectId("org"), slug: `org-code-${suffix}` }
const paymentsId = generateObjectId("ws")
const ledgerId = generateObjectId("ws")
const wideId = generateObjectId("ws")

/** Repository name → repository id and Zoekt repo id (after the seed). */
const seeded = new Map<string, { id: string; zoektRepoId: number }>()
const owner = `ex${suffix}`
const name = (short: string) => `${owner}/${short}`
const WIDE = Array.from(
  { length: 12 },
  (_, index) => `wide-${String(index).padStart(2, "0")}`,
)

type Captured = { path: string; body: Record<string, unknown> }
let captured: Captured[] = []

function repositoryOf(id: string): string {
  for (const [repository, row] of seeded) if (row.id === id) return repository
  throw new Error(`unknown repository id ${id}`)
}

/** Codesearch with request capture. `failing` names repositories that answer 500. */
function codesearch(options: {
  failing?: string[]
  delayMs?: (repository: string) => number
  results?: number
  onFlight?: (delta: 1 | -1) => void
}) {
  const answer = async (
    request: Request,
    repoId: string,
    build: (repository: string) => Record<string, unknown>,
  ) => {
    const body = (await request.json()) as Record<string, unknown>
    captured.push({ path: new URL(request.url).pathname, body })
    const repository = repositoryOf(repoId)
    options.onFlight?.(1)
    try {
      await new Promise((resolve) =>
        setTimeout(resolve, options.delayMs?.(repository) ?? 0),
      )
      if (options.failing?.includes(repository)) {
        return HttpResponse.json(
          { error: "scip index broken" },
          { status: 500 },
        )
      }
      return HttpResponse.json(build(repository))
    } finally {
      options.onFlight?.(-1)
    }
  }
  const count = options.results ?? 2
  return [
    http.post(`${CODESEARCH}/:repoId/graph`, ({ request, params }) =>
      answer(request, String(params.repoId), (repository) => ({
        ok: true,
        primitive: "find_symbol",
        results: Array.from({ length: count }, (_, rank) => ({
          symbol: `${repository}#${rank}`,
          filePath: `src/${rank}.ts`,
        })),
      })),
    ),
    http.post(
      `${CODESEARCH}/:repoId/structural-search`,
      ({ request, params }) =>
        answer(request, String(params.repoId), (repository) => ({
          matches: Array.from({ length: count }, (_, rank) => ({
            file: `src/${rank}.ts`,
            text: `${repository}#${rank}`,
          })),
        })),
    ),
    http.post(`${CODESEARCH}/search`, async ({ request }) => {
      const body = (await request.json()) as { RepoIDs: number[] }
      captured.push({ path: "/search", body })
      return HttpResponse.json({
        Result: {
          Files: body.RepoIDs.map((zoektRepoId) => ({
            FileName: "src/index.ts",
            RepositoryID: zoektRepoId,
            Score: 1,
            LineMatches: [
              {
                LineNumber: 3,
                Line: Buffer.from("const charge = 1").toString("base64"),
              },
            ],
          })),
        },
      })
    }),
  ]
}

/** Every repository id and Zoekt repo id that a captured request names. */
function requestedRepositories(): string[] {
  const names = new Set<string>()
  for (const request of captured) {
    const match = request.path.match(/^\/(repo_[a-z2-7]+)\//)
    if (match?.[1]) names.add(repositoryOf(match[1]))
    const ids = request.body.RepoIDs
    if (Array.isArray(ids)) {
      for (const zoektRepoId of ids) {
        for (const [repository, row] of seeded) {
          if (row.zoektRepoId === zoektRepoId) names.add(repository)
        }
      }
    }
  }
  return [...names].sort()
}

describe("org-level code search (Postgres + msw codesearch)", () => {
  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error("DATABASE_URL is required for this test")
    initDb(databaseUrl)
    await getSystemDb()
      .insert(organizations)
      .values({
        id: org.id,
        name: `Org code ${suffix}`,
        slug: org.slug,
        createdAt: new Date(),
      })
    await withOrgDbContext(org.id, async (db) => {
      await db.insert(workspaces).values(
        [
          [paymentsId, "payments"],
          [ledgerId, "ledger"],
          [wideId, "wide"],
        ].map(([id, slug]) => ({
          id: id as string,
          orgId: org.id,
          slug: slug as string,
          displayName: slug as string,
          workspaceRepositoryUrl: `/tmp/org-code-${suffix}-${slug}`,
          desiredDefaultBranch: "main",
        })),
      )
      // The legacy table links alpha, beta and an unindexed repository to payments.
      await db.insert(workspaceLinkedRepositories).values(
        [
          `https://github.com/${name("alpha")}`,
          `git@github.com:${name("beta")}.git`,
          `https://github.com/${name("unindexed")}`,
        ].map((gitUrl) => ({
          id: generateObjectId("wlr"),
          orgId: org.id,
          workspaceId: paymentsId,
          gitUrl,
        })),
      )
      // The sources projection links alpha again (another URL form) and gamma to ledger.
      await db.insert(workspaceSources).values([
        {
          id: generateObjectId("wsrc"),
          orgId: org.id,
          workspaceId: ledgerId,
          sourceKey: "github",
          provider: "github",
          scope: { repositories: [name("Alpha"), name("gamma")] },
          status: "ok",
          revision: "a".repeat(40),
        },
        {
          id: generateObjectId("wsrc"),
          orgId: org.id,
          workspaceId: wideId,
          sourceKey: "github",
          provider: "github",
          scope: { repositories: WIDE.map(name) },
          status: "ok",
          revision: "b".repeat(40),
        },
      ])
      for (const short of ["alpha", "beta", "gamma", ...WIDE]) {
        const id = generateObjectId("repo")
        await db.insert(repositories).values({
          id,
          orgId: org.id,
          name: name(short),
          gitUrl: `https://github.com/${name(short)}.git`,
        })
        const [checkout] = await db
          .insert(repositoryCheckouts)
          .values({
            id: generateObjectId("checkout"),
            orgId: org.id,
            repositoryId: id,
            checkoutKey: "default",
          })
          .returning({ zoektRepoId: repositoryCheckouts.zoektRepoId })
        if (!checkout) throw new Error("checkout insert returned no row")
        seeded.set(name(short), { id, zoektRepoId: checkout.zoektRepoId })
      }
    })
  })

  beforeEach(() => {
    captured = []
    vi.stubEnv("CODESEARCH_URL", CODESEARCH)
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
    await withOrgDbContext(org.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
      await db.delete(repositories).where(eq(repositories.orgId, org.id))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
    await closeDb()
  })

  it("searches a repository that two Workspaces link once, and skips an unindexed repository", async () => {
    server.use(...codesearch({}))
    const scope = await resolveCodeScope(org, { excludeRepositories: [] })
    const handles = scope.repositories.map((repository) => repository.handle)
    expect(handles.filter((handle) => handle === name("alpha"))).toHaveLength(1)
    expect(scope.skipped).toEqual([
      { repository: name("unindexed"), reason: "not_indexed" },
    ])

    const found = await findSymbolAcrossRepositories(
      org,
      scope,
      { primitive: "find_symbol", symbol: "charge" },
      { limit: 100, maxTokens: 100_000 },
    )
    const alphaCalls = captured.filter(
      (request) => request.path === `/${seeded.get(name("alpha"))?.id}/graph`,
    )
    expect(alphaCalls).toHaveLength(1)
    expect(
      found.skipped.filter((entry) => entry.reason !== "over_limit"),
    ).toEqual(scope.skipped)

    captured = []
    const text = await searchCodeText(org, scope, {
      query: "charge",
      limit: 100,
      maxTokens: 100_000,
    })
    const [search] = captured
    const ids = search?.body.RepoIDs as number[]
    expect(
      ids.filter((id) => id === seeded.get(name("alpha"))?.zoektRepoId),
    ).toHaveLength(1)
    expect(
      text.results.filter((match) => match.repository === name("alpha")),
    ).toEqual([
      {
        repository: name("alpha"),
        path: "src/index.ts",
        line: 3,
        snippet: "const charge = 1",
      },
    ])
  })

  it("never sends an excluded repository to codesearch", async () => {
    server.use(...codesearch({}))
    for (const exclude of [
      name("beta"),
      `git@github.com:${name("beta")}.git`,
    ]) {
      captured = []
      const scope = await resolveCodeScope(org, {
        excludeRepositories: [exclude],
      })
      expect(scope.excluded).toEqual([name("beta")])
      const graph = await findSymbolAcrossRepositories(
        org,
        scope,
        { primitive: "find_symbol", symbol: "charge" },
        { limit: 100, maxTokens: 100_000 },
      )
      await structuralSearchAcrossRepositories(
        org,
        scope,
        { pattern: "charge($A)", lang: "typescript" },
        { limit: 100, maxTokens: 100_000 },
      )
      await searchCodeText(org, scope, {
        query: "charge",
        limit: 100,
        maxTokens: 100_000,
      })
      expect(captured.length).toBeGreaterThan(0)
      expect(requestedRepositories()).not.toContain(name("beta"))
      expect(graph.excluded).toEqual([name("beta")])
      expect(graph.results.map((result) => result.repository)).not.toContain(
        name("beta"),
      )
    }
  })

  it("excludes before an explicit repository list, and limits the scope to one Workspace", async () => {
    server.use(...codesearch({}))
    const scope = await resolveCodeScope(org, {
      workspaceId: ledgerId,
      excludeRepositories: [name("gamma")],
    })
    expect(scope.repositories.map((repository) => repository.handle)).toEqual([
      name("alpha"),
    ])
    expect(scope.excluded).toEqual([name("gamma")])
    await expect(
      resolveCodeScope(org, {
        workspaceId: ledgerId,
        repositories: [name("beta")],
        excludeRepositories: [],
      }),
    ).rejects.toMatchObject({ code: "repository_not_found" })
    const named = await resolveCodeScope(org, {
      repositories: [name("beta"), name("gamma")],
      excludeRepositories: [name("beta")],
    })
    expect(named.repositories.map((repository) => repository.handle)).toEqual([
      name("gamma"),
    ])
    await expect(
      resolveCodeScope(org, { excludeRepositories: ["not a handle"] }),
    ).rejects.toBeInstanceOf(McpToolError)
  })

  it("gives skipped for one failing repository, not an error", async () => {
    server.use(...codesearch({ failing: [name("gamma")] }))
    const scope = await resolveCodeScope(org, {
      workspaceId: ledgerId,
      excludeRepositories: [],
    })
    const graph = await findSymbolAcrossRepositories(
      org,
      scope,
      { primitive: "find_symbol", symbol: "charge" },
      { limit: 100, maxTokens: 100_000 },
    )
    expect(graph.skipped).toEqual([
      { repository: name("gamma"), reason: "failed" },
    ])
    expect(graph.results.map((result) => result.repository)).toEqual([
      name("alpha"),
      name("alpha"),
    ])
    const structural = await structuralSearchAcrossRepositories(
      org,
      scope,
      { pattern: "charge($A)", lang: "typescript" },
      { limit: 100, maxTokens: 100_000 },
    )
    expect(structural.skipped).toEqual([
      { repository: name("gamma"), reason: "failed" },
    ])
    expect(structural.results).toHaveLength(2)
  })

  it(`searches the first ${SCIP_FAN_OUT_LIMIT} of 12 repositories and skips the rest as over_limit`, async () => {
    server.use(...codesearch({}))
    const scope = await resolveCodeScope(org, {
      workspaceId: wideId,
      excludeRepositories: [],
    })
    expect(scope.repositories).toHaveLength(12)
    const overLimit = WIDE.slice(10).map((short) => ({
      repository: name(short),
      reason: "over_limit",
    }))
    for (const search of [
      () =>
        findSymbolAcrossRepositories(
          org,
          scope,
          { primitive: "find_symbol", symbol: "charge" },
          { limit: 1_000, maxTokens: 100_000 },
        ),
      () =>
        structuralSearchAcrossRepositories(
          org,
          scope,
          { pattern: "charge($A)", lang: "typescript" },
          { limit: 1_000, maxTokens: 100_000 },
        ),
    ]) {
      captured = []
      const found = await search()
      expect(SCIP_FAN_OUT_LIMIT).toBe(10)
      expect(requestedRepositories()).toEqual(WIDE.slice(0, 10).map(name))
      expect(found.results).toHaveLength(20)
      expect(found.skipped).toEqual(overLimit)
      expect(found.hint).toMatch(
        /repositories.*workspace|workspace.*repositories/,
      )
    }

    // Text search is one Zoekt request and keeps the full scope.
    captured = []
    const text = await searchCodeText(org, scope, {
      query: "charge",
      limit: 1_000,
      maxTokens: 100_000,
    })
    expect(requestedRepositories()).toEqual(WIDE.map(name))
    expect(text.skipped).toEqual([])
    expect(text.hint).toBeUndefined()
  })

  it("merges in a stable order and respects the limit and the token budget", async () => {
    // The first repository answers last, so arrival order differs from the result order.
    server.use(
      ...codesearch({
        results: 3,
        delayMs: (repository) => (repository === name(WIDE[0] ?? "") ? 60 : 0),
      }),
    )
    const scope = await resolveCodeScope(org, {
      workspaceId: wideId,
      excludeRepositories: [],
    })
    const run = () =>
      findSymbolAcrossRepositories(
        org,
        scope,
        { primitive: "find_symbol", symbol: "charge" },
        { limit: 5, maxTokens: 100_000 },
      )
    const first = await run()
    const second = await run()
    expect(first.results).toEqual(second.results)
    // Rank 0 of each repository in handle order comes before any rank 1.
    expect(first.results.map((result) => result.symbol)).toEqual(
      WIDE.slice(0, 5).map((short) => `${name(short)}#0`),
    )
    expect(first.truncated).toBe(true)
    for (const request of captured.filter((item) =>
      item.path.endsWith("/graph"),
    )) {
      expect(request.body.limit).toBe(5)
    }

    const small = await findSymbolAcrossRepositories(
      org,
      scope,
      { primitive: "find_symbol", symbol: "charge" },
      { limit: 100, maxTokens: 40 },
    )
    expect(small.truncated).toBe(true)
    expect(small.results.length).toBeGreaterThan(0)
    expect(JSON.stringify(small.results).length / 4).toBeLessThanOrEqual(
      40 + 20,
    )
  })
})
