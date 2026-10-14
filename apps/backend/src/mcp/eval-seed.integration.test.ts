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
  prepareMcpEvalRepositories,
  seedMcpEval,
} from "../../evals/mcp/seed.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations, users } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaces } from "../db/schema/workspaces.js"
import { readWorkspaceGraph } from "../domain/workspaces/graph-projection.js"
import { searchKnowledge } from "../domain/workspaces/knowledge-search.js"
import {
  getWorkspaceProjection,
  listWorkspaceKnowledgeFiles,
} from "../models/workspaces.js"
import { closeGraphDb } from "../platform/graph/client.js"

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
const server = setupServer(
  http.post("https://eval-model.test/v1/embeddings", async ({ request }) => {
    const { input } = (await request.json()) as { input: string[] }
    return HttpResponse.json({
      data: input.map((_, index) => ({
        index,
        embedding: Array(2000).fill(0.01),
      })),
    })
  }),
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
          detectedLanguages: [],
          languagesToIndex: [],
        })
      if (params.phase === "merge-scip")
        return HttpResponse.json({ ok: true, shardCount: 0 })
      return HttpResponse.json({ ok: true })
    },
  ),
)
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  if (!process.env.GRAPH_DB_URI) throw new Error("GRAPH_DB_URI is required")
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
    expect(
      cloneRequests.filter(
        (request) =>
          request.targetHash === "ab85d9bca9564eb0f867ab45e3cbf45659d9ac4c",
      ),
    ).toHaveLength(1)
    expect(
      cloneRequests.filter(
        (request) =>
          request.targetHash === "0ac610dfa4e5cbd929b2e9b8fc34f5417f2f788b",
      ),
    ).toHaveLength(1)
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
    expect(found.map((hit) => hit.path)).toEqual(["linear/issues/HBR-17.md"])
    expect(found[0]).toMatchObject({
      title: "Reject duplicate settlement",
      source: "linear",
      updatedAt: new Date("2026-06-01T12:00:00Z"),
    })
    expect(
      await searchKnowledge({
        orgId: meadow.id,
        workspaceIds: [payments.id],
        query: "idempotency",
      }),
    ).toEqual([])
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
