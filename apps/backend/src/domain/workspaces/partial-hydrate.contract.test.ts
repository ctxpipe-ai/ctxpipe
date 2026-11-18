import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { asc, eq, sql } from "drizzle-orm"
import { FalkorDB } from "falkordb"
import { expect, it, vi } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import {
  commitHydrateProjection,
  embedKnowledgeChunks,
  getWorkspaceProjection,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { closeGraphDb } from "../../platform/graph/client.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { workspaceGraphKey } from "./graph-projection.js"
import { hydrateKnowledgeTree } from "./hydrate.js"
import type { WorkspaceRevision } from "./revision.js"
import { workspaceFormatFile } from "./workspace-format.js"

// 24 units: a partial write takes at most 3 changed or removed units
// (`partialUnitBound`). Each unit links to the next one, doc-00 links to a
// file that the "add" commit makes, and doc-03 has a claim on doc-05.
const files = Array.from({ length: 24 }, (_, index) => {
  const name = (n: number) => `doc-${String(n).padStart(2, "0")}.md`
  const front =
    index === 3
      ? "---\nclaims:\n  - to: doc-05.md\n    predicate: DEPENDS_ON\n    confidence: 0.7\n---\n"
      : ""
  const extra = index === 0 ? "Read [the new file](new.md) too.\n" : ""
  return {
    path: name(index),
    body: `${front}# Doc ${index}\nSee [the next doc](${name((index + 1) % 24)}).\n${extra}\n## Part ${index}\nText of part ${index}.\n`,
  }
})

type Change = { write?: Record<string, string>; remove?: string[] }

/** Commit `change` on the fixture branch, push it, and capture the new tip. */
async function commit(f: NativeHydrationFixture, change: Change) {
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

type HydrateResult = {
  hydrated: boolean
  reason?: string
  writes?: Record<string, unknown>
}

async function hydrate(
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
function countEmbeddings(f: NativeHydrationFixture) {
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
async function projected(f: NativeHydrationFixture) {
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
async function settleIndex(f: NativeHydrationFixture) {
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
async function expectPartialEqualsFull(
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

const changes: Array<{ name: string; change: Change; written: number }> = [
  {
    name: "an added file",
    change: { write: { "new.md": "# New\nBack to [doc 1](doc-01.md).\n" } },
    written: 1,
  },
  {
    name: "a modified file",
    change: {
      write: {
        "doc-05.md":
          "---\nclaims:\n  - to: doc-07.md\n    predicate: SUPERSEDES\n---\n# Doc 5\nNew text that links to [doc 9](doc-09.md).\n\n## Part 5\nText of part 5.\n",
      },
    },
    written: 1,
  },
  {
    name: "a renamed file",
    change: {
      write: {
        "moved/doc-07.md":
          files[7]?.body.replace("(doc-08.md)", "(../doc-08.md)") ?? "",
      },
      remove: ["doc-07.md"],
    },
    written: 1,
  },
  {
    name: "a deleted file",
    change: { remove: ["doc-09.md"] },
    written: 0,
  },
]

it.each(changes)(
  "a partial hydrate of $name gives the projection of a full hydrate",
  { timeout: 180_000 },
  async ({ change, written }) =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      // The first hydrate has no projection to start from.
      expect(await f.handle.result()).toMatchObject({
        writes: {
          mode: "full",
          fullReason: "no_base",
          filesParsed: 24,
          unitRowsWritten: 24,
          graphMode: "full",
        },
      })
      const embedded = countEmbeddings(f)
      await commit(f, change)
      await f.resolveRevision(true)
      const partial = await hydrate(f)
      expect(partial.writes).toMatchObject({
        unitRowsWritten: written,
        unitRowsDeleted: change.remove?.length ?? 0,
        embeddingTexts: embedded.length,
      })
      // Only the texts of the changed file go to the model.
      expect(embedded.length).toBeLessThanOrEqual(written * 2)
      await expectPartialEqualsFull(f, partial)
    }),
)

it(
  "a run of the last trigger after three commits hydrates the tip once, as a full hydrate does",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      // Three commits; only the webhook of the last one arrives.
      await commit(f, {
        write: { "new.md": "# New\nSee [doc 2](doc-02.md).\n" },
      })
      await commit(f, {
        write: { "doc-04.md": "# Doc 4\nA new body.\n\n## Part 4\nMore.\n" },
      })
      await commit(f, { remove: ["doc-11.md"] })
      await f.resolveRevision(true)
      const partial = await hydrate(f)
      expect(partial.writes).toMatchObject({
        unitRowsWritten: 2,
        unitRowsDeleted: 1,
      })
      await expectPartialEqualsFull(f, partial)
    }),
)

it(
  "two triggers in quick succession give one hydrate of the tip, also when one trigger names an older SHA",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      const older = await f.resolveRevision()
      const tip = await commit(f, {
        write: { "doc-02.md": "# Doc 2\nChanged.\n" },
      })
      const current = await f.resolveRevision(true)
      expect(current.sha).toBe(tip)
      // Both runs start at once: the run of the older SHA hydrates the tip.
      const [first, second] = await Promise.all([
        f.runner.runWorkflow(workspaceHydrate.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision: older,
        }),
        f.runner.runWorkflow(workspaceHydrate.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision: current,
        }),
      ])
      const results = (await Promise.all([
        first.result({ timeoutMs: 60_000 }),
        second.result({ timeoutMs: 60_000 }),
      ])) as HydrateResult[]
      expect(results.filter((result) => result.hydrated)).toHaveLength(1)
      // The other run waits for the lock, then finds the tip hydrated: it
      // writes nothing (only the index of the new tip can still be due).
      const other = results.find((result) => !result.hydrated)
      expect(["noop", "index_lag"]).toContain(other?.reason)
      expect((await projected(f)).revision.sha).toBe(tip)
    }),
)

