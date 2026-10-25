import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { and, asc, eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import {
  captureWorkspaceRevision,
  getWorkspaceProjection,
  markKnowledgeEmbeddingsReady,
} from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"

const FIRST_COMMIT = "2026-03-01T10:00:00.000Z"
const SECOND_COMMIT = "2026-04-02T11:30:00.000Z"
const THIRD_COMMIT = "2026-05-03T12:00:00.000Z"

/** Count the texts the model embeds; each text gets its own vector value. */
function countEmbeddings(f: NativeHydrationFixture) {
  const inputs: string[] = []
  let embedded = 0
  f.server.use(
    http.post(
      "https://hydrate-model.test/v1/embeddings",
      async ({ request }) => {
        const body = (await request.json()) as { input: string[] }
        const data = body.input.map((text, index) => {
          inputs.push(text)
          embedded += 1
          return { index, embedding: Array(2000).fill(embedded / 1000) }
        })
        return HttpResponse.json({ data })
      },
    ),
  )
  return inputs
}

const chunks = workspaceKnowledgeChunks

function readChunks(f: NativeHydrationFixture, orgId = f.org.id) {
  return withOrgDbContext(orgId, (db) =>
    db
      .select({
        ctid: sql<string>`ctid::text`,
        unitId: chunks.unitId,
        chunkHash: chunks.chunkHash,
        occurrence: chunks.occurrence,
        ordinal: chunks.ordinal,
        startLine: chunks.startLine,
        endLine: chunks.endLine,
        text: chunks.text,
        embedding: chunks.embedding,
      })
      .from(chunks)
      .where(eq(chunks.workspaceId, f.workspaceId))
      .orderBy(asc(chunks.unitId), asc(chunks.ordinal)),
  )
}
type ChunkRow = Awaited<ReturnType<typeof readChunks>>[number]
const chunkKey = (row: ChunkRow) =>
  `${row.unitId}/${row.chunkHash}/${row.occurrence}`

function readUnits(f: NativeHydrationFixture) {
  const units = workspaceKnowledgeUnits
  return withOrgDbContext(f.org.id, (db) =>
    db
      .select({
        path: units.path,
        title: units.title,
        source: units.source,
        updatedAt: units.updatedAt,
      })
      .from(units)
      .where(eq(units.workspaceId, f.workspaceId))
      .orderBy(asc(units.path)),
  )
}

/** Commit one changed file at a fixed time and capture its revision. */
async function commitChange(
  f: NativeHydrationFixture,
  input: { path: string; body: string; previousSha: string; date: string },
) {
  writeFileSync(join(f.directory, input.path), input.body)
  f.git("add", "--", input.path)
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-m",
      "Edit one section",
    ],
    {
      cwd: f.directory,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: input.date,
        GIT_COMMITTER_DATE: input.date,
      },
    },
  )
  const nextSha = f.git("rev-parse", "HEAD")
  f.git("push", f.remote, "HEAD:main")
  const revision = await withOrgIdContext(f.org, () =>
    captureWorkspaceRevision({
      workspaceId: f.workspaceId,
      expected: {
        generation: 1,
        url: f.workspaceUrl,
        sha: input.previousSha,
        defaultBranch: "main",
        githubConnectionId: null,
      },
      tip: { sha: nextSha, branch: "main" },
    }),
  )
  if (!revision) throw new Error("Fixture revision was not captured")
  return { nextSha, revision }
}

async function hydrate(
  f: NativeHydrationFixture,
  revision: Parameters<typeof workspaceHydrate.fn>[0]["input"]["revision"],
) {
  const run = await f.runner.runWorkflow(workspaceHydrate.spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    revision,
  })
  return run.result({ timeoutMs: 30_000 })
}

const ALPHA = "# Alpha\nAlpha text."
const BETA = "## Beta\nBeta text."
const GAMMA = "## Gamma\nGamma text."

