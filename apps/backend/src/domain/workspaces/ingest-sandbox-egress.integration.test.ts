import { randomBytes } from "node:crypto"
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
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { generateObjectId } from "../../lib/id.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../test/ingest-github.js"
import {
  ingestCredentialRules,
  ingestGitAccess,
  ingestVercelTokenStore,
  vercelIngestSandboxProvider,
} from "./ingest-sandbox-egress.js"
import { revokeFinishedIngestGitTokens } from "./run-git-tokens.js"

const orgId = generateObjectId("org")
const alpha = generateObjectId("con")
const beta = generateObjectId("con")
const log: GithubTokenLog = { minted: [], revoked: [], mintedPermissions: [] }

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer(
  ...githubTokenHandlers(
    log,
    (installationId) => `ghs_${installationId}`,
    // The beta installation follows the self-host docs without the optional
    // Issues permission.
    (installationId) =>
      installationId === 222
        ? { contents: "write", metadata: "read", pull_requests: "write" }
        : {
            contents: "write",
            metadata: "read",
            pull_requests: "write",
            issues: "read",
          },
  ),
)

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest tokens")
  initDb(url)
  stubGithubApp()
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingest egress tokens",
    createdAt: new Date(),
  })
  await insertGithubConnection({
    orgId,
    id: alpha,
    installationId: 111,
    accountSlug: "alpha-owner",
  })
  await insertGithubConnection({
    orgId,
    id: beta,
    installationId: 222,
    accountSlug: "beta-owner",
  })
})

beforeEach(() => {
  log.minted.length = 0
  log.revoked.length = 0
  log.mintedPermissions = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  stubGithubApp()
})

