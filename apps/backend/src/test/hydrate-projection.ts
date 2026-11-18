import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { asc, eq, sql } from "drizzle-orm"
import { FalkorDB } from "falkordb"
import { expect } from "vitest"

import { withOrgIdContext } from "../auth/withAuth.js"
import { withOrgDbContext } from "../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
} from "../db/schema/workspaces.js"
import { workspaceGraphKey } from "../domain/workspaces/graph-projection.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import {
  getWorkspaceProjection,
  persistWorkspaceIndexResult,
} from "../models/workspaces.js"
import { workspaceHydrate } from "../openworkflow/workflows/workspace-hydrate.js"
import type { NativeHydrationFixture } from "./native-hydration-fixture.js"

/*
 * Helpers for the contract tests of the partial hydrate: commit a change to
 * the fixture repository, run a hydrate, and read everything that a hydrate
 * wrote for the active projection.
 */

export type Change = { write?: Record<string, string>; remove?: string[] }

/** Commit `change` on the fixture branch, push it, and capture the new tip. */
export async function commit(f: NativeHydrationFixture, change: Change) {
  // The fixture puts uncommitted text in the work tree.
  f.git("checkout", "--", ".")
  for (const [path, body] of Object.entries(change.write ?? {})) {
    mkdirSync(dirname(join(f.directory, path)), { recursive: true })
    writeFileSync(join(f.directory, path), body)
  }
  for (const path of change.remove ?? []) rmSync(join(f.directory, path))
  f.git("add", "-A")
  f.git("commit", "-q", "-m", "Change")
  f.git("push", "-q", f.remote, "HEAD:refs/heads/main")
  return f.git("rev-parse", "HEAD")
}

export type HydrateResult = {
  hydrated: boolean
  reason?: string
  writes?: Record<string, unknown>
}

export async function hydrate(
  f: NativeHydrationFixture,
  options: { revision?: WorkspaceRevision; reproject?: true } = {},
): Promise<HydrateResult> {
  const handle = await f.runner.runWorkflow(workspaceHydrate.spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    revision: options.revision ?? (await f.resolveRevision()),
    ...(options.reproject ? { reproject: true as const } : {}),
  })
  return (await handle.result({ timeoutMs: 60_000 })) as HydrateResult
}

/** Count the texts that go to the embedding model. */
export function countEmbeddings(f: NativeHydrationFixture) {
  const texts: string[] = []
  f.server.events.on("request:start", async ({ request }) => {
    if (!request.url.endsWith("/v1/embeddings")) return
    const body = (await request.clone().json()) as { input: string[] }
    texts.push(...body.input)
  })
  return texts
}

/**
 * Everything that a hydrate writes for the active projection: the unit
 * rows, the chunk rows with their embeddings, and the graph with its marker.
 * `created_at` and the SHA of each row are not part of it (a partial write
 * keeps both on an unchanged row).
 */
export async function projected(f: NativeHydrationFixture) {
  const revision = await withOrgIdContext(f.org, async () => {
    const projection = await getWorkspaceProjection(f.workspaceId)
    if (projection.kind !== "active") throw new Error("Expected a projection")
    return projection.revision
  })
  const { units, chunks } = await withOrgDbContext(f.org.id, async (db) => ({
    units: await db
      .select({
        servingId: workspaceKnowledgeUnits.servingId,
        path: workspaceKnowledgeUnits.path,
        kind: workspaceKnowledgeUnits.kind,
        title: workspaceKnowledgeUnits.title,
        source: workspaceKnowledgeUnits.source,
        body: workspaceKnowledgeUnits.body,
        links: workspaceKnowledgeUnits.links,
        claims: workspaceKnowledgeUnits.claims,
        updatedAt: workspaceKnowledgeUnits.updatedAt,
        unitHash: workspaceKnowledgeUnits.unitHash,
      })
      .from(workspaceKnowledgeUnits)
      .where(eq(workspaceKnowledgeUnits.workspaceId, f.workspaceId))
      .orderBy(asc(workspaceKnowledgeUnits.path)),
    chunks: await db
      .select({
        unitId: workspaceKnowledgeChunks.unitId,
        chunkHash: workspaceKnowledgeChunks.chunkHash,
        occurrence: workspaceKnowledgeChunks.occurrence,
        ordinal: workspaceKnowledgeChunks.ordinal,
        startLine: workspaceKnowledgeChunks.startLine,
        endLine: workspaceKnowledgeChunks.endLine,
        text: workspaceKnowledgeChunks.text,
        embedding: sql<
          string | null
        >`${workspaceKnowledgeChunks.embedding}::text`,
      })
      .from(workspaceKnowledgeChunks)
      .where(eq(workspaceKnowledgeChunks.workspaceId, f.workspaceId))
      .orderBy(
        asc(workspaceKnowledgeChunks.unitId),
        asc(workspaceKnowledgeChunks.ordinal),
      ),
  }))
  return { revision, units, chunks, graph: await graphOf(f, revision) }
}

