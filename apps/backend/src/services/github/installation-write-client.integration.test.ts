import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../test/ingest-github.js"
import { loadLinearScopeFromRepo } from "../linear/config-from-repo.js"
import { syncLinearConfigYaml } from "../linear/sync.js"
import { loadPagerdutyScopeFromRepo } from "../pagerduty/config-from-repo.js"
import {
  commitFiles,
  getFileContentBytes,
  workspaceRootPathOfRepository,
} from "./installation-write-client.js"

/*
 * The Workspace root folder (CTX-709) through the GitHub write client: the
 * installation comes from Postgres, and msw stands in for GitHub. The org
 * has a Workspace on example-org/mono with the root folder docs/ctx.
 */

const orgId = generateObjectId("org")
const connectionId = generateObjectId("con")
const installationId = 777_001
const repositoryName = "example-org/mono"
const repo = `https://api.github.com/repos/${repositoryName}`
const ROOT = "docs/ctx"

const server = useMswServer()

afterEach(() => {
  vi.restoreAllMocks()
})

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  stubGithubApp()
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Root folder write client proof",
    createdAt: new Date(),
  })
  await insertGithubConnection({
    orgId,
    id: connectionId,
    installationId,
    accountSlug: "example-org",
  })
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: generateObjectId("ws"),
      orgId,
      slug: `mono-${orgId}`,
      displayName: "Mono",
      workspaceRepositoryUrl: `https://github.com/${repositoryName}`,
      rootPath: ROOT,
      githubConnectionId: connectionId,
      writeStatus: "writable",
    }),
  )
})

