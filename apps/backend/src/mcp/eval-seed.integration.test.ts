import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, inArray, sql } from "drizzle-orm"
import { FalkorDB } from "falkordb"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
  advanceMcpEvalWorkspace,
  createMcpEvalApiKey,
  mcpEvalManifest,
  prepareMcpEvalRepositories,
  seedMcpEval,
} from "../../evals/mcp/seed.js"
import { listCallOrgs } from "../auth/call-org.js"
import { getAuth } from "../auth/config.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { apikeys, organizations, users } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaces } from "../db/schema/workspaces.js"
import { readWorkspaceGraph } from "../domain/workspaces/graph-projection.js"
import { searchKnowledge } from "../domain/workspaces/knowledge-search.js"
import {
  getWorkspaceProjection,
  listWorkspaceKnowledgeFiles,
  listWorkspaceKnowledgeUnits,
} from "../models/workspaces.js"
import { closeGraphDb } from "../platform/graph/client.js"
import { usePlainGitNetwork } from "../services/git/plain-git-remote.js"

config({
  path: fileURLToPath(new URL("../../.env.local", import.meta.url)),
  quiet: true,
})
const run = `proof-${Date.now()}`
const userId = `user_eval_${run}`
let directory: string
let graph: FalkorDB
let result: Awaited<ReturnType<typeof seedMcpEval>>
const cloneRequests: Array<{ targetHash: string }> = []
const scipRequests: string[] = []
const issuePath =
  "linear/teams/HBR/issues/hbr-17--7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.md"
const harborDates: Record<string, string> =
  mcpEvalManifest.workspaces[0]?.updatedAt ?? {}
const server = setupServer(
  http.post("https://eval-model.test/v1/embeddings", async ({ request }) => {
    const { input } = (await request.json()) as { input: string[] }
    return HttpResponse.json({
      // One flat vector would tie every chunk, and the chunk id would pick the
      // semantic rank. Text with the marker gets its own direction, so the
      // marker query is nearest to the chunk that holds it.
      data: input.map((text, index) => ({
        index,
        embedding: Array.from({ length: 2000 }, (_, dim) =>
          dim === 0 && text.includes("MEADOW_ONLY_42") ? 1 : 0.01,
        ),
      })),
    })
  }),
  http.post(
    "http://eval-codesearch.test/:repo/index/scip/:language",
    ({ params }) => {
      scipRequests.push(String(params.language))
      return HttpResponse.json({ ok: true })
    },
  ),
  http.post(
    "http://eval-codesearch.test/:repo/index/:phase",
    async ({ request, params }) => {
      if (params.phase === "clone-checkout") {
        const body = (await request.json()) as { targetHash: string }
        cloneRequests.push(body)
        return HttpResponse.json({
          ok: true,
          targetHash: body.targetHash,
          ingestMode: "full",
          changedPaths: [],
          deletedPaths: [],
          renames: [],
        })
      }
      if (params.phase === "detect-languages")
        return HttpResponse.json({
          ok: true,
          detectedLanguages: ["typescript"],
          languagesToIndex: ["typescript"],
        })
      if (params.phase === "merge-scip")
        return HttpResponse.json({ ok: true, shardCount: 1 })
      return HttpResponse.json({ ok: true })
    },
  ),
)
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  if (!process.env.GRAPH_DB_URI) throw new Error("GRAPH_DB_URI is required")
  // The repository has no GitHub token, so the backend checks it as a
  // plain git URL (CTX-815). The test has its own DNS answer.
  usePlainGitNetwork({ lookup: async () => [{ address: "140.82.112.3" }] })
  initDb(process.env.DATABASE_URL)
  expect(
    (await getSystemDb().execute(sql`select current_user as role`)).rows[0],
  ).toEqual({ role: "ctxpipe_app" })
  graph = await FalkorDB.connect({ url: process.env.GRAPH_DB_URI })
  directory = await mkdtemp(join(tmpdir(), "mcp-eval-proof-"))
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://eval-model.test/v1")
  vi.stubEnv("CODESEARCH_URL", "http://eval-codesearch.test")
  await getSystemDb()
    .insert(users)
    .values({ id: userId, name: "Eval reader", email: `${run}@example.test` })
  server.listen({ onUnhandledRequest: "error" })
})
afterAll(async () => {
  server.close()
  const orgIds = [
    run,
    `second-${run}`,
    `changed-${run}`,
    `missing-${run}`,
    `extra-${run}`,
  ].flatMap((name) =>
    ["harbor", "meadow"].map((key) => `org_mcp_eval_${name}_${key}`),
  )
  for (const orgId of orgIds) {
    const org = { id: orgId }
    await withOrgDbContext(org.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
      await db.delete(repositories).where(eq(repositories.orgId, org.id))
    })
    if ((await graph.list()).includes(org.id))
      await graph.selectGraph(org.id).delete()
  }
  await getSystemDb()
    .delete(organizations)
    .where(inArray(organizations.id, orgIds))
  await getSystemDb().delete(users).where(eq(users.id, userId))
  await graph?.close()
  await closeGraphDb()
  await closeDb()
  vi.unstubAllEnvs()
  if (directory) await rm(directory, { recursive: true, force: true })
})
it(
  "seeds two organizations and three ready Workspace projections from Git",
  { timeout: 60_000 },
  async () => {
    const remotes = await prepareMcpEvalRepositories(
      join(directory, "repositories"),
    )
    result = await seedMcpEval({ run, userId, remotes })
    expect(result.organizations.map((org) => org.slug)).toEqual([
      `mcp-eval-${run}-harbor`,
      `mcp-eval-${run}-meadow`,
    ])
    expect(result.workspaces.map((workspace) => workspace.slug)).toEqual([
      "payments",
      "platform",
      "payments",
    ])
    for (const workspace of result.workspaces) {
      const org = result.organizations.find((org) => org.id === workspace.orgId)
      if (!org) throw new Error("Fixture organization is absent")
      await withOrgIdContext(org, async () => {
        const projection = await getWorkspaceProjection(workspace.id)
        expect(projection).toMatchObject({
          kind: "active",
          stores: {
            embeddings: { kind: "ready" },
            graph: { kind: "ready" },
            index: { kind: "ready" },
          },
        })
        if (projection.kind !== "active")
          throw new Error("Projection is absent")
        const graphRead = await readWorkspaceGraph({
          orgId: org.id,
          orgSlug: org.slug,
          projection,
        })
        expect(graphRead.nodes.length).toBeGreaterThan(0)
        expect(graphRead.edges.length).toBeGreaterThan(0)
        expect(
          await listWorkspaceKnowledgeFiles(workspace.id),
        ).not.toHaveLength(0)
      })
    }
    expect(cloneRequests).toHaveLength(5)
    for (const upstream of mcpEvalManifest.upstreamRepositories)
      expect(
        cloneRequests.filter((request) => request.targetHash === upstream.sha),
      ).toHaveLength(1)
    // Each of the five indexes reaches the SCIP phase.
    expect(scipRequests).toEqual(Array(5).fill("typescript"))
    const [harbor, meadow] = result.organizations
    const payments = result.workspaces[0]
    if (!harbor || !meadow || !payments)
      throw new Error("Seed result is incomplete")
    const found = await searchKnowledge({
      orgId: harbor.id,
      workspaceIds: [payments.id],
      query: "idempotency",
      sources: ["linear"],
    })
    expect(found.map((hit) => hit.path)).toEqual([issuePath])
    expect(found[0]).toMatchObject({
      title: "Reject duplicate settlement",
      source: "linear",
      updatedAt: new Date(harborDates[issuePath] ?? ""),
    })
  },
)

