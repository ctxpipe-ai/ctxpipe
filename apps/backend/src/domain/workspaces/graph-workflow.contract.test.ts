import { rename, unlink, writeFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { FalkorDB } from "falkordb"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb } from "../../db/client.js"
import {
  captureWorkspaceRevision,
  getWorkspaceProjection,
  getWorkspaceProjectionSnapshot,
  persistWorkspaceGraphResult,
} from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import {
  closeGraphDb,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import { workspaceGraphRoutes } from "../../routes/v1/workspace-graph-routes.js"
import {
  type NativeHydrationFixture,
  type NativeHydrationOptions,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"

async function withGraphHydration(
  options: NativeHydrationOptions,
  run: (
    fixture: NativeHydrationFixture,
    graph: ReturnType<FalkorDB["selectGraph"]>,
    graphDb: FalkorDB,
  ) => Promise<void>,
) {
  if (!process.env.GRAPH_DB_URI)
    throw new Error("GRAPH_DB_URI is required for native graph proof")
  const graphDb = await FalkorDB.connect({ url: process.env.GRAPH_DB_URI })
  try {
    await withNativeHydrationFixture(options, async (f) => {
      try {
        await run(f, graphDb.selectGraph(f.org.id), graphDb)
      } finally {
        if ((await graphDb.list()).includes(f.org.id))
          await graphDb.selectGraph(f.org.id).delete()
      }
    })
  } finally {
    await graphDb.close()
  }
}

it(
  "hydrate publishes its complete revision graph to FalkorDB",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, graph) => {
      await f.publish()
      const projection = await withOrgIdContext(f.org, () =>
        getWorkspaceProjection(f.workspaceId),
      )
      const nodes = await graph.query(
        "MATCH (n:WorkspaceKnowledgeUnit) RETURN n.name AS name ORDER BY name",
      )
      expect({ projection, nodes: nodes.data }).toMatchObject({
        projection: { kind: "active", stores: { graph: { kind: "ready" } } },
        nodes: [{ name: "document-000" }],
      })
    })
  },
)

it(
  "hydrate projects resolved markdown links as Falkor graph edges",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration(
      {
        files: [
          {
            path: "first.md",
            body: "# First\n[second](second.md)\n[missing](missing.md)\n",
          },
          { path: "second.md", body: "# Second\n" },
        ],
      },
      async (f, graph) => {
        await f.publish()
        const edges = await graph.query(
          "MATCH (s:WorkspaceKnowledgeUnit)-[r:WorkspaceSignal]->(t:WorkspaceKnowledgeUnit) RETURN s.name AS source, t.name AS target, r.predicate AS predicate ORDER BY source, target",
        )
        expect(edges.data).toEqual([
          { source: "first", target: "second", predicate: "LINKS_TO" },
        ])
      },
    )
  },
)

it(
  "hydrate preserves declared claims alongside permanent body links in FalkorDB",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration(
      {
        files: [
          {
            path: "first.md",
            body: "---\nclaims:\n  - to: second.md\n    predicate: DEPENDS_ON\n    confidence: 0.7\n    valid_from: '2020-01-01T00:00:00.000Z'\n    valid_to: '2030-01-01T00:00:00.000Z'\n---\n# First\nSee [Second](second.md).\n",
          },
          { path: "second.md", body: "# Second\n" },
        ],
      },
      async (f, graph) => {
        await f.publish()
        const edges = await graph.query(
          "MATCH (:WorkspaceKnowledgeUnit)-[r:WorkspaceSignal]->(:WorkspaceKnowledgeUnit) RETURN r.predicate AS predicate, r.confidence AS confidence, r.validFrom AS validFrom, r.validTo AS validTo ORDER BY predicate",
        )
        expect(edges.data).toEqual([
          {
            predicate: "DEPENDS_ON",
            confidence: 0.7,
            validFrom: "2020-01-01T00:00:00.000Z",
            validTo: "2030-01-01T00:00:00.000Z",
          },
          {
            predicate: "LINKS_TO",
            confidence: 1,
            validFrom: null,
            validTo: null,
          },
        ])
      },
    )
  },
)

