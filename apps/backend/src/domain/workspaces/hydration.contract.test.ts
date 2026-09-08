import { BackendPostgres } from "openworkflow/postgres"
import { invalidateGithubAppCacheForConnection } from "../../models/github-installation.js"
import {
  withNativeHydrationFixture,
  type NativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  captureWorkspaceRevision,
  commitHydrateProjection,
  getWorkspaceById,
  getDesiredWorkspaceRevision,
  getWorkspaceProjection,
  getWorkspaceProjectionSnapshot,
  listWorkspaceKnowledgeUnits,
  persistEmbeddingFailure,
  persistHydrateFailure,
  persistUnitEmbeddings,
} from "../../models/workspaces.js"
import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceIndex } from "../../openworkflow/workflows/workspace-index.js"
import { resolveWorkspaceRepositoryTip } from "../../routes/webhooks/github/github-workspace-tip.js"

it(
  "hydrates 0 committed native Git files without reading uncommitted replacements",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ count: 0 }, async (f) => {
      const { org, workspaceId, expected, sha } = f
      await f.publish()
      await withOrgIdContext(org, async () => {
        expect(
          (await listWorkspaceKnowledgeUnits(workspaceId)).units
            .map(({ path, body }) => ({ path, body }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(expected)
        expect((await getWorkspaceById(workspaceId))?.activeProjectionSha).toBe(
          sha,
        )
      })
    }),
)

it(
  "hydrates 1 committed native Git files without reading uncommitted replacements",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ count: 1 }, async (f) => {
      const { org, workspaceId, expected, sha } = f
      await f.publish()
      await withOrgIdContext(org, async () => {
        expect(
          (await listWorkspaceKnowledgeUnits(workspaceId)).units
            .map(({ path, body }) => ({ path, body }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(expected)
        expect((await getWorkspaceById(workspaceId))?.activeProjectionSha).toBe(
          sha,
        )
      })
    }),
)

it(
  "hydrates a 100-file immutable tree within eight native Git commands",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ count: 100 }, async (f) => {
      const { gitTrace } = f
      await f.publish()
      const gitCommands = readFileSync(gitTrace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === "start" && !event.sid.includes("/"))
      expect(
        gitCommands.length,
        "native git command budget per immutable tree",
      ).toBeLessThanOrEqual(8)
    }),
)

it(
  "rejects a hydrate queued before its workspace is relinked",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { org, workspaceId, worker, handle } = f
      await withOrgDbContext(org.id, (db) =>
        db
          .update(workspaces)
          .set({ desiredGeneration: 2 })
          .where(eq(workspaces.id, workspaceId)),
      )
      await worker.start()
      expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: false,
        reason: "cas_discarded",
      })
      await withOrgIdContext(org, async () => {
        expect((await listWorkspaceKnowledgeUnits(workspaceId)).units).toEqual(
          [],
        )
        const workspace = await getWorkspaceById(workspaceId)
        expect(workspace?.desiredGeneration).toBe(2)
        expect(workspace?.activeProjectionSha).toBeNull()
      })
      return
    }),
)

it.each([1, 2])(
  "resolves a missing tip and hydrates generation %s without a separate tip-check job",
  { timeout: 60_000 },
  async (generation) =>
    withNativeHydrationFixture({ missingTip: true }, async (f) => {
      const { worker, org, workspaceId, runner, workspaceUrl, sha } = f
      if (generation === 2) {
        await withOrgDbContext(org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredGeneration: 2 })
            .where(eq(workspaces.id, workspaceId)),
        )
      }
      const handle =
        generation === 1
          ? f.handle
          : await runner.runWorkflow(workspaceHydrate.spec, {
              orgId: org.id,
              workspaceId,
              generation,
              url: workspaceUrl,
            })
      await worker.start()
      expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: true,
        units: 1,
      })
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjectionSnapshot(workspaceId)).toMatchObject(
          {
            projection: { kind: "active", revision: { generation, sha } },
            units: [{ body: expect.any(String) }],
          },
        )
      })
    }),
)