afterAll(async () => {
  await withOrgDbContext(orgId, async (db) => {
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    await db.delete(connections).where(eq(connections.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

/**
 * GitHub for example-org/mono: `files` is the default branch content, by
 * repository path. It records the content reads and the written trees.
 */
function githubRepository(files: Record<string, string> = {}) {
  const log: GithubTokenLog = { minted: [], revoked: [] }
  const reads: string[] = []
  const trees: Array<{ path: string }[]> = []
  const pulls: Array<Record<string, unknown>> = []
  server.use(
    ...githubTokenHandlers(log, () => "fixture-only-write-token"),
    http.get(`${repo}/contents/*`, ({ request }) => {
      const path = decodeURIComponent(
        new URL(request.url).pathname.slice(
          `/repos/${repositoryName}/contents/`.length,
        ),
      )
      reads.push(path)
      const content = files[path]
      if (content === undefined)
        return HttpResponse.json({ message: "Not Found" }, { status: 404 })
      return HttpResponse.json({
        type: "file",
        encoding: "base64",
        size: content.length,
        content: Buffer.from(content).toString("base64"),
      })
    }),
    http.get(repo, () => HttpResponse.json({ default_branch: "main" })),
    http.get(`${repo}/git/ref/*`, () =>
      HttpResponse.json({ object: { sha: "base", type: "commit" } }),
    ),
    http.get(`${repo}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({ sha: params.sha, tree: { sha: "base-tree" } }),
    ),
    http.post(`${repo}/git/refs`, () =>
      HttpResponse.json({ object: { sha: "base" } }, { status: 201 }),
    ),
    http.post(`${repo}/git/blobs`, () => HttpResponse.json({ sha: "blob" })),
    http.post(`${repo}/git/trees`, async ({ request }) => {
      trees.push(((await request.json()) as { tree: { path: string }[] }).tree)
      return HttpResponse.json({ sha: "tree" })
    }),
    http.post(`${repo}/git/commits`, () => HttpResponse.json({ sha: "next" })),
    http.patch(`${repo}/git/refs/*`, () =>
      HttpResponse.json({ object: { sha: "next" } }),
    ),
    http.post(`${repo}/pulls`, async ({ request }) => {
      pulls.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json(
        { number: 9, html_url: `https://github.com/${repositoryName}/pull/9` },
        { status: 201 },
      )
    }),
  )
  return { reads, trees, pulls }
}

const base = () => ({
  orgId,
  env: parseEnv(process.env),
  repositoryName,
  githubConnectionId: connectionId,
})

describe("GitHub write client with a Workspace root folder", () => {
  it("finds the root folder of the org's Workspace on the repository", async () => {
    expect(await workspaceRootPathOfRepository(base())).toBe(ROOT)
    expect(
      await workspaceRootPathOfRepository({
        orgId,
        repositoryName: "Example-Org/Mono",
      }),
    ).toBe(ROOT)
    expect(
      await workspaceRootPathOfRepository({
        orgId,
        repositoryName: "example-org/other",
      }),
    ).toBe("")
  })

  it("reads a root-relative file below the root folder", async () => {
    const github = githubRepository({ [`${ROOT}/.ctxpipe/sources.yaml`]: "hi" })
    const file = await getFileContentBytes({
      ...base(),
      branch: "main",
      path: ".ctxpipe/sources.yaml",
      rootPath: ROOT,
    })
    expect(file).toMatchObject({ kind: "bytes" })
    expect(github.reads).toEqual([`${ROOT}/.ctxpipe/sources.yaml`])
  })

  it("commits root-relative files below the root folder", async () => {
    const github = githubRepository()
    await commitFiles({
      ...base(),
      branch: "ctxpipe/session",
      message: "Change sources",
      files: [{ path: ".ctxpipe/sources.yaml", content: "sources: []\n" }],
      deletePaths: ["pagerduty/old.md"],
      rootPath: ROOT,
    })
    expect(github.trees[0]?.map((entry) => entry.path).sort()).toEqual([
      `${ROOT}/.ctxpipe/sources.yaml`,
      `${ROOT}/pagerduty/old.md`,
    ])
  })

  it("refuses a file or a delete outside the root folder before any write", async () => {
    const github = githubRepository()
    for (const change of [
      { files: [{ path: "../../src/app.ts", content: "x" }] },
      { files: [], deletePaths: ["../README.md"] },
    ])
      await expect(
        commitFiles({
          ...base(),
          branch: "ctxpipe/session",
          message: "Escape",
          rootPath: ROOT,
          ...change,
        }),
      ).rejects.toThrow()
    expect(github.trees).toEqual([])
  })
})

describe("connector config files with a Workspace root folder", () => {
  it("proposes the Linear config below the root folder", async () => {
    const github = githubRepository()
    // Octokit spaces its write requests by 1 to 2 s, which would take 5 s here. Run
    // the short spacing timers at once; Postgres and msw keep real I/O.
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) =>
      realSetTimeout(
        callback,
        delay !== undefined && delay <= 5_000 ? 0 : delay,
      )) as typeof setTimeout)
    const now = new Date()
    const result = await syncLinearConfigYaml({
      orgId,
      orgSlug: orgId,
      env: parseEnv(process.env),
      connection: {
        id: generateObjectId("con"),
        orgId,
        accessToken: "fixture-only",
        refreshToken: null,
        accessTokenExpiresAt: null,
        workspaceId: "linear-workspace",
        workspaceName: "Example",
        workspaceUrlKey: "example",
        actorUserId: null,
        ownerUserId: null,
        status: "installed",
        lastEventPayload: null,
        repositoryId: "repo_fixture",
        branch: "main",
        enabled: true,
        setupPhase: "awaiting_merge",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        createdAt: now,
        updatedAt: now,
      },
      target: {
        id: "lst_fixture",
        orgId,
        connectionId: "con_linear_fixture",
        repositoryId: "repo_fixture",
        repositoryName,
        githubConnectionId: connectionId,
        branch: "main",
        enabled: true,
        setupPhase: "awaiting_merge",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        createdAt: now,
        updatedAt: now,
      },
      scopes: [
        {
          externalId: "team-1",
          type: "team",
          title: "Product",
          url: null,
          parentExternalId: null,
          teamId: "team-1",
          teamKey: "PRO",
        },
      ],
    })
    expect(result).toMatchObject({ changed: true, pullNumber: 9 })
    expect(github.reads).toEqual([`${ROOT}/linear/config.yaml`])
    expect(github.trees[0]?.map((entry) => entry.path)).toEqual([
      `${ROOT}/linear/config.yaml`,
    ])
    expect(github.pulls).toHaveLength(1)
  })

  it("reads the Linear and PagerDuty configs below the root folder only", async () => {
    const github = githubRepository({
      "pagerduty/config.yaml": "outside: true\n",
      "linear/config.yaml": "outside: true\n",
    })
    const input = { ...base(), branch: "main" }
    expect(await loadPagerdutyScopeFromRepo(input)).toBeUndefined()
    expect(await loadLinearScopeFromRepo(input)).toBeUndefined()
    expect(github.reads).toEqual([
      `${ROOT}/pagerduty/config.yaml`,
      `${ROOT}/linear/config.yaml`,
    ])
  })
})