it(
  "Graph HTTP reports an unavailable derived graph instead of rebuilding it from Postgres",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, graph) => {
      await f.publish()
      await graph.delete()
      const response = await workspaceHttpApp(
        f.org,
        workspaceGraphRoutes,
      ).request("/workspaces/knowledge/graph")
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 503,
        body: { error: "Workspace graph projection is unavailable." },
      })
    })
  },
)

it(
  "chat graph reads report missing Falkor data for their captured revision",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, graph) => {
      await f.publish()
      const snapshot = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      const tools = await workspaceChatTools({
        orgId: f.org.id,
        orgSlug: f.org.slug,
        workspaceId: f.workspaceId,
        snapshot,
      })
      const lookup = tools.find((tool) => tool.name === "graph_lookup")
      if (!lookup) throw new Error("Missing graph lookup tool")
      await graph.delete()
      await expect(
        lookup.execute({ nodeId: snapshot.units[0]?.servingId }),
      ).rejects.toThrow("Workspace graph projection is unavailable.")
    })
  },
)

async function withGraphWriteDenied(
  f: NativeHydrationFixture,
  db: FalkorDB,
  run: () => Promise<void>,
  denyWrites = true,
) {
  const connection = await db.connection
  const user = `denied_${f.id}`
  const saved = {
    GRAPH_DB_USER: process.env.GRAPH_DB_USER,
    GRAPH_DB_PASSWORD: process.env.GRAPH_DB_PASSWORD,
  }
  await connection.sendCommand([
    "ACL",
    "SETUSER",
    user,
    "on",
    ">fixture-only-graph-password",
    "~*",
    "+@all",
    ...(denyWrites ? ["-graph.query"] : []),
  ])
  await closeGraphDb()
  Object.assign(process.env, {
    GRAPH_DB_USER: user,
    GRAPH_DB_PASSWORD: "fixture-only-graph-password",
  })
  try {
    await run()
  } finally {
    await closeGraphDb()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await connection.sendCommand(["CLIENT", "KILL", "USER", user])
    await connection.sendCommand(["ACL", "DELUSER", user])
  }
}

it(
  "a native graph write failure leaves Postgres active and graph freshness failed",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, _graph, db) => {
      await withGraphWriteDenied(f, db, () => f.publish())
      const projection = await withOrgIdContext(f.org, () =>
        getWorkspaceProjection(f.workspaceId),
      )
      expect(projection).toMatchObject({
        kind: "active",
        stores: { graph: { kind: "failed" }, embeddings: { kind: "ready" } },
      })
    })
  },
)

it(
  "retries a failed graph from Postgres after the Git remote disappears",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, graph, db) => {
      await withGraphWriteDenied(f, db, () => f.publish())
      await rename(f.remote, `${f.remote}-unavailable`)
      const failed = await withOrgIdContext(f.org, () =>
        getWorkspaceProjection(f.workspaceId),
      )
      if (failed.kind !== "active" || failed.stores.graph.kind !== "failed")
        throw new Error("Fixture graph did not fail")
      const run = await f.runner.runWorkflow(workspaceHydrate.spec, {
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        revision: failed.revision,
      })
      await run.result({ timeoutMs: 30_000 })
      const projection = await withOrgIdContext(f.org, () =>
        getWorkspaceProjection(f.workspaceId),
      )
      const result = await graph.query(
        "MATCH (n:WorkspaceKnowledgeUnit) RETURN n.name AS name",
      )
      expect({ projection, nodes: result.data }).toMatchObject({
        projection: { kind: "active", stores: { graph: { kind: "ready" } } },
        nodes: [{ name: "document-000" }],
      })
    })
  },
)