it(
  "hydrates native Git content with read_only write access",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ writeStatus: "read_only" }, async (f) => {
      const { org, workspaceId, expected, sha } = f
      await f.publish()
      await withOrgIdContext(org, async () => {
        expect(
          (await listWorkspaceKnowledgeUnits(workspaceId)).units
            .map(({ path, body }) => ({ path, body }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(expected)
        expect((await getWorkspaceById(workspaceId))?.activeProjectionSha).toBe(
          sha,
        )
      })
    }),
)

it(
  "hydrates native Git content with writable write access",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ writeStatus: "writable" }, async (f) => {
      const { org, workspaceId, expected, sha } = f
      await f.publish()
      await withOrgIdContext(org, async () => {
        expect(
          (await listWorkspaceKnowledgeUnits(workspaceId)).units
            .map(({ path, body }) => ({ path, body }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(expected)
        expect((await getWorkspaceById(workspaceId))?.activeProjectionSha).toBe(
          sha,
        )
      })
    }),
)

it(
  "uses repository-scoped read credentials for GitHub trees",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ count: 100, github: true }, async (f) => {
      const { tokenRequests, org, connectionId, workspaceUrl, sha } = f
      await f.publish()
      expect(tokenRequests).toEqual([
        {
          repositories: ["hydration-contract"],
          permissions: { contents: "read", metadata: "read" },
        },
      ])
      await withOrgIdContext(org, async () => {
        expect(
          await resolveWorkspaceRepositoryTip({
            orgId: org.id,
            githubConnectionId: connectionId,
            workspaceRepositoryUrl: workspaceUrl,
            env: parseEnv(process.env),
          }),
        ).toBe(sha)
      })
    }),
)

it(
  "a completed immutable hydrate does not request credentials again",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ github: true }, async (f) => {
      const {
        connectionId,
        tokenRequests,
        runner,
        org,
        workspaceId,
        workspaceUrl,
        sha,
      } = f
      await f.publish()
      invalidateGithubAppCacheForConnection(connectionId)
      f.failTokens()
      const tokenCount = tokenRequests.length
      const repeat = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        generation: 1,
        url: workspaceUrl,
        sha,
      })
      expect(await repeat.result({ timeoutMs: 30_000 })).toEqual({
        hydrated: false,
        reason: "noop",
      })
      expect(tokenRequests).toHaveLength(tokenCount)
    }),
)

it(
  "records an index credential failure independently of published knowledge",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ github: true }, async (f) => {
      const { org, id, workspaceUrl, runner, workspaceId, tokenRequests, sha } =
        f
      await f.publish()
      f.failTokens()
      await withOrgDbContext(org.id, (db) =>
        db.insert(repositories).values({
          id: `repo_${id}`,
          orgId: org.id,
          name: "Hydration fixture",
          gitUrl: workspaceUrl,
        }),
      )
      const indexing = await runner.runWorkflow(workspaceIndex.spec, {
        orgId: org.id,
        revision: (await withOrgIdContext(org, () =>
          getDesiredWorkspaceRevision(workspaceId),
        ))!,
      })
      await expect(indexing.result({ timeoutMs: 30_000 })).rejects.toThrow(
        "Credential provider unavailable",
      )
      expect(tokenRequests.at(-1)).toEqual({
        repositories: ["hydration-contract"],
        permissions: { contents: "read", metadata: "read" },
      })
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          revision: { generation: 1, sha },
          stores: {
            embeddings: { kind: "ready" },
            index: { kind: "failed" },
          },
        })
      })
    }),
)

it(
  "marks an incomplete embedding response failed without losing the projection",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ embeddings: "empty" }, async (f) => {
      const { org, workspaceId } = f
      await f.publish()
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          stores: { embeddings: { kind: "failed" } },
        })
      })
    }),
)