it.each(["changed", "missing", "extra"])(
  "refuses %s content in a fixture remote",
  { timeout: 60_000 },
  async (change) => {
    const root = join(directory, change)
    const remotes = await prepareMcpEvalRepositories(root)
    const cwd = join(root, "harbor-payments-checkout")
    if (change === "missing")
      await rm(join(cwd, "knowledge/services/ledger.md"))
    else
      await writeFile(
        join(
          cwd,
          change === "extra" ? "extra.md" : "knowledge/services/ledger.md",
        ),
        "# Different ledger\nThis is not the evaluation fixture.\n",
      )
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" })
    git("add", ".")
    git(
      "-c",
      "user.name=Eval",
      "-c",
      "user.email=eval@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Change a fixture",
    )
    const remote = remotes["harbor-payments"]
    if (!remote) throw new Error("Fixture remote is absent")
    git("push", remote, "HEAD:main")
    await expect(
      seedMcpEval({ run: `${change}-${run}`, userId, remotes }),
    ).rejects.toThrow("does not match the evaluation fixture")
  },
)

it("gives mirror files their kind and joins them to the Workspace by reference", async () => {
  const [harbor] = result.organizations
  const payments = result.workspaces[0]
  if (!harbor || !payments) throw new Error("Seed result is incomplete")
  await withOrgIdContext(harbor, async () => {
    const { units } = await listWorkspaceKnowledgeUnits(payments.id)
    const unit = (path: string) => {
      const found = units.find((unit) => unit.path === path)
      if (!found) throw new Error(`Unit is absent: ${path}`)
      return found
    }
    expect(unit(issuePath)).toMatchObject({ kind: "Issue", source: "linear" })
    expect(unit("pagerduty/incidents/HBR-3.md")).toMatchObject({
      kind: "Incident",
    })
    // The incident names the ticket by its Linear URL, and the decision links it.
    expect(unit("pagerduty/incidents/HBR-3.md").links).toContain(
      `workspace:${issuePath}`,
    )
    expect(unit("knowledge/decisions/idempotency.md").links).toContain(
      `workspace:${issuePath}`,
    )
    const projection = await getWorkspaceProjection(payments.id)
    if (projection.kind !== "active") throw new Error("Projection is absent")
    const graphRead = await readWorkspaceGraph({
      orgId: harbor.id,
      orgSlug: harbor.slug,
      projection,
    })
    const issue = unit(issuePath).servingId
    expect(graphRead.nodes.find((node) => node.id === issue)?.kind).toBe(
      "Issue",
    )
    expect(
      graphRead.edges.filter((edge) => edge.targetId === issue),
    ).not.toHaveLength(0)
  })
})

