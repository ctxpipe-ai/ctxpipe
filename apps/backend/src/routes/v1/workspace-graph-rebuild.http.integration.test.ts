import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
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
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type {
  DerivedStoreResult,
  WorkspaceRevision,
} from "../../domain/workspaces/revision.js"
import {
  markWorkspaceGraphRetry,
  persistWorkspaceGraphResult,
} from "../../models/workspaces.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceRoutes } from "./workspaces.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_graph_rebuild_${suffix}`,
  slug: `graph-rebuild-${suffix}`,
  name: "Graph rebuild",
}
const app = () => workspaceHttpApp(org, workspaceRoutes)

async function seedWorkspace(
  name: string,
  graph: DerivedStoreResult | null,
  options: {
    embeddingError?: string
    index?: DerivedStoreResult
    desiredSha?: string
  } = {},
): Promise<WorkspaceRevision> {
  const { embeddingError } = options
  const id = `ws_${name}_${suffix}`
  const url = `https://github.com/example/${name}-${suffix}.git`
  const sha = "c".repeat(40)
  const revision: WorkspaceRevision = {
    workspaceId: id,
    generation: 1,
    remote: { url, connectionId: null },
    defaultBranch: "main",
    sha,
    access: "read",
  }
  await withOrgDbContext(org.id, (db) =>
    db.insert(workspaces).values({
      id,
      orgId: org.id,
      slug: name,
      displayName: name,
      workspaceRepositoryUrl: url,
      formatVersion: 3,
      desiredSha: options.desiredSha ?? sha,
      desiredDefaultBranch: "main",
      hydrateStatus: "ready",
      ...(graph
        ? {
            activeRevision: revision,
            activeProjectionUrl: url,
            activeProjectionSha: sha,
            indexedSha: sha,
            hydratePhases: {
              url,
              sha,
              revision,
              embeddings: !embeddingError,
              ...(embeddingError ? { embeddingError } : {}),
              graph: {
                revision,
                result: graph,
                ...(graph.kind === "failed"
                  ? {
                      failure: {
                        message: graph.message,
                        at: "2026-10-30T08:15:00.000Z",
                      },
                    }
                  : {}),
              },
              index: {
                revision,
                result: options.index ?? { kind: "ready" as const },
              },
            },
          }
        : {}),
    }),
  )
  return revision
}

async function hydrateRuns(workspaceId: string) {
  const result = await getSystemDb().execute<{
    input: { revision: WorkspaceRevision }
    idempotency_key: string | null
  }>(sql`
    select input, idempotency_key from openworkflow.workflow_runs
    where workflow_name = 'workspace-hydrate'
      and input->>'workspaceId' = ${workspaceId}
  `)
  return result.rows
}