it(
  "rejects an index queued under another default branch at the same SHA",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { org, workspaceId, git, remote, sha, runner } = f
      await f.publish()
      const active = await withOrgIdContext(org, () =>
        getWorkspaceProjection(workspaceId),
      )
      if (active.kind !== "active") throw new Error("Expected active revision")
      git("--git-dir", remote, "update-ref", "refs/heads/trunk", sha)
      git("--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/trunk")
      await withOrgDbContext(org.id, (db) =>
        db
          .update(workspaces)
          .set({ desiredDefaultBranch: "trunk" })
          .where(eq(workspaces.id, workspaceId)),
      )
      const stale = await runner.runWorkflow(workspaceIndex.spec, {
        orgId: org.id,
        revision: active.revision,
      })
      expect(await stale.result({ timeoutMs: 30_000 })).toEqual({
        published: false,
        reason: "cas_discarded",
      })
    }),
)

it(
  "persists the full hydrate revision before a later generation change",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { databaseUrl, org, workspaceId, workspaceUrl, sha } = f
      await f.publish()
      const queue = await BackendPostgres.connect(databaseUrl, {
        runMigrations: false,
      })
      try {
        await withOrgIdContext(org, () =>
          enqueueWorkspaceHydrate(
            { orgId: org.id, workspaceId },
            {
              error: (error) => {
                throw error
              },
            },
          ),
        )
        let after: string | undefined
        let queued: Awaited<ReturnType<typeof queue.getWorkflowRun>> = null
        do {
          const page = await queue.listWorkflowRuns({ limit: 100, after })
          queued =
            page.data.find(
              (run) =>
                run.input &&
                typeof run.input === "object" &&
                !Array.isArray(run.input) &&
                run.input.workspaceId === workspaceId &&
                !("role" in run.input),
            ) ?? null
          after = page.pagination.next ?? undefined
        } while (!queued && after)
        expect(queued?.input).toEqual({
          orgId: org.id,
          workspaceId,
          revision: {
            workspaceId,
            generation: 1,
            remote: { url: workspaceUrl, connectionId: null },
            defaultBranch: "main",
            sha,
            access: "read",
          },
        })
        if (!queued) throw new Error("Missing durable hydrate command")
        await withOrgDbContext(org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredGeneration: 2 })
            .where(eq(workspaces.id, workspaceId)),
        )
        expect(
          (await queue.getWorkflowRun({ workflowRunId: queued.id }))?.input,
        ).toEqual(queued.input)
        await queue.cancelWorkflowRun({ workflowRunId: queued.id })
      } finally {
        await queue.stop()
      }
    }),
)

it(
  "preserves independent store failure and retry results",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { runner, org, workspaceId, sha, expected } = f
      await f.publish()
      const indexRun = await runner.runWorkflow(workspaceIndex.spec, {
        orgId: org.id,
        revision: (await withOrgIdContext(org, () =>
          getDesiredWorkspaceRevision(workspaceId),
        ))!,
      })
      expect(await indexRun.result({ timeoutMs: 30_000 })).toEqual({
        published: false,
        reason: "no_repository",
      })
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjectionSnapshot(workspaceId)).toMatchObject(
          {
            projection: {
              kind: "active",
              revision: { generation: 1, sha },
              stores: {
                embeddings: { kind: "ready" },
                index: { kind: "failed" },
              },
            },
            units: expected,
          },
        )
        const active = await getWorkspaceProjection(workspaceId)
        if (active.kind !== "active")
          throw new Error("Expected active revision")
        await persistEmbeddingFailure({
          revision: active.revision,
          message: "Concurrent embedding refresh failed",
        })
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          stores: {
            embeddings: { kind: "failed" },
            index: { kind: "failed" },
          },
        })
        const { units } = await getWorkspaceProjectionSnapshot(workspaceId)
        await persistUnitEmbeddings({
          revision: active.revision,
          embeddings: units.map((unit) => ({
            servingId: unit.servingId,
            embedding: Array(2000).fill(0.01),
          })),
        })
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          stores: {
            embeddings: { kind: "ready" },
            index: { kind: "failed" },
          },
        })
      })
    }),
)