afterAll(async () => {
  const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
  for (const row of await store.list("ingest:")) await store.take(row.key)
  await withOrgDbContext(orgId, (db) =>
    db.delete(connections).where(eq(connections.orgId, orgId)),
  )
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

/** The hosted provider of one shard that reads `alpha-owner/source`. */
function hostedProvider(
  shard: { orgId: string; runId: string; shard: number },
  proven?: boolean,
) {
  return vercelIngestSandboxProvider({
    ...shard,
    repositories: [
      { fullName: "alpha-owner/source", githubConnectionId: alpha },
    ],
    backendHost: "app.example.test",
    credentials: { token: "t", teamId: "team_test", projectId: "prj_test" },
    agentPassword: "password",
    tags: {},
    agentSnapshot: async () => "snap_test",
    ...(proven ? { proven } : {}),
  })
}

describe("ingest GitHub tokens", () => {
  it("mints one token per GitHub connection, each with its own fetch rules", async () => {
    const runId = `run_${crypto.randomUUID()}`
    const git = await ingestGitAccess({
      orgId,
      runId,
      shard: 0,
      repositories: [
        { fullName: "alpha-owner/source", githubConnectionId: alpha },
        { fullName: "beta-owner/context", githubConnectionId: beta },
        { fullName: "alpha-owner/notes", githubConnectionId: alpha },
      ],
    })
    expect(git).toEqual([
      {
        token: "ghs_111",
        repositories: ["alpha-owner/source", "alpha-owner/notes"],
      },
      { token: "ghs_222", repositories: ["beta-owner/context"] },
    ])
    expect(log.minted).toEqual([
      { installationId: 111, repositories: ["notes", "source"] },
      { installationId: 222, repositories: ["context"] },
    ])
    const rules = ingestCredentialRules(
      {
        repositories: [],
        modelProxyUrl: "https://app.example.test/acme/openai/v1",
        capability: "cap",
        bridge: { url: "https://app.example.test/bridge", token: "b" },
      },
      git,
    )
    const basic = (token: string) =>
      `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
    expect(
      rules.find((rule) => rule.path === "/beta-owner/context.git/info/refs")
        ?.authorization,
    ).toBe(basic("ghs_222"))
    expect(
      rules.find(
        (rule) => rule.path === "/alpha-owner/source.git/git-upload-pack",
      )?.authorization,
    ).toBe(basic("ghs_111"))
  })

  it("asks for Issues read only when the installation grants Issues", async () => {
    await ingestGitAccess({
      orgId,
      runId: `run_${crypto.randomUUID()}`,
      shard: 0,
      repositories: [
        { fullName: "alpha-owner/source", githubConnectionId: alpha },
        { fullName: "beta-owner/context", githubConnectionId: beta },
      ],
    })
    expect(log.minted.map((mint) => mint.installationId)).toEqual([111, 222])
    expect(log.mintedPermissions).toEqual([
      {
        contents: "read",
        issues: "read",
        pull_requests: "read",
        metadata: "read",
      },
      { contents: "read", pull_requests: "read", metadata: "read" },
    ])
  })

  it("throws when a connection does not cover a repository, and mints nothing", async () => {
    await expect(
      ingestGitAccess({
        orgId,
        runId: `run_${crypto.randomUUID()}`,
        shard: 0,
        repositories: [
          { fullName: "alpha-owner/source", githubConnectionId: alpha },
          { fullName: "beta-owner/context", githubConnectionId: alpha },
        ],
      }),
    ).rejects.toThrow(`The GitHub connection ${alpha} does not cover`)
    await expect(
      ingestGitAccess({
        orgId,
        runId: `run_${crypto.randomUUID()}`,
        shard: 0,
        repositories: [
          { fullName: "alpha-owner/source", githubConnectionId: "con_unknown" },
        ],
      }),
    ).rejects.toThrow("The GitHub connection con_unknown does not cover")
    expect(log.minted).toEqual([])
  })

  it("records a hosted shard's token under its ingest thread, so the sweep revokes it after the run", async () => {
    const shard = { orgId, runId: `run_gone_${crypto.randomUUID()}`, shard: 4 }
    const tokens = ingestVercelTokenStore(shard)
    await tokens.put("sbx-any-name", "ghs_hosted")
    expect((await tokens.get("sbx-any-name"))?.token).toBe("ghs_hosted")
    // The run is unknown (finished): the sweep revokes the token.
    expect(await revokeFinishedIngestGitTokens({ orgId })).toBe(false)
    expect(log.revoked).toContain("ghs_hosted")
    expect(await tokens.get("sbx-any-name")).toBeNull()
  })

  it("keeps a record of each hosted token after a rotation; take removes none, and the sweep revokes each", async () => {
    const shard = { orgId, runId: `run_gone_${crypto.randomUUID()}`, shard: 5 }
    const tokens = ingestVercelTokenStore(shard)
    // Two mint times, one second apart, within the token lifetime.
    const now = Date.now()
    vi.setSystemTime(now - 2_000)
    await tokens.put("", "ghs_first")
    vi.setSystemTime(now - 1_000)
    await tokens.put("", "ghs_rotated")
    // The same token again adds no record.
    await tokens.put("", "ghs_rotated")
    vi.useRealTimers()
    expect((await tokens.get(""))?.token).toBe("ghs_rotated")
    // A record goes only after GitHub confirms the revoke.
    expect(await tokens.take("")).toBeNull()
    expect((await tokens.get(""))?.token).toBe("ghs_rotated")
    expect(await revokeFinishedIngestGitTokens({ orgId })).toBe(false)
    expect([...log.revoked].sort()).toEqual(["ghs_first", "ghs_rotated"])
    expect(await tokens.get("")).toBeNull()
  })

  it("keeps a hosted token's record when its revoke fails at destroy; the sweep revokes it later, and a 401 counts as revoked", async () => {
    const shard = { orgId, runId: `run_gone_${crypto.randomUUID()}`, shard: 6 }
    const tokens = ingestVercelTokenStore(shard)
    await tokens.put("", "ghs_unrevoked")
    server.use(
      // The sandbox and its snapshots are gone already.
      http.get("https://vercel.com/api/v2/sandboxes/snapshots", () =>
        HttpResponse.json({
          snapshots: [],
          pagination: { count: 0, next: null },
        }),
      ),
      http.get("https://vercel.com/api/v2/sandboxes/:name", () =>
        HttpResponse.json({ error: { code: "not_found" } }, { status: 404 }),
      ),
      http.delete("https://api.github.com/installation/token", () =>
        HttpResponse.json({ message: "unavailable" }, { status: 503 }),
      ),
    )
    // The gate is closed: destroy still works.
    await hostedProvider(shard).provider.destroy({ id: "sbx-ingest-gone" })
    expect((await tokens.get(""))?.token).toBe("ghs_unrevoked")
    // GitHub answers 401 now: the token was revoked or expired already.
    server.use(
      http.delete(
        "https://api.github.com/installation/token",
        () => new HttpResponse(null, { status: 401 }),
      ),
    )
    expect(await revokeFinishedIngestGitTokens({ orgId })).toBe(false)
    expect(await tokens.get("")).toBeNull()
  })

  it("refuses to resume a hosted ingest sandbox before the live Vercel egress check", async () => {
    vi.stubEnv("VERCEL_TOKEN", "vercel-token")
    vi.stubEnv("VERCEL_TEAM_ID", "team_test")
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_test")
    const { provider } = hostedProvider({
      orgId,
      runId: `run_${crypto.randomUUID()}`,
      shard: 0,
    })
    await expect(provider.resume({ id: "sbx-ingest-old" })).rejects.toThrow(
      "Hosted ingest sandboxes wait for the live Vercel egress check (T12)",
    )
    expect(log.minted).toEqual([])
  })

  it("revokes a minted hosted token when its record cannot be written", async () => {
    vi.stubEnv("VERCEL_TOKEN", "vercel-token")
    vi.stubEnv("VERCEL_TEAM_ID", "team_test")
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_test")
    // The record key holds the run id. Postgres refuses an index entry
    // above about 2.7 kB, so this run id makes the record write fail after
    // GitHub minted the token.
    const runId = `run_${randomBytes(4096).toString("hex")}`
    const { provider } = hostedProvider({ orgId, runId, shard: 0 }, true)
    await expect(provider.create({})).rejects.toThrow()
    expect(log.minted).toHaveLength(1)
    expect(log.revoked).toEqual(["ghs_111"])
  })

  it("refuses to start a hosted ingest sandbox before the live Vercel egress check", async () => {
    const { provider } = hostedProvider({
      orgId,
      runId: `run_${crypto.randomUUID()}`,
      shard: 0,
    })
    await expect(provider.create({})).rejects.toThrow(
      "Hosted ingest sandboxes wait for the live Vercel egress check (T12)",
    )
    expect(log.minted).toEqual([])
  })
})