it(
  "Graph HTTP serves the completed native graph and its publication time",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration(
      {
        files: [
          { path: "first.md", body: "# First\n[second](second.md)\n" },
          { path: "second.md", body: "# Second\n" },
        ],
      },
      async (f) => {
        await f.publish()
        const response = await workspaceHttpApp(
          f.org,
          workspaceGraphRoutes,
        ).request("/workspaces/knowledge/graph")
        const body = await response.json()
        expect({
          status: response.status,
          metrics: body.metrics,
          names: body.nodes.map((node: { name: string }) => node.name).sort(),
          predicates: body.edges.map(
            (edge: { predicate: string }) => edge.predicate,
          ),
        }).toEqual({
          status: 200,
          metrics: {
            totalNodes: 2,
            totalEdges: 1,
            nodesReturned: 2,
            edgesReturned: 1,
            truncated: false,
            lastUpdatedAt: expect.any(String),
          },
          names: ["first", "second"],
          predicates: ["LINKS_TO"],
        })
      },
    )
  },
)

it(
  "Graph HTTP omits expired signals at read time",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration(
      {
        files: [
          {
            path: "first.md",
            body: "---\nclaims:\n  - to: second.md\n    predicate: DEPENDS_ON\n    confidence: 0.7\n    valid_from: '1990-01-01T00:00:00.000Z'\n    valid_to: '2000-01-01T00:00:00.000Z'\n---\n# First\n",
          },
          { path: "second.md", body: "# Second\n" },
        ],
      },
      async (f) => {
        await f.publish()
        const response = await workspaceHttpApp(
          f.org,
          workspaceGraphRoutes,
        ).request("/workspaces/knowledge/graph")
        expect({
          status: response.status,
          body: await response.json(),
        }).toMatchObject({
          status: 200,
          body: { metrics: { totalNodes: 2, totalEdges: 0 }, edges: [] },
        })
      },
    )
  },
)

it(
  "Graph HTTP serves a completed empty graph as empty",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({ count: 0 }, async (f) => {
      await f.publish()
      const response = await workspaceHttpApp(
        f.org,
        workspaceGraphRoutes,
      ).request("/workspaces/knowledge/graph")
      expect({
        status: response.status,
        body: await response.json(),
      }).toMatchObject({
        status: 200,
        body: {
          metrics: {
            totalNodes: 0,
            totalEdges: 0,
            nodesReturned: 0,
            edgesReturned: 0,
            truncated: false,
          },
          nodes: [],
          edges: [],
        },
      })
    })
  },
)

it(
  "parallel graph requests share one connection and release it on shutdown",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, _graph, db) => {
      await withGraphWriteDenied(
        f,
        db,
        async () => {
          await Promise.all(
            Array.from({ length: 12 }, () =>
              withGraphClient({ orgId: f.org.id, orgSlug: f.org.slug }, () =>
                getGraphClient().executeQuery("RETURN 1 AS ready"),
              ),
            ),
          )
          const connection = await db.connection
          const connected = String(
            await connection.sendCommand(["CLIENT", "LIST"]),
          )
            .split("\n")
            .filter((line) => line.includes(`user=denied_${f.id} `)).length
          await closeGraphDb()
          expect(connected).toBe(1)
          await expect
            .poll(
              async () =>
                String(await connection.sendCommand(["CLIENT", "LIST"]))
                  .split("\n")
                  .filter((line) => line.includes(`user=denied_${f.id} `))
                  .length,
            )
            .toBe(0)
        },
        false,
      )
    })
  },
)

it(
  "cron retries failed graph freshness at an unchanged fully indexed SHA",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, _graph, db) => {
      await withGraphWriteDenied(f, db, () => f.publish())
      const run = await f.runner.runWorkflow(workspaceTipCheck.spec, {
        orgId: f.org.id,
      })
      await run.result({ timeoutMs: 30_000 })
      const queued = await getSystemDb().execute<{
        input: { revision?: { sha: string } }
      }>(sql`
      select input from openworkflow.workflow_runs where workflow_name = 'workspace-hydrate'
      and input->>'workspaceId' = ${f.workspaceId} and namespace_id <> ${f.id}
    `)
      expect(queued.rows.map((row) => row.input.revision?.sha)).toEqual([f.sha])
    })
  },
)

