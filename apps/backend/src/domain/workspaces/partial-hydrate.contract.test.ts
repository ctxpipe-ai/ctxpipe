import { asc, eq } from "drizzle-orm"
import { FalkorDB } from "falkordb"
import { expect, it, vi } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaces,
} from "../../db/schema/workspaces.js"
import {
  commitHydrateProjection,
  embedKnowledgeChunks,
  getWorkspaceProjection,
} from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { closeGraphDb } from "../../platform/graph/client.js"
import {
  type Change,
  commit,
  countEmbeddings,
  expectPartialEqualsFull,
  type HydrateResult,
  hydrate,
  projected,
  settleIndex,
} from "../../test/hydrate-projection.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import {
  withCompleteWorkspaceGraph,
  workspaceGraphKey,
} from "./graph-projection.js"
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
    embeddingModel = "fixture-embedding",
  ) =>
    commitHydrateProjection({
      orgId: f.org.id,
      revision: f.revision,
      displayName: null,
      formatVersion: null,
      units: list,
      skipped: [],
      embeddingModel,
      ...(base ? { base } : {}),
    })
  expect(await commitWith(units)).toMatchObject({
    mode: "full",
    fullReason: "no_base",
  })
  return { units, commitWith }
}

it(
  "a commit writes all units when another hydrate moved the base, and refuses two units with one serving id",
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
        // The partial write refuses the duplicate, as the full write does.
        await expect(
          commitWith([...units, ...units.slice(0, 1)], {
            revision: f.revision,
          }),
        ).rejects.toThrow("Two units have the serving id")
        await expect(
          commitWith([...units, ...units.slice(0, 1)]),
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

it(
  "a commit after a change of the embedding model writes all units and embeds all chunks again, as a full write does",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await withOrgIdContext(f.org, async () => {
        const { units, commitWith } = await commitBase(f)
        const embed = async (texts: string[]) =>
          texts.map(() => Array(2000).fill(0.02))
        const all = await embedKnowledgeChunks({
          workspaceId: f.workspaceId,
          embed,
        })
        // The model changes; the units do not.
        expect(
          await commitWith(units, { revision: f.revision }, "next-embedding"),
        ).toMatchObject({ mode: "full", fullReason: "unit_bound" })
        const afterModelChange = await chunkKeys(f)
        expect(
          await embedKnowledgeChunks({ workspaceId: f.workspaceId, embed }),
        ).toBe(all)
        await commitWith(units, undefined, "next-embedding")
        expect(await chunkKeys(f)).toEqual(afterModelChange)
      })
    }),
)

async function chunkKeys(f: NativeHydrationFixture) {
  return withOrgDbContext(f.org.id, (db) =>
    db
      .select({
        unitId: workspaceKnowledgeChunks.unitId,
        chunkHash: workspaceKnowledgeChunks.chunkHash,
      })
      .from(workspaceKnowledgeChunks)
      .where(eq(workspaceKnowledgeChunks.workspaceId, f.workspaceId))
      .orderBy(
        asc(workspaceKnowledgeChunks.unitId),
        asc(workspaceKnowledgeChunks.ordinal),
      ),
  )
}

it(
  "a graph read that a delta overlaps reads again, and gives nodes and edges of one revision",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      const projection = await withOrgIdContext(f.org, () =>
        getWorkspaceProjection(f.workspaceId),
      )
      if (projection.kind !== "active") throw new Error("Expected a projection")
      // The change removes the edge doc-03 -> doc-05 and adds doc-05 -> doc-07.
      await commit(f, {
        write: {
          "doc-03.md": "# Doc 3\nNo links.\n",
          "doc-05.md":
            "---\nclaims:\n  - to: doc-07.md\n    predicate: SUPERSEDES\n---\n# Doc 5\nNew text.\n",
        },
      })
      await f.resolveRevision(true)
      let runs = 0
      const read = await withCompleteWorkspaceGraph(
        { orgId: f.org.id, orgSlug: f.org.slug, projection },
        async ({ client, projectionKey }) => {
          runs += 1
          const nodes = await client.executeQuery(
            "MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey}) RETURN n.id AS id, n.summary AS summary ORDER BY n.id",
            { projectionKey },
          )
          // The delta of the next revision runs between the two reads.
          if (runs === 1)
            expect(await hydrate(f)).toMatchObject({
              writes: { mode: "partial", graphMode: "partial" },
            })
          const edges = await client.executeQuery(
            "MATCH (s:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})-[r:WorkspaceSignal {projectionKey: $projectionKey}]->(t) RETURN r.id AS id, s.id AS subject, t.id AS object ORDER BY r.id",
            { projectionKey },
          )
          const rows = (result: typeof nodes, keys: string[]) =>
            result.records.map((row) =>
              Object.fromEntries(keys.map((key) => [key, row.get(key)])),
            )
          return {
            nodes: rows(nodes, ["id", "summary"]),
            edges: rows(edges, ["id", "subject", "object"]),
          }
        },
      )
      expect(runs).toBe(2)
      const graph = (await projected(f)).graph
      expect(read.nodes).toEqual(
        graph.nodes.map((node) => ({
          id: (node as { id: string }).id,
          summary: (node as { summary: string | null }).summary,
        })),
      )
      expect(read.edges).toEqual(
        graph.edges.map((edge) => {
          const { id, subject, object } = edge as Record<string, unknown>
          return { id, subject, object }
        }),
      )
    }),
)