async function graphOf(f: NativeHydrationFixture, revision: WorkspaceRevision) {
  const falkor = await FalkorDB.connect({ url: process.env.GRAPH_DB_URI })
  try {
    const graph = falkor.selectGraph(f.org.id)
    const params = { key: workspaceGraphKey(revision) }
    const [nodes, edges, marker] = await Promise.all([
      graph.query(
        `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $key})
        RETURN n.id AS id, n.workspaceId AS workspaceId, n.kind AS kind, n.name AS name, n.summary AS summary, n.path AS path,
          n.outDegree AS outDegree, n.inDegree AS inDegree, n.degree AS degree ORDER BY n.id`,
        { params },
      ),
      graph.query(
        `MATCH (s:WorkspaceKnowledgeUnit {projectionKey: $key})-[r:WorkspaceSignal {projectionKey: $key}]->(t:WorkspaceKnowledgeUnit {projectionKey: $key})
        RETURN r.id AS id, s.id AS subject, t.id AS object, r.predicate AS predicate, r.confidence AS confidence,
          r.validFrom AS validFrom, r.validTo AS validTo, r.source AS source, r.lastObservedAt AS lastObservedAt ORDER BY r.id`,
        { params },
      ),
      graph.query(
        `MATCH (p:WorkspaceProjection {projectionKey: $key})
        RETURN p.revision AS revision, p.nodeCount AS nodeCount, p.claimCount AS claimCount, p.completedAt IS NOT NULL AS complete`,
        { params },
      ),
    ])
    return {
      nodes: nodes.data ?? [],
      edges: edges.data ?? [],
      marker: marker.data ?? [],
    }
  } finally {
    await falkor.close()
  }
}

/** Set the index of the active projection ready, as `f.publish` does. */
export async function settleIndex(f: NativeHydrationFixture) {
  await withOrgIdContext(f.org, async () => {
    const active = await getWorkspaceProjection(f.workspaceId)
    if (active.kind === "active")
      await persistWorkspaceIndexResult({
        revision: active.revision,
        result: { kind: "ready" },
      })
  })
}

/**
 * Hydrate the tip partially, then fully (`reproject`), and expect the same
 * projection from both.
 */
export async function expectPartialEqualsFull(
  f: NativeHydrationFixture,
  partial: HydrateResult,
  graphMode: "partial" | "full" = "partial",
) {
  expect(partial).toMatchObject({
    hydrated: true,
    writes: { mode: "partial", graphMode },
  })
  const afterPartial = await projected(f)
  const full = await hydrate(f, { reproject: true })
  expect(full).toMatchObject({
    hydrated: true,
    writes: { mode: "full", fullReason: "reproject", graphMode: "full" },
  })
  const afterFull = await projected(f)
  expect(afterPartial.revision.sha).toBe(f.git("rev-parse", "HEAD"))
  expect(afterPartial).toEqual(afterFull)
  expect(afterPartial.graph.marker).toMatchObject([
    {
      nodeCount: afterPartial.graph.nodes.length,
      claimCount: afterPartial.graph.edges.length,
      complete: true,
    },
  ])
  // Each chunk keeps or copies an embedding.
  expect(afterPartial.chunks.every((chunk) => chunk.embedding !== null)).toBe(
    true,
  )
  return afterPartial
}