it(
  "a graph connection outage fails only graph freshness and can recover",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f) => {
      const uri = process.env.GRAPH_DB_URI
      await closeGraphDb()
      process.env.GRAPH_DB_URI = "redis://127.0.0.1:6399"
      try {
        await f.publish()
        expect(
          await withOrgIdContext(f.org, () =>
            getWorkspaceProjection(f.workspaceId),
          ),
        ).toMatchObject({
          kind: "active",
          stores: { graph: { kind: "failed" }, embeddings: { kind: "ready" } },
        })
      } finally {
        await closeGraphDb()
        process.env.GRAPH_DB_URI = uri
      }
      const active = await withOrgIdContext(f.org, () =>
        getWorkspaceProjection(f.workspaceId),
      )
      if (active.kind !== "active")
        throw new Error("Expected active Postgres revision")
      const retry = await f.runner.runWorkflow(workspaceHydrate.spec, {
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        revision: active.revision,
      })
      await retry.result({ timeoutMs: 30_000 })
      expect(
        await withOrgIdContext(f.org, () =>
          getWorkspaceProjection(f.workspaceId),
        ),
      ).toMatchObject({ kind: "active", stores: { graph: { kind: "ready" } } })
    })
  },
)

async function replaceGraphRevision(f: NativeHydrationFixture) {
  await unlink(`${f.directory}/document-000.md`)
  await writeFile(`${f.directory}/replacement.md`, "# Replacement node\n")
  f.git("add", "--", "document-000.md", "replacement.md")
  f.git(
    "-c",
    "user.name=Contract",
    "-c",
    "user.email=contract@example.test",
    "commit",
    "-m",
    "Replace graph document",
  )
  const sha = f.git("rev-parse", "HEAD")
  f.git("push", f.remote, "HEAD:main")
  const revision = await withOrgIdContext(f.org, () =>
    captureWorkspaceRevision({
      workspaceId: f.workspaceId,
      expected: {
        generation: 1,
        url: f.workspaceUrl,
        sha: f.sha,
        defaultBranch: "main",
        githubConnectionId: null,
      },
      tip: { sha, branch: "main" },
    }),
  )
  if (!revision)
    throw new Error("Failed to capture replacement fixture revision")
  const handle = await f.runner.runWorkflow(workspaceHydrate.spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    revision,
  })
  await handle.result({ timeoutMs: 30_000 })
  return revision
}

it(
  "active Graph HTTP omits documents deleted in a newer revision",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f) => {
      await f.publish()
      await replaceGraphRevision(f)
      const response = await workspaceHttpApp(
        f.org,
        workspaceGraphRoutes,
      ).request("/workspaces/knowledge/graph")
      const body = await response.json()
      expect({
        status: response.status,
        names: body.nodes.map((n: { name: string }) => n.name),
      }).toEqual({ status: 200, names: ["replacement"] })
    })
  },
)

it(
  "captured chat graph keeps its revision after a replacement is published",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f) => {
      await f.publish()
      const snapshot = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      const tools = await workspaceChatTools({
        orgId: f.org.id,
        orgSlug: f.org.slug,
        workspaceId: f.workspaceId,
        snapshot,
      })
      await replaceGraphRevision(f)
      expect(
        String(
          await tools
            .find((t) => t.name === "graph_lookup")
            ?.execute({ nodeId: snapshot.units[0]?.servingId }),
        ),
      ).toContain("# Document 0")
      const fresh = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      const nextTools = await workspaceChatTools({
        orgId: f.org.id,
        orgSlug: f.org.slug,
        workspaceId: f.workspaceId,
        snapshot: fresh,
      })
      expect(
        String(
          await nextTools
            .find((t) => t.name === "graph_lookup")
            ?.execute({ nodeId: fresh.units[0]?.servingId }),
        ),
      ).toContain("# Replacement node")
    })
  },
)