it(
  "sets title, source, and the last commit time for each mirror kind and an authored unit",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture(
      {
        initialCommitDate: FIRST_COMMIT,
        files: [
          {
            path: "confluence/spaces/ENG/runbook--1.md",
            body: "---\ntitle: Runbook\n---\nSteps.\n",
          },
          {
            path: "github/pulls/fixture/api/7--fix-login.md",
            body: "# Fix login\nBody.\n",
          },
          { path: "knowledge/payments.md", body: "Intro.\n\n## Payments\n" },
          { path: "linear/issues/PAY-1.md", body: "# PAY-1 Refunds\n" },
          {
            path: "notion/pages/root--p1/index.md",
            body: "---\ntitle: Roadmap\n---\n# Other\n",
          },
          { path: "pagerduty/incidents/12--P1.md", body: "# Outage 12\n" },
          { path: "slack/channels/eng--C1/index.md", body: "No heading.\n" },
        ],
      },
      async (f) => {
        countEmbeddings(f)
        await f.publish()
        const at = new Date(FIRST_COMMIT)
        expect(
          (await readUnits(f)).map(({ path, title, source, updatedAt }) => ({
            path,
            title,
            source,
            updatedAt,
          })),
        ).toEqual([
          {
            path: "confluence/spaces/ENG/runbook--1.md",
            title: "Runbook",
            source: "confluence",
            updatedAt: at,
          },
          {
            path: "github/pulls/fixture/api/7--fix-login.md",
            title: "Fix login",
            source: "github",
            updatedAt: at,
          },
          {
            path: "knowledge/payments.md",
            title: "Payments",
            source: "authored",
            updatedAt: at,
          },
          {
            path: "linear/issues/PAY-1.md",
            title: "PAY-1 Refunds",
            source: "linear",
            updatedAt: at,
          },
          {
            path: "notion/pages/root--p1/index.md",
            title: "Roadmap",
            source: "notion",
            updatedAt: at,
          },
          {
            path: "pagerduty/incidents/12--P1.md",
            title: "Outage 12",
            source: "pagerduty",
            updatedAt: at,
          },
          {
            path: "slack/channels/eng--C1/index.md",
            title: null,
            source: "slack",
            updatedAt: at,
          },
        ])
      },
    ),
)

it(
  "writes only changed chunks on the next hydrate and embeds only their new text",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture(
      {
        initialCommitDate: FIRST_COMMIT,
        files: [
          { path: "a.md", body: `${ALPHA}\n${BETA}\n${GAMMA}\n` },
          { path: "b.md", body: `${ALPHA}\n` },
        ],
      },
      async (f) => {
        const inputs = countEmbeddings(f)
        await f.publish()
        const first = await readChunks(f)
        expect(first).toHaveLength(4)
        // `b.md` has the same title and section as the first chunk of `a.md`:
        // one hash, one model input.
        expect([...inputs].sort()).toEqual(
          [...new Set(first.map(({ text }) => text))].sort(),
        )
        expect(inputs).toHaveLength(3)
        expect(inputs).toContain("Alpha > Beta\n\n## Beta\nBeta text.")
        expect(
          first.map(({ startLine, endLine }) => [startLine, endLine]),
        ).toEqual(
          expect.arrayContaining([
            [1, 2],
            [3, 4],
            [5, 6],
          ]),
        )
        expect(first.every(({ embedding }) => embedding?.length === 2000)).toBe(
          true,
        )

        // Same line count: no other chunk moves.
        const changed = "## Beta\nBeta text, now longer."
        const second = await commitChange(f, {
          path: "a.md",
          body: `${ALPHA}\n${changed}\n${GAMMA}\n`,
          previousSha: f.sha,
          date: SECOND_COMMIT,
        })
        // Captured but not active: search still has the old chunks.
        expect(await readChunks(f)).toEqual(first)
        inputs.length = 0
        expect(await hydrate(f, second.revision)).toMatchObject({
          hydrated: true,
          units: 2,
        })
        expect(inputs).toEqual([`Alpha > Beta\n\n${changed}`])
        const afterEdit = await readChunks(f)
        const firstByKey = new Map(first.map((row) => [chunkKey(row), row]))
        const kept = afterEdit.filter((row) => firstByKey.has(chunkKey(row)))
        expect(kept).toHaveLength(3)
        // No write at all: the same tuple, the same vector.
        for (const row of kept)
          expect(row).toEqual(firstByKey.get(chunkKey(row)))

        // One more line in the first section moves the later chunks of
        // `a.md`: their lines change, their vectors stay, nothing is embedded
        // but the edited chunk.
        const third = await commitChange(f, {
          path: "a.md",
          body: `${ALPHA}\nMore.\n${changed}\n${GAMMA}\n`,
          previousSha: second.nextSha,
          date: THIRD_COMMIT,
        })
        inputs.length = 0
        expect(await hydrate(f, third.revision)).toMatchObject({
          hydrated: true,
        })
        expect(inputs).toEqual(["Alpha\n\n# Alpha\nAlpha text.\nMore."])
        const afterMove = await readChunks(f)
        const editByKey = new Map(afterEdit.map((row) => [chunkKey(row), row]))
        const movedBeta = afterMove.find((row) => row.text.endsWith(changed))
        expect(movedBeta).toMatchObject({ startLine: 4, endLine: 5 })
        expect(movedBeta?.embedding).toEqual(
          movedBeta && editByKey.get(chunkKey(movedBeta))?.embedding,
        )

        const units = await readUnits(f)
        expect(
          units.map(({ path, updatedAt }) => ({ path, updatedAt })),
        ).toEqual([
          { path: "a.md", updatedAt: new Date(THIRD_COMMIT) },
          { path: "b.md", updatedAt: new Date(FIRST_COMMIT) },
        ])
      },
    ),
)