it(
  "retries embeddings from PostgreSQL after the Git remote disappears",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ embeddings: "failed" }, async (f) => {
      const { org, workspaceId, sha, remote, runner, workspaceUrl, expected } =
        f
      await f.publish()
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          revision: { generation: 1, sha },
          stores: { embeddings: { kind: "failed" } },
        })
      })
      rmSync(remote, { recursive: true, force: true })
      f.repairEmbeddings()
      const retry = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        generation: 1,
        url: workspaceUrl,
        sha,
      })
      expect(await retry.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: true,
        units: 1,
      })
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          revision: { generation: 1, sha },
          stores: { embeddings: { kind: "ready" } },
        })
        expect(
          (await listWorkspaceKnowledgeUnits(workspaceId)).units.map(
            ({ path, body }) => ({ path, body }),
          ),
        ).toEqual(expected)
      })
    }),
)

async function prepareReplacement(f: NativeHydrationFixture) {
  const { org, workspaceId, workspaceUrl, directory, git, remote, sha } = f
  const selectRevision = (targetSha: string, previousSha: string) =>
    withOrgIdContext(org, async () => {
      const revision = await captureWorkspaceRevision({
        workspaceId,
        expected: {
          generation: 1,
          url: workspaceUrl,
          sha: previousSha,
          defaultBranch: "main",
          githubConnectionId: null,
        },
        tip: { sha: targetSha, branch: "main" },
      })
      if (!revision) throw new Error("Fixture revision was not captured")
      return revision
    })
  const readSnapshot = () =>
    withOrgIdContext(org, () => getWorkspaceProjectionSnapshot(workspaceId))
  rmSync(join(directory, "document-000.md"))
  writeFileSync(
    join(directory, "replacement.md"),
    "# Replacement\nNew committed content.\n",
  )
  writeFileSync(join(directory, "broken.md"), "---\nUnclosed front matter\n")
  git("add", "-A", "--", "document-000.md", "replacement.md", "broken.md")
  git(
    "-c",
    "user.name=Contract",
    "-c",
    "user.email=contract@example.test",
    "commit",
    "-m",
    "Replace with a malformed sibling",
  )
  const nextSha = git("rev-parse", "HEAD")
  git("push", remote, "HEAD:main")
  const nextRevision = await selectRevision(nextSha, sha)
  return { nextSha, nextRevision, selectRevision, readSnapshot }
}

it(
  "atomically replaces published units while reporting a malformed sibling",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { sha, expected, runner, org, workspaceId } = f
      await f.publish()
      const { nextSha, nextRevision, readSnapshot } =
        await prepareReplacement(f)
      expect(await readSnapshot()).toMatchObject({
        projection: {
          kind: "building",
          previous: { kind: "active", revision: { sha } },
        },
        units: expected,
      })
      const next = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        revision: nextRevision,
      })
      expect(await next.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: true,
        units: 1,
        skipped: 1,
        diagnostics: [{ path: "broken.md", reason: "malformed" }],
      })
      const replaced = await readSnapshot()
      expect(replaced.projection).toMatchObject({
        kind: "active",
        revision: { sha: nextSha },
      })
      expect(replaced.units.map(({ path, body }) => ({ path, body }))).toEqual([
        {
          path: "replacement.md",
          body: "# Replacement\nNew committed content.\n",
        },
      ])
    }),
)

it(
  "publishes a resolved Git rewind and restores the previous files",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { runner, org, workspaceId, git, remote, sha, expected } = f
      await f.publish()
      const { nextSha, nextRevision, selectRevision, readSnapshot } =
        await prepareReplacement(f)
      const next = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        revision: nextRevision,
      })
      expect(await next.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: true,
        units: 1,
        skipped: 1,
        diagnostics: [{ path: "broken.md", reason: "malformed" }],
      })
      git("--git-dir", remote, "update-ref", "refs/heads/main", sha)
      const originalRevision = await selectRevision(sha, nextSha)
      const rewind = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        revision: originalRevision,
      })
      expect(await rewind.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: true,
        units: 1,
        skipped: 0,
      })
      const rewound = await readSnapshot()
      expect(rewound.projection).toMatchObject({
        kind: "active",
        revision: { sha },
      })
      expect(rewound.units.map(({ path, body }) => ({ path, body }))).toEqual(
        expected,
      )
    }),
)