it(
  "a stale graph failure cannot alter the newer active graph freshness",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f) => {
      await f.publish()
      const first = await withOrgIdContext(f.org, () =>
        getWorkspaceProjection(f.workspaceId),
      )
      if (first.kind !== "active") throw new Error("Expected first revision")
      const next = await replaceGraphRevision(f)
      const accepted = await withOrgIdContext(f.org, () =>
        persistWorkspaceGraphResult({
          revision: first.revision,
          result: { kind: "failed", message: "late first revision failure" },
        }),
      )
      expect({
        accepted,
        projection: await withOrgIdContext(f.org, () =>
          getWorkspaceProjection(f.workspaceId),
        ),
      }).toMatchObject({
        accepted: false,
        projection: {
          kind: "active",
          revision: next,
          stores: { graph: { kind: "ready" } },
        },
      })
    })
  },
)

it(
  "chat graph neighbors traverse native edges in either direction",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration(
      {
        files: [
          { path: "first.md", body: "# First\n[second](second.md)\n" },
          { path: "second.md", body: "# Second\n" },
        ],
      },
      async (f) => {
        await f.publish()
        const snapshot = await withOrgIdContext(f.org, () =>
          getWorkspaceProjectionSnapshot(f.workspaceId),
        )
        const tools = await workspaceChatTools({
          orgId: f.org.id,
          orgSlug: f.org.slug,
          workspaceId: f.workspaceId,
          snapshot,
        })
        const neighbors = tools.find((t) => t.name === "graph_neighbors")
        const first = snapshot.units.find((u) => u.path === "first.md")
        const second = snapshot.units.find((u) => u.path === "second.md")
        expect(
          String(await neighbors?.execute({ nodeId: first?.servingId })),
        ).toContain("# Second")
        expect(
          String(await neighbors?.execute({ nodeId: second?.servingId })),
        ).toContain("# First")
      },
    )
  },
)

it(
  "chat graph lookup and neighbors exclude unknown nodes",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f) => {
      await f.publish()
      const snapshot = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      const tools = await workspaceChatTools({
        orgId: f.org.id,
        orgSlug: f.org.slug,
        workspaceId: f.workspaceId,
        snapshot,
      })
      expect(
        String(
          await tools
            .find((t) => t.name === "graph_lookup")
            ?.execute({ nodeId: "kn_foreign" }),
        ),
      ).toContain("null")
      expect(
        String(
          await tools
            .find((t) => t.name === "graph_neighbors")
            ?.execute({ nodeId: "kn_foreign" }),
        ),
      ).not.toContain("# Document")
    })
  },
)

it(
  "Graph HTTP rejects incomplete native data even when a completion marker exists",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, graph) => {
      await f.publish()
      await graph.query("MATCH (n:WorkspaceKnowledgeUnit) DETACH DELETE n")
      const response = await workspaceHttpApp(
        f.org,
        workspaceGraphRoutes,
      ).request("/workspaces/knowledge/graph")
      expect(response.status).toBe(503)
    })
  },
)

it(
  "a lost shared graph connection is replaced for the next request",
  { timeout: 60_000 },
  async () => {
    await withGraphHydration({}, async (f, _graph, db) => {
      await withGraphWriteDenied(
        f,
        db,
        async () => {
          await withGraphClient({ orgId: f.org.id, orgSlug: f.org.slug }, () =>
            getGraphClient().executeQuery("RETURN 1 AS ready"),
          )
          await (await db.connection).sendCommand([
            "CLIENT",
            "KILL",
            "USER",
            `denied_${f.id}`,
          ])
          await expect
            .poll(
              async () => {
                try {
                  const result = await withGraphClient(
                    { orgId: f.org.id, orgSlug: f.org.slug },
                    () => getGraphClient().executeQuery("RETURN 1 AS ready"),
                  )
                  return result.records[0]?.get("ready")
                } catch {
                  return null
                }
              },
              { timeout: 3_000 },
            )
            .toBe(1)
        },
        false,
      )
    })
  },
)