async function workspaceRow(workspaceId: string) {
  const [row] = await withOrgDbContext(org.id, (db) =>
    db
      .select({
        hydratePhases: workspaces.hydratePhases,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
  )
  return row
}

async function graphPhase(workspaceId: string) {
  const [row] = await withOrgDbContext(org.id, (db) =>
    db
      .select({ hydratePhases: workspaces.hydratePhases })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
  )
  return row?.hydratePhases?.graph
}

function rebuild(slug: string) {
  return withOrgDbContext(org.id, async () =>
    app().request(`/workspaces/${slug}/rebuild-graph`, { method: "POST" }),
  )
}

describe("Rebuild of a failed Workspace graph (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'workspaceId' like ${`%_${suffix}`}`,
    )
    await withOrgDbContext(org.id, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, org.id)),
    )
    await closeDb()
  })

  it("queues one graph-only hydrate of the active revision for a failed graph", async () => {
    const revision = await seedWorkspace("failed", {
      kind: "failed",
      message: "graph store unavailable",
    })

    const response = await rebuild("failed")

    expect(response.status).toBe(202)
    const runs = await hydrateRuns(revision.workspaceId)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.input.revision).toEqual(revision)
    // The pane shows the graph as building; the first failure time stays.
    expect(await graphPhase(revision.workspaceId)).toEqual({
      revision,
      result: { kind: "pending" },
      failure: {
        message: "graph store unavailable",
        at: "2026-10-30T08:15:00.000Z",
      },
    })
  })

  it("starts at most one rebuild in each UTC hour", async () => {
    // Both requests fall in the same UTC hour. Only `Date` is fake: the
    // database client needs real timers.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 60_000)
    const revision = await seedWorkspace("twice", {
      kind: "failed",
      message: "graph store unavailable",
    })
    expect((await rebuild("twice")).status).toBe(202)
    // The run of the first request fails again before the second request.
    await getSystemDb().execute(
      sql`update openworkflow.workflow_runs set status = 'completed'
          where input->>'workspaceId' = ${revision.workspaceId}`,
    )
    await withOrgDbContext(org.id, (db) =>
      db
        .update(workspaces)
        .set({
          hydratePhases: sql`jsonb_set(${workspaces.hydratePhases}, '{graph,result}', '{"kind":"failed","message":"graph store unavailable"}'::jsonb)`,
        })
        .where(eq(workspaces.id, revision.workspaceId)),
    )

    const second = await rebuild("twice")

    expect(second.status).toBe(409)
    expect(await second.json()).toHaveProperty("error")
    expect(await hydrateRuns(revision.workspaceId)).toHaveLength(1)
    expect((await graphPhase(revision.workspaceId))?.result).toEqual({
      kind: "failed",
      message: "graph store unavailable",
    })
  })

  it.each([
    ["ready", { kind: "ready" } as const],
    ["pending", { kind: "pending" } as const],
    ["absent", null],
  ])("refuses a graph that is %s and queues no run", async (name, graph) => {
    const revision = await seedWorkspace(name, graph)

    const response = await rebuild(name)

    expect(response.status).toBe(409)
    expect(await response.json()).toHaveProperty("error")
    expect(await hydrateRuns(revision.workspaceId)).toHaveLength(0)
  })

  // A hydrate also embeds when the embeddings are not ready, and embeddings
  // call a paid model. The action writes only the graph.
  // The hydrate also queues an index run when the index is not ready. While
  // a newer commit builds, the hydrate discards a run of the active revision.
  it.each([
    ["embeddings-failed", { embeddingError: "embedding provider unavailable" }],
    [
      "index-failed",
      { index: { kind: "failed", message: "index unavailable" } as const },
    ],
    ["newer-commit", { desiredSha: "d".repeat(40) }],
  ])(
    "refuses a failed graph of %s and queues no run",
    async (name, options) => {
      const revision = await seedWorkspace(
        name,
        { kind: "failed", message: "graph store unavailable" },
        options,
      )

      const response = await rebuild(name)

      expect(response.status).toBe(409)
      expect(await response.json()).toHaveProperty("error")
      expect(await hydrateRuns(revision.workspaceId)).toHaveLength(0)
    },
  )

  // The queued run can start and fail again before the route marks the
  // phase. The mark must not hide that newer result.
  it("does not set a newer graph result back to pending", async () => {
    const revision = await seedWorkspace("raced", {
      kind: "failed",
      message: "graph store unavailable",
    })
    const read = await workspaceRow(revision.workspaceId)
    await withOrgDbContext(org.id, () =>
      persistWorkspaceGraphResult({
        revision,
        result: { kind: "failed", message: "graph store still unavailable" },
      }),
    )

    await withOrgDbContext(org.id, () =>
      markWorkspaceGraphRetry(revision, read?.updatedAt ?? new Date(0)),
    )

    expect((await graphPhase(revision.workspaceId))?.result).toEqual({
      kind: "failed",
      message: "graph store still unavailable",
    })
  })

  it("gives 404 for a Workspace that does not exist", async () => {
    expect((await rebuild("missing")).status).toBe(404)
  })
})