it("gives units different update times that a time filter can use", async () => {
  const [harbor] = result.organizations
  const payments = result.workspaces[0]
  if (!harbor || !payments) throw new Error("Seed result is incomplete")
  const since = new Date("2026-05-01T00:00:00Z")
  const hits = await searchKnowledge({
    orgId: harbor.id,
    workspaceIds: [payments.id],
    query: "settlement",
    updatedAfter: since,
  })
  const expected = Object.entries(harborDates)
    .filter(([, date]) => new Date(date) > since)
    .map(([path]) => path)
    .sort()
  expect(expected).toHaveLength(3)
  expect(hits.map((hit) => hit.path).sort()).toEqual(expected)
  for (const hit of hits)
    expect(hit.updatedAt).toEqual(new Date(harborDates[hit.path] ?? ""))
  const all = await searchKnowledge({
    orgId: harbor.id,
    workspaceIds: [payments.id],
    query: "settlement",
  })
  expect(
    new Set(all.map((hit) => hit.updatedAt.toISOString())).size,
  ).toBeGreaterThan(3)
})

it("keeps one organization's content out of the other's search", async () => {
  const [harbor, meadow] = result.organizations
  const harborPayments = result.workspaces[0]
  const meadowPayments = result.workspaces[2]
  if (!harbor || !meadow || !harborPayments || !meadowPayments)
    throw new Error("Seed result is incomplete")
  expect(meadowPayments.slug).toBe(harborPayments.slug)
  // Vector ranking returns the nearest chunks of the scope, so the proof is
  // that no hit holds the marker, not that the list is empty.
  const harborHits = await searchKnowledge({
    orgId: harbor.id,
    workspaceIds: [harborPayments.id],
    query: "MEADOW_ONLY_42",
  })
  expect(harborHits.some((hit) => hit.text.includes("MEADOW_ONLY_42"))).toBe(
    false,
  )
  const meadowHits = await searchKnowledge({
    orgId: meadow.id,
    workspaceIds: [meadowPayments.id],
    query: "MEADOW_ONLY_42",
  })
  expect(meadowHits[0]).toMatchObject({
    path: "knowledge/services/settlement.md",
  })
  expect(meadowHits[0]?.text).toContain("MEADOW_ONLY_42")
  expect(
    await searchKnowledge({
      orgId: meadow.id,
      workspaceIds: [harborPayments.id],
      query: "MEADOW_ONLY_42",
    }),
  ).toEqual([])
})

it(
  "moves a Workspace to a second projection",
  { timeout: 60_000 },
  async () => {
    const remotes = await prepareMcpEvalRepositories(
      join(directory, "second-projection"),
    )
    const seeded = await seedMcpEval({ run: `second-${run}`, userId, remotes })
    const first = seeded.workspaces.find(
      (workspace) =>
        workspace.key === mcpEvalManifest.secondProjection.workspace,
    )
    const harbor = seeded.organizations[0]
    if (!first || !harbor) throw new Error("Seed result is incomplete")
    const moved = await advanceMcpEvalWorkspace({
      run: `second-${run}`,
      userId,
      remotes,
    })
    expect(moved).toMatchObject({ id: first.id, orgId: first.orgId })
    expect(moved.sha).not.toBe(first.sha)
    await withOrgIdContext(harbor, async () => {
      const projection = await getWorkspaceProjection(first.id)
      expect(projection).toMatchObject({
        kind: "active",
        revision: { sha: moved.sha },
        stores: {
          embeddings: { kind: "ready" },
          graph: { kind: "ready" },
          index: { kind: "ready" },
        },
      })
    })
    const refunds = await searchKnowledge({
      orgId: harbor.id,
      workspaceIds: [first.id],
      query: "refund service",
    })
    expect(refunds.map((hit) => hit.path)).toContain(
      "knowledge/services/refunds.md",
    )
    expect(new Set(refunds.map((hit) => hit.projectionSha))).toEqual(
      new Set([moved.sha]),
    )
  },
)

it("creates a personal API key that reaches only the two fixture organizations of the run", async () => {
  // The first test seeded `run`; the user is also a member of the orgs of other seeds.
  const orgIds = ["harbor", "meadow"].map((key) => `org_mcp_eval_${run}_${key}`)
  const created = await createMcpEvalApiKey({ userId, organizationIds: orgIds })
  try {
    const verified = await getAuth().api.verifyApiKey({
      body: { key: created.key },
    })
    expect(verified.valid).toBe(true)
    const reachable = await listCallOrgs({
      kind: "user",
      userId,
      oauthReferenceId: null,
      personalApiKeyId: created.id,
    })
    expect(reachable.map((org) => org.slug).sort()).toEqual([
      `mcp-eval-${run}-harbor`,
      `mcp-eval-${run}-meadow`,
    ])
    await expect(
      createMcpEvalApiKey({ userId, organizationIds: [] }),
    ).rejects.toThrow("organization")
  } finally {
    await getSystemDb().delete(apikeys).where(eq(apikeys.id, created.id))
  }
})