it(
  "a queued run whose target is already hydrated ends with no work, also when it names an older SHA",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      const older = await f.resolveRevision()
      await commit(f, { write: { "doc-02.md": "# Doc 2\nChanged.\n" } })
      await f.resolveRevision(true)
      expect(await hydrate(f)).toMatchObject({ hydrated: true })
      await settleIndex(f)
      const embedded = countEmbeddings(f)
      expect(await hydrate(f, { revision: older })).toEqual({
        hydrated: false,
        reason: "noop",
      })
      expect(await hydrate(f)).toEqual({ hydrated: false, reason: "noop" })
      expect(embedded).toEqual([])
    }),
)

it(
  "a failed graph write leaves the graph base unchanged, and the next run gives the projection of a full hydrate",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      const base = (await projected(f)).graph.marker
      await commit(f, { write: { "doc-02.md": "# Doc 2\nChanged.\n" } })
      await f.resolveRevision(true)
      // The graph store refuses each connection during this run.
      vi.stubEnv("GRAPH_DB_URI", "redis://127.0.0.1:1")
      await closeGraphDb()
      let failed: HydrateResult
      try {
        failed = await hydrate(f)
      } finally {
        vi.unstubAllEnvs()
        await closeGraphDb()
      }
      expect(failed).toMatchObject({
        hydrated: true,
        writes: { mode: "partial", graphMode: "none" },
      })
      const after = await projected(f)
      // Postgres has the new tip. The graph still holds the old base.
      expect(after.revision.sha).toBe(f.git("rev-parse", "HEAD"))
      expect(after.graph.marker).toEqual(base)
      await commit(f, { write: { "doc-03.md": "# Doc 3\nChanged too.\n" } })
      await f.resolveRevision(true)
      const next = await hydrate(f)
      // The graph base is not the last Postgres SHA, so the graph is
      // written in full.
      expect(next.writes).toMatchObject({
        graphFullReason: "graph_base_mismatch",
      })
      await expectPartialEqualsFull(f, next, "full")
    }),
)

it(
  "a graph that does not hold the base revision is written in full",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      const falkor = await FalkorDB.connect({ url: process.env.GRAPH_DB_URI })
      try {
        await falkor
          .selectGraph(f.org.id)
          .query(
            "MATCH (p:WorkspaceProjection {projectionKey: $key}) SET p.revision = 'another'",
            { params: { key: workspaceGraphKey(f.revision) } },
          )
      } finally {
        await falkor.close()
      }
      await commit(f, { write: { "doc-02.md": "# Doc 2\nChanged.\n" } })
      await f.resolveRevision(true)
      const partial = await hydrate(f)
      expect(partial.writes).toMatchObject({
        graphFullReason: "graph_base_mismatch",
      })
      await expectPartialEqualsFull(f, partial, "full")
    }),
)

