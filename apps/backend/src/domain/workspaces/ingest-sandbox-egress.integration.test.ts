import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
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
const log: GithubTokenLog = { minted: [], revoked: [] }

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  ...githubTokenHandlers(log, (installationId) => `ghs_${installationId}`),
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

  it("refuses to start a hosted ingest sandbox before the live Vercel egress check", async () => {
    const { provider } = vercelIngestSandboxProvider({
      orgId,
      runId: `run_${crypto.randomUUID()}`,
      shard: 0,
      repositories: [
        { fullName: "alpha-owner/source", githubConnectionId: alpha },
      ],
      backendHost: "app.example.test",
      credentials: { token: "t", teamId: "team_test", projectId: "prj_test" },
      agentPassword: "password",
      tags: {},
      agentSnapshot: async () => "snap_test",
    })
    await expect(provider.create({})).rejects.toThrow(
      "Hosted ingest sandboxes wait for the live Vercel egress check (T12)",
    )
    expect(log.minted).toEqual([])
  })
})