it(
  "keeps the active chunks when a newer hydrate loses its activation",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      {
        initialCommitDate: FIRST_COMMIT,
        files: [{ path: "a.md", body: ALPHA }],
      },
      async (f) => {
        const inputs = countEmbeddings(f)
        await f.publish()
        const before = await readChunks(f)
        const { revision } = await commitChange(f, {
          path: "a.md",
          body: `${ALPHA}\n${BETA}\n`,
          previousSha: f.sha,
          date: SECOND_COMMIT,
        })
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredGeneration: 2 })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        inputs.length = 0
        expect(await hydrate(f, revision)).toMatchObject({
          hydrated: false,
          reason: "cas_discarded",
        })
        expect(inputs).toEqual([])
        expect(await readChunks(f)).toEqual(before)
      },
    ),
)

it(
  "publishes chunks for a projection made before chunks existed, with no new commit",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      { files: [{ path: "a.md", body: `${ALPHA}\n${BETA}\n` }] },
      async (f) => {
        const inputs = countEmbeddings(f)
        await f.publish()
        // The state that the migration leaves: no chunks, no title or source.
        await withOrgDbContext(f.org.id, async (db) => {
          await db.delete(chunks).where(eq(chunks.workspaceId, f.workspaceId))
          await db
            .update(workspaceKnowledgeUnits)
            .set({ title: null, source: null })
            .where(eq(workspaceKnowledgeUnits.workspaceId, f.workspaceId))
        })
        inputs.length = 0
        expect(await hydrate(f, await f.resolveRevision())).toMatchObject({
          hydrated: true,
          units: 1,
        })
        expect(inputs).toHaveLength(2)
        const after = await readChunks(f)
        expect(after).toHaveLength(2)
        expect(after.every(({ embedding }) => embedding?.length === 2000)).toBe(
          true,
        )
        expect(await readUnits(f)).toMatchObject([
          { path: "a.md", title: "Alpha", source: "authored" },
        ])
        await withOrgIdContext(f.org, async () => {
          expect(await getWorkspaceProjection(f.workspaceId)).toMatchObject({
            kind: "active",
            stores: { embeddings: { kind: "ready" } },
          })
        })
        // Now complete: the next run of the same revision does nothing.
        inputs.length = 0
        expect(await hydrate(f, await f.resolveRevision())).toMatchObject({
          hydrated: false,
        })
        expect(inputs).toEqual([])
      },
    ),
)

it(
  "does not mark embeddings ready while a chunk has no vector or a unit has no chunk",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture(
      { files: [{ path: "a.md", body: `${ALPHA}\n${BETA}\n` }] },
      async (f) => {
        countEmbeddings(f)
        await f.publish()
        await withOrgIdContext(f.org, async () => {
          const active = await getWorkspaceProjection(f.workspaceId)
          if (active.kind !== "active")
            throw new Error("Expected active revision")
          const [one] = await readChunks(f)
          if (!one) throw new Error("Expected a chunk")
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(chunks)
              .set({ embedding: null })
              .where(
                and(
                  eq(chunks.workspaceId, f.workspaceId),
                  eq(chunks.chunkHash, one.chunkHash),
                ),
              ),
          )
          await expect(
            markKnowledgeEmbeddingsReady({ revision: active.revision }),
          ).rejects.toThrow("Knowledge chunks are not all embedded")
          await withOrgDbContext(f.org.id, (db) =>
            db.delete(chunks).where(eq(chunks.workspaceId, f.workspaceId)),
          )
          await expect(
            markKnowledgeEmbeddingsReady({ revision: active.revision }),
          ).rejects.toThrow("Knowledge chunks are not all embedded")
        })
      },
    ),
)

it(
  "denies the chunks of one org to another org",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture(
      { files: [{ path: "a.md", body: ALPHA }] },
      async (f) => {
        countEmbeddings(f)
        await f.publish()
        expect(await readChunks(f)).toHaveLength(1)
        const otherOrg = `org_other_${f.id}`
        expect(await readChunks(f, otherOrg)).toEqual([])
        await expect(
          withOrgDbContext(otherOrg, (db) =>
            db.insert(chunks).values({
              unitId: "kn_foreign",
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              chunkHash: "0".repeat(64),
              occurrence: 0,
              ordinal: 0,
              startLine: 1,
              endLine: 1,
              text: "Foreign",
            }),
          ),
        ).rejects.toThrow()
        const deleted = await withOrgDbContext(otherOrg, (db) =>
          db
            .delete(chunks)
            .where(eq(chunks.workspaceId, f.workspaceId))
            .returning({ unitId: chunks.unitId }),
        )
        expect(deleted).toEqual([])
        expect(await readChunks(f)).toHaveLength(1)
      },
    ),
)
