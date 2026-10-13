import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { and, asc, eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { captureWorkspaceRevision } from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"

const FIRST_COMMIT = "2026-03-01T10:00:00.000Z"
const SECOND_COMMIT = "2026-04-02T11:30:00.000Z"

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

function readChunks(f: NativeHydrationFixture, orgId = f.org.id) {
  const chunks = workspaceKnowledgeChunks
  return withOrgDbContext(orgId, (db) =>
    db
      .select({
        unitId: chunks.unitId,
        projectionSha: chunks.projectionSha,
        ordinal: chunks.ordinal,
        text: chunks.text,
        embedding: chunks.embedding,
      })
      .from(chunks)
      .where(eq(chunks.workspaceId, f.workspaceId))
      .orderBy(asc(chunks.unitId), asc(chunks.ordinal)),
  )
}

function readUnits(f: NativeHydrationFixture) {
  const units = workspaceKnowledgeUnits
  return withOrgDbContext(f.org.id, (db) =>
    db
      .select({
        path: units.path,
        title: units.title,
        source: units.source,
        updatedAt: units.updatedAt,
        embedding: units.embedding,
      })
      .from(units)
      .where(eq(units.workspaceId, f.workspaceId))
      .orderBy(asc(units.path)),
  )
}

/** Commit one changed file at a fixed time and capture its revision. */
async function commitChange(
  f: NativeHydrationFixture,
  path: string,
  body: string,
) {
  writeFileSync(join(f.directory, path), body)
  f.git("add", "--", path)
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
        GIT_AUTHOR_DATE: SECOND_COMMIT,
        GIT_COMMITTER_DATE: SECOND_COMMIT,
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
        sha: f.sha,
        defaultBranch: "main",
        githubConnectionId: null,
      },
      tip: { sha: nextSha, branch: "main" },
    }),
  )
  if (!revision) throw new Error("Fixture revision was not captured")
  return { nextSha, revision }
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
  "embeds only the changed chunk on the next hydrate and keeps old chunks until the switch",
  { timeout: 90_000 },
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
        // `b.md` repeats the first section of `a.md`: one hash, one model input.
        expect([...inputs].sort()).toEqual([ALPHA, BETA, GAMMA])
        const first = await readChunks(f)
        expect(first.map(({ projectionSha }) => projectionSha)).toEqual(
          Array(4).fill(f.sha),
        )
        expect(first.every(({ embedding }) => embedding?.length === 2000)).toBe(
          true,
        )
        const vectorOf = (rows: typeof first, text: string) =>
          rows.find((row) => row.text === text)?.embedding?.[0]

        const changed = "## Beta\nBeta text, now longer."
        const { nextSha, revision } = await commitChange(
          f,
          "a.md",
          `${ALPHA}\n${changed}\n${GAMMA}\n`,
        )
        // The new revision is captured but not active: search still has the old chunks.
        expect(await readChunks(f)).toEqual(first)

        inputs.length = 0
        const next = await f.runner.runWorkflow(workspaceHydrate.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision,
        })
        expect(await next.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: true,
          units: 2,
        })
        expect(inputs).toEqual([changed])

        const second = await readChunks(f)
        expect(second.map(({ projectionSha }) => projectionSha)).toEqual(
          Array(4).fill(nextSha),
        )
        expect(second.map(({ text }) => text).sort()).toEqual(
          [ALPHA, ALPHA, changed, GAMMA].sort(),
        )
        for (const text of [ALPHA, GAMMA])
          expect(vectorOf(second, text)).toBe(vectorOf(first, text))
        expect(vectorOf(second, changed)).toBe(4 / 1000)

        const units = await readUnits(f)
        expect(
          units.map(({ path, updatedAt }) => ({ path, updatedAt })),
        ).toEqual([
          { path: "a.md", updatedAt: new Date(SECOND_COMMIT) },
          { path: "b.md", updatedAt: new Date(FIRST_COMMIT) },
        ])
        // A unit embedding is the mean of its chunk embeddings.
        const a = units[0]?.embedding
        const mean =
          ((vectorOf(second, ALPHA) ?? 0) +
            (vectorOf(second, changed) ?? 0) +
            (vectorOf(second, GAMMA) ?? 0)) /
          3
        expect(a?.length).toBe(2000)
        expect(a?.[0]).toBeCloseTo(mean, 5)
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
        const { revision } = await commitChange(
          f,
          "a.md",
          `${ALPHA}\n${BETA}\n`,
        )
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredGeneration: 2 })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        inputs.length = 0
        const stale = await f.runner.runWorkflow(workspaceHydrate.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision,
        })
        expect(await stale.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: false,
          reason: "cas_discarded",
        })
        expect(inputs).toEqual([])
        expect(await readChunks(f)).toEqual(before)
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
            db.insert(workspaceKnowledgeChunks).values({
              unitId: "kn_foreign",
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              projectionSha: f.sha,
              ordinal: 0,
              text: "Foreign",
              chunkHash: "0".repeat(64),
            }),
          ),
        ).rejects.toThrow()
        const deleted = await withOrgDbContext(otherOrg, (db) =>
          db
            .delete(workspaceKnowledgeChunks)
            .where(
              and(
                eq(workspaceKnowledgeChunks.workspaceId, f.workspaceId),
                eq(workspaceKnowledgeChunks.projectionSha, f.sha),
              ),
            )
            .returning({ unitId: workspaceKnowledgeChunks.unitId }),
        )
        expect(deleted).toEqual([])
        expect(await readChunks(f)).toHaveLength(1)
      },
    ),
)