it(
  "rolls back unit replacement when PostgreSQL rejects duplicate serving ids",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { org, sha, expected } = f
      await f.publish()
      const {
        nextSha,
        nextRevision: rejectedRevision,
        readSnapshot,
      } = await prepareReplacement(f)
      const duplicate = {
        servingId: "kn_fixture_duplicate",
        path: "duplicate.md",
        body: "Never published",
        links: [],
        claims: [],
      }
      await expect(
        withOrgIdContext(org, () =>
          commitHydrateProjection({
            orgId: org.id,
            revision: rejectedRevision,
            displayName: null,
            remotes: [],
            units: [duplicate, duplicate],
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: "23505" } })
      const rolledBack = await readSnapshot()
      expect(rolledBack.projection).toMatchObject({
        kind: "building",
        desired: { sha: nextSha },
        previous: { kind: "active", revision: { sha } },
      })
      expect(
        rolledBack.units.map(({ path, body }) => ({ path, body })),
      ).toEqual(expected)
    }),
)

async function replaceGeneration(f: NativeHydrationFixture) {
  const { workspaceId, workspaceUrl, sha, org, runner } = f
  const revision = {
    workspaceId,
    generation: 1,
    remote: { url: workspaceUrl, connectionId: null },
    defaultBranch: "main",
    sha,
    access: "read" as const,
  }
  const readProjection = () =>
    withOrgIdContext(org, () => getWorkspaceProjection(workspaceId))
  await withOrgDbContext(org.id, (db) =>
    db
      .update(workspaces)
      .set({ desiredGeneration: 2 })
      .where(eq(workspaces.id, workspaceId)),
  )
  expect(await readProjection()).toMatchObject({
    kind: "building",
    desired: { generation: 2 },
    previous: { kind: "active", revision },
  })
  const replacement = await runner.runWorkflow(workspaceHydrate.spec, {
    orgId: org.id,
    workspaceId,
    generation: 2,
    url: workspaceUrl,
    sha,
  })
  expect(await replacement.result({ timeoutMs: 30_000 })).toMatchObject({
    hydrated: true,
    units: 1,
  })
  return { revision, readProjection }
}

it(
  "same-SHA relink publishes a new generation with pending search freshness",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { workspaceId, workspaceUrl, sha, org, runner } = f
      await f.publish()
      const revision = {
        workspaceId,
        generation: 1,
        remote: { url: workspaceUrl, connectionId: null },
        defaultBranch: "main",
        sha,
        access: "read" as const,
      }
      const readProjection = () =>
        withOrgIdContext(org, () => getWorkspaceProjection(workspaceId))
      expect(await readProjection()).toMatchObject({
        kind: "active",
        revision,
      })
      const repeat = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        generation: 1,
        url: workspaceUrl,
        sha,
      })
      expect(await repeat.result({ timeoutMs: 30_000 })).toEqual({
        hydrated: false,
        reason: "noop",
      })
      await withOrgDbContext(org.id, (db) =>
        db
          .update(workspaces)
          .set({ desiredGeneration: 2 })
          .where(eq(workspaces.id, workspaceId)),
      )
      expect(await readProjection()).toMatchObject({
        kind: "building",
        desired: { generation: 2 },
        previous: { kind: "active", revision },
      })
      const replacement = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        generation: 2,
        url: workspaceUrl,
        sha,
      })
      expect(await replacement.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: true,
        units: 1,
      })
      expect(await readProjection()).toMatchObject({
        kind: "active",
        revision: { ...revision, generation: 2 },
        stores: { index: { kind: "pending" } },
      })
    }),
)