it.each([
  {
    reason: "unit_bound",
    prepare: async (f: NativeHydrationFixture) => {
      await commit(f, {
        write: Object.fromEntries(
          [1, 2, 3, 4].map((n) => [`doc-0${n}.md`, `# Doc ${n}\nChanged.\n`]),
        ),
      })
      await f.resolveRevision(true)
    },
  },
  {
    reason: "format_changed",
    prepare: async (f: NativeHydrationFixture) => {
      const format = workspaceFormatFile(2)
      await commit(f, { write: { [format.path]: format.content } })
      await f.resolveRevision(true)
    },
  },
  {
    reason: "chunks_missing",
    prepare: async (f: NativeHydrationFixture) => {
      await withOrgDbContext(f.org.id, (db) =>
        db
          .delete(workspaceKnowledgeChunks)
          .where(eq(workspaceKnowledgeChunks.workspaceId, f.workspaceId)),
      )
      await commit(f, { write: { "doc-02.md": "# Doc 2\nChanged.\n" } })
      await f.resolveRevision(true)
    },
  },
  {
    reason: "lineage",
    prepare: async (f: NativeHydrationFixture) => {
      await commit(f, { write: { "doc-02.md": "# Doc 2\nChanged.\n" } })
      // A relink starts a new generation.
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ desiredGeneration: 2, desiredSha: null })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      await f.resolveRevision(true)
    },
  },
])(
  "a hydrate writes all units when the reason is $reason",
  { timeout: 120_000 },
  async ({ reason, prepare }) =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      await prepare(f)
      expect(await hydrate(f)).toMatchObject({
        hydrated: true,
        writes: { mode: "full", fullReason: reason, graphMode: "full" },
      })
    }),
)

/** The units of `files`, committed in full as the active projection. */
async function commitBase(f: NativeHydrationFixture) {
  const { units } = hydrateKnowledgeTree({
    workspaceId: f.workspaceId,
    files: files.map((file) => ({ path: file.path, content: file.body })),
  })
  const commitWith = (
    list: typeof units,
    base?: { revision: WorkspaceRevision },
  ) =>
    commitHydrateProjection({
      orgId: f.org.id,
      revision: f.revision,
      displayName: null,
      formatVersion: null,
      units: list,
      skipped: [],
      embeddingModel: "fixture-embedding",
      ...(base ? { base } : {}),
    })
  expect(await commitWith(units)).toMatchObject({
    mode: "full",
    fullReason: "no_base",
  })
  return { units, commitWith }
}

it(
  "a commit writes all units when another hydrate moved the base, or when two units have one path",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await withOrgIdContext(f.org, async () => {
        const { units, commitWith } = await commitBase(f)
        expect(
          await commitWith(units, {
            revision: { ...f.revision, sha: "b".repeat(40) },
          }),
        ).toMatchObject({ mode: "full", fullReason: "base_moved" })
        // The full write refuses the duplicate, as before.
        await expect(
          commitWith([...units, ...units.slice(0, 1)], {
            revision: f.revision,
          }),
        ).rejects.toMatchObject({ cause: { code: "23505" } })
      })
    }),
)

it(
  "a partial commit sends only the chunks of the changed unit to the embed callback",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await withOrgIdContext(f.org, async () => {
        const { units, commitWith } = await commitBase(f)
        const calls: string[][] = []
        const embed = async (texts: string[]) => {
          calls.push(texts)
          return texts.map(() => Array(2000).fill(0.02))
        }
        const all = await embedKnowledgeChunks({
          workspaceId: f.workspaceId,
          embed,
        })
        expect(all).toBeGreaterThan(24)
        calls.length = 0
        const [first, ...rest] = units
        if (!first) throw new Error("Expected units")
        expect(
          await commitWith(
            [
              { ...first, body: `${first.body}\n## Added\nA new section.\n` },
              ...rest,
            ],
            { revision: f.revision },
          ),
        ).toMatchObject({
          mode: "partial",
          unitRowsWritten: 1,
          changedUnitIds: [first.servingId],
          removedUnitIds: [],
        })
        const sent = await embedKnowledgeChunks({
          workspaceId: f.workspaceId,
          embed,
        })
        expect(calls).toEqual([[expect.stringContaining("A new section")]])
        expect(sent).toBe(1)
      })
    }),
)