it(
  "queues indexing with the newly published generation identity",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { databaseUrl, workspaceId } = f
      await f.publish()
      const { revision } = await replaceGeneration(f)
      const indexQueue = await BackendPostgres.connect(databaseUrl, {
        runMigrations: false,
      })
      try {
        let after: string | undefined
        let indexCommand: unknown
        do {
          const page = await indexQueue.listWorkflowRuns({
            limit: 100,
            after,
          })
          indexCommand = page.data.find((run) => {
            const input = run.input
            if (!input || typeof input !== "object" || Array.isArray(input))
              return false
            const revision = input.revision
            return (
              revision &&
              typeof revision === "object" &&
              !Array.isArray(revision) &&
              revision.workspaceId === workspaceId &&
              revision.generation === 2
            )
          })?.input
          after = page.pagination.next ?? undefined
        } while (!indexCommand && after)
        expect(indexCommand).toMatchObject({
          revision: { ...revision, generation: 2 },
        })
      } finally {
        await indexQueue.stop()
      }
    }),
)

it(
  "discards embedding results from a superseded generation",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { org, workspaceId } = f
      await f.publish()
      const { revision } = await replaceGeneration(f)
      await withOrgIdContext(org, async () => {
        const [unit] = (await getWorkspaceProjectionSnapshot(workspaceId)).units
        if (!unit) throw new Error("Expected the active knowledge unit")
        await persistUnitEmbeddings({
          revision,
          embeddings: [{ servingId: unit.servingId, embedding: [0.99] }],
        })
        expect(
          (await getWorkspaceProjectionSnapshot(workspaceId)).units[0]
            ?.embedding,
        ).toEqual(Array(2000).fill(0.01))
      })
    }),
)

it(
  "discards hydrate failures from a superseded generation",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { org } = f
      await f.publish()
      const { revision, readProjection } = await replaceGeneration(f)
      await withOrgIdContext(org, () =>
        persistHydrateFailure({
          revision,
          message:
            "An obsolete generation failed after its replacement activated",
        }),
      )
      expect(await readProjection()).toMatchObject({
        kind: "active",
        revision: { ...revision, generation: 2 },
      })
    }),
)

it(
  "derives missing claim dates from each file's introducing commit, not the hydrated tip",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture({ count: 0 }, async (f) => {
      await f.publish()
      const commitAt = (date: string, paths: string[]) => {
        f.git("add", "--", ...paths)
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Contract",
            "-c",
            "user.email=contract@example.test",
            "commit",
            "-m",
            "Historical knowledge",
          ],
          {
            cwd: f.directory,
            env: {
              ...process.env,
              GIT_AUTHOR_DATE: date,
              GIT_COMMITTER_DATE: date,
            },
            stdio: "ignore",
          },
        )
      }
      const claim =
        "---\nclaims:\n  - to: target.md\n    predicate: depends_on\n---\n"
      writeFileSync(
        join(f.directory, "first.md"),
        `${claim}# First assertion\n`,
      )
      writeFileSync(join(f.directory, "target.md"), "# Target\n")
      commitAt("2001-01-01T00:00:00Z", ["first.md", "target.md"])
      writeFileSync(
        join(f.directory, "second.md"),
        `${claim}# Second assertion\n`,
      )
      commitAt("2002-02-02T00:00:00Z", ["second.md"])
      writeFileSync(
        join(f.directory, "first.md"),
        `${claim}# Edited prose only\n`,
      )
      commitAt("2020-03-03T00:00:00Z", ["first.md"])
      const tip = f.git("rev-parse", "HEAD")
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
          tip: { sha: tip, branch: "main" },
        }),
      )
      if (!revision) throw new Error("Fixture revision was not captured")
      const run = await f.runner.runWorkflow(workspaceHydrate.spec, {
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        revision,
      })
      await run.result({ timeoutMs: 30_000 })
      const snapshot = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      expect(
        snapshot.units
          .filter((unit) => unit.claims.length)
          .map((unit) => ({
            path: unit.path,
            validFrom: unit.claims[0]?.validFrom,
          })),
      ).toEqual([
        { path: "first.md", validFrom: "2001-01-01T00:00:00.000Z" },
        { path: "second.md", validFrom: "2002-02-02T00:00:00.000Z" },
      ])
    })
  },
)
