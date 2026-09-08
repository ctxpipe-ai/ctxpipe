import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { invalidateGithubAppCacheForConnection } from "../../models/github-installation.js"
import {
  captureWorkspaceRevision,
  commitHydrateProjection,
  getWorkspaceById,
  getWorkspaceProjection,
  getWorkspaceProjectionSnapshot,
  listWorkspaceKnowledgeUnits,
  persistEmbeddingFailure,
  persistHydrateFailure,
  persistIndexedSha,
  persistResolvedDesiredSha,
  persistUnitEmbeddings,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { repositoryIndex } from "../../openworkflow/workflows/repository-index.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceIndex } from "../../openworkflow/workflows/workspace-index.js"
import {
  listWorkspaceCheckoutPaths,
  readWorkspaceCheckoutFile,
} from "./checkout-read.js"
import { resolveWorkspaceRepositoryTip } from "../../routes/webhooks/github/github-workspace-tip.js"

it.each([
  { count: 0, relink: false },
  { count: 1, relink: false },
  { count: 100, relink: false },
  { count: 1, relink: true },
  { count: 100, relink: false, github: true },
  { count: 1, relink: false, projectionIdentity: true },
  { count: 1, relink: false, embeddingFailure: true },
  { count: 1, relink: false, history: true },
  { count: 1, relink: false, incompleteEmbeddings: true },
  { count: 1, relink: false, indexFailure: true },
  { count: 1, relink: false, enqueue: true },
  { count: 1, relink: false, missingTip: true },
  { count: 1, relink: false, writeStatus: "read_only" },
  { count: 1, relink: false, writeStatus: "writable" },
  { count: 1, relink: false, github: true, indexAuthFailure: true },
  { count: 1, relink: false, indexIdentity: true },
  { count: 1, relink: false, projectionFiles: true },
])(
  "executes the hydrate workflow for $count native-git files (relink before execution: $relink, GitHub: $github, projection identity: $projectionIdentity, embedding failure: $embeddingFailure, history: $history, incomplete embeddings: $incompleteEmbeddings, index failure: $indexFailure, enqueue: $enqueue, missing tip: $missingTip, write status: $writeStatus, index auth failure: $indexAuthFailure, index identity: $indexIdentity, projection files: $projectionFiles)",
  { timeout: 60_000 },
  async ({
    count,
    relink,
    github,
    projectionIdentity,
    embeddingFailure,
    history,
    incompleteEmbeddings,
    indexFailure,
    enqueue,
    missingTip,
    writeStatus,
    indexAuthFailure,
    indexIdentity,
    projectionFiles,
  }) => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for hydration proof")
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-hydration-contract-"))
    const id = `hydrate_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const org = { id: `org_${id}`, slug: id, name: "Hydration contract" }
    const workspaceId = `ws_${id}`
    const connectionId = `con_${id}`
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
    const savedEnv = {
      GIT_TRACE2_EVENT: process.env.GIT_TRACE2_EVENT,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
      MODEL_PROVIDER: process.env.MODEL_PROVIDER,
      MODEL_PROVIDER_API_KEY: process.env.MODEL_PROVIDER_API_KEY,
      MODEL_PROVIDER_URL: process.env.MODEL_PROVIDER_URL,
    }
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_API_KEY: "fixture-only",
      MODEL_PROVIDER_URL: "https://hydrate-model.test/v1",
    })
    const tokenRequests: unknown[] = []
    let failEmbeddings = embeddingFailure === true
    let failGithubTokens = false
    const server = setupServer(
      http.post(
        "https://api.github.com/app/installations/123456789/access_tokens",
        async ({ request }) => {
          const body = await request.text()
          tokenRequests.push(body ? JSON.parse(body) : {})
          if (failGithubTokens)
            return HttpResponse.json(
              { message: "Credential provider unavailable" },
              { status: 400 },
            )
          return HttpResponse.json(
            {
              token: "fixture-only-github-read-token",
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              permissions: { contents: "read", metadata: "read" },
            },
            { status: 201 },
          )
        },
      ),
      http.get("https://api.github.com/repos/fixture/hydration-contract", () =>
        HttpResponse.json({ message: "Use native Git" }, { status: 404 }),
      ),
      http.get(
        "https://api.github.com/repos/fixture/hydration-contract/git/trees/:sha",
        () => HttpResponse.json({ message: "Use native Git" }, { status: 404 }),
      ),
      http.post(
        "https://hydrate-model.test/v1/embeddings",
        async ({ request }) => {
          if (failEmbeddings)
            return HttpResponse.json(
              { error: { message: "Embedding fixture unavailable" } },
              { status: 400 },
            )
          const body = (await request.json()) as { input: string[] }
          return HttpResponse.json({
            data: body.input.map((_, index) => ({
              index,
              embedding: incompleteEmbeddings ? [] : Array(2000).fill(0.01),
            })),
          })
        },
      ),
    )
    server.listen({ onUnhandledRequest: "error" })
    initDb(databaseUrl)
    const backend = await BackendPostgres.connect(databaseUrl, {
      runMigrations: false,
      namespaceId: id,
    })
    const runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
    runner.implementWorkflow(workspaceIndex.spec, workspaceIndex.fn)
    runner.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
    const worker = runner.newWorker({ concurrency: 2 })
    try {
      git("init", "-b", "main")
      const expected = Array.from({ length: count }, (_, index) => ({
        path: `document-${String(index).padStart(3, "0")}.md`,
        body: `# Document ${index}\nCommitted body ${index}.\n`,
      }))
      for (const file of expected)
        writeFileSync(join(directory, file.path), file.body)
      git("add", ".")
      git(
        "-c",
        "user.name=Contract",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Immutable fixture",
      )
      const sha = git("rev-parse", "HEAD")
      const remote = join(directory, "remote.git")
      git("clone", "--bare", directory, remote)
      const workspaceUrl = github
        ? "https://github.com/fixture/hydration-contract.git"
        : remote
      if (github) {
        const gitConfig = join(directory, "fixture-git-config")
        git(
          "config",
          "--file",
          gitConfig,
          `url.${remote}.insteadOf`,
          workspaceUrl,
        )
        process.env.GIT_CONFIG_GLOBAL = gitConfig
        process.env.GITHUB_APP_ID = "12345"
        process.env.GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey
      }
      for (const file of expected)
        writeFileSync(join(directory, file.path), "Uncommitted replacement\n")
      await getSystemDb()
        .insert(organizations)
        .values({ ...org, createdAt: new Date() })
      if (github) {
        await withOrgDbContext(org.id, (db) =>
          db.insert(connections).values({
            id: connectionId,
            orgId: org.id,
            type: "github",
            config: {
              installationId: 123456789,
              ingestAllRepositories: false,
              includeFutureRepos: false,
            },
          }),
        )
      }
      await withOrgDbContext(org.id, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId: org.id,
          slug: id,
          displayName: org.name,
          workspaceRepositoryUrl: workspaceUrl,
          githubConnectionId: github ? connectionId : null,
          desiredSha: missingTip ? null : sha,
          desiredGeneration: 1,
          indexedSha: sha,
          writeStatus: writeStatus ?? "unknown",
        }),
      )
      const handle = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        generation: 1,
        url: workspaceUrl,
        ...(missingTip ? {} : { sha }),
      })
      if (relink) {
        await withOrgDbContext(org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredGeneration: 2 })
            .where(eq(workspaces.id, workspaceId)),
        )
      }
      const gitTrace = join(directory, "git-trace.jsonl")
      process.env.GIT_TRACE2_EVENT = gitTrace
      await worker.start()
      if (missingTip) {
        await expect(handle.result({ timeoutMs: 30_000 })).rejects.toThrow(
          "Could not resolve the git tip",
        )
        await withOrgIdContext(org, async () => {
          expect(
            await getWorkspaceProjectionSnapshot(workspaceId),
          ).toMatchObject({
            projection: { kind: "failed", desired: null, previous: null },
            units: [],
          })
        })
        return
      }
      if (relink) {
        expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: false,
          reason: "cas_discarded",
        })
        await withOrgIdContext(org, async () => {
          expect(
            (await listWorkspaceKnowledgeUnits(workspaceId)).units,
          ).toEqual([])
          const workspace = await getWorkspaceById(workspaceId)
          expect(workspace?.desiredGeneration).toBe(2)
          expect(workspace?.activeProjectionSha).toBeNull()
        })
        return
      }
      expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: true,
        units: count,
        skipped: 0,
      })
      const run = await backend.getWorkflowRun({
        workflowRunId: handle.workflowRun.id,
      })
      expect(run?.status).toBe("completed")
      // Seed the independent derived-store result for the no-op hydration cases.
      // Index failure and generation changes below must not reuse this result.
      await withOrgIdContext(org, async () => {
        const active = await getWorkspaceProjection(workspaceId)
        if (active.kind !== "active")
          throw new Error("Expected active revision")
        await persistWorkspaceIndexResult({
          revision: active.revision,
          result: { kind: "ready" },
        })
      })
      const gitCommands = readFileSync(gitTrace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === "start" && !event.sid.includes("/"))
      expect(
        gitCommands.length,
        "native git command budget per immutable tree",
      ).toBeLessThanOrEqual(8)
      if (github) {
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
        invalidateGithubAppCacheForConnection(connectionId)
        failGithubTokens = true
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
        if (indexAuthFailure) {
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
            workspaceId,
            gitUrl: workspaceUrl,
            desiredSha: sha,
            role: "workspace",
            jobGeneration: 1,
            jobWorkspaceUrl: workspaceUrl,
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
        }
      }
      await withOrgIdContext(org, async () => {
        const projection = await listWorkspaceKnowledgeUnits(workspaceId)
        expect(
          projection.units
            .map(({ path, body }) => ({ path, body }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(expected)
        const workspace = await getWorkspaceById(workspaceId)
        expect(workspace?.activeProjectionSha).toBe(sha)
        expect(workspace?.hydratePhases?.embeddings).toBe(
          !embeddingFailure && !incompleteEmbeddings,
        )
      })
      if (incompleteEmbeddings) {
        await withOrgIdContext(org, async () => {
          expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
            kind: "active",
            stores: { embeddings: { kind: "failed" } },
          })
        })
      }
      if (projectionFiles) {
        const active = await withOrgIdContext(org, () =>
          getWorkspaceProjection(workspaceId),
        )
        if (active.kind !== "active")
          throw new Error("Expected active revision")
        await withOrgDbContext(org.id, (db) =>
          db
            .update(workspaces)
            .set({
              desiredGeneration: 2,
              workspaceRepositoryUrl: "file:///unavailable-replacement.git",
            })
            .where(eq(workspaces.id, workspaceId)),
        )
        const read = {
          workspaceId,
          gitUrl: workspaceUrl,
          revision: active.revision,
        }
        await withOrgIdContext(org, async () => {
          expect(await listWorkspaceCheckoutPaths(read)).toEqual([
            "document-000.md",
          ])
          const file = await readWorkspaceCheckoutFile({
            ...read,
            path: "document-000.md",
          })
          expect(
            await readWorkspaceCheckoutFile({ ...read, path: "missing.md" }),
          ).toEqual({ kind: "missing" })
          expect(file.kind).toBe("bytes")
          if (file.kind === "bytes")
            expect(Buffer.from(file.bytes).toString("utf8")).toBe(
              "# Document 0\nCommitted body 0.\n",
            )
        })
      }
      if (indexIdentity) {
        const active = await withOrgIdContext(org, () =>
          getWorkspaceProjection(workspaceId),
        )
        if (active.kind !== "active")
          throw new Error("Expected active revision")
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
          workspaceId,
          gitUrl: workspaceUrl,
          desiredSha: sha,
          role: "workspace",
          jobGeneration: 1,
          jobWorkspaceUrl: workspaceUrl,
          revision: active.revision,
        })
        expect(await stale.result({ timeoutMs: 30_000 })).toEqual({
          published: false,
          reason: "cas_discarded",
        })
      }
      if (enqueue) {
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
              remote: { url: workspaceUrl, githubConnectionId: null },
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
      }
      if (indexFailure) {
        const indexRun = await runner.runWorkflow(workspaceIndex.spec, {
          orgId: org.id,
          workspaceId,
          gitUrl: workspaceUrl,
          desiredSha: sha,
          role: "workspace",
          jobGeneration: 1,
          jobWorkspaceUrl: workspaceUrl,
        })
        expect(await indexRun.result({ timeoutMs: 30_000 })).toEqual({
          published: false,
          reason: "no_repository",
        })
        await withOrgIdContext(org, async () => {
          expect(
            await getWorkspaceProjectionSnapshot(workspaceId),
          ).toMatchObject({
            projection: {
              kind: "active",
              revision: { generation: 1, sha },
              stores: {
                embeddings: { kind: "ready" },
                index: { kind: "failed" },
              },
            },
            units: expected,
          })
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
      }
      if (embeddingFailure) {
        await withOrgIdContext(org, async () => {
          expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
            kind: "active",
            revision: { generation: 1, sha },
            stores: { embeddings: { kind: "failed" } },
          })
        })
        rmSync(remote, { recursive: true, force: true })
        failEmbeddings = false
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
      }
      if (history) {
        const selectRevision = (targetSha: string, previousSha: string) =>
          withOrgIdContext(org, async () => {
            expect(
              await persistResolvedDesiredSha({
                workspaceId,
                resolvedTip: targetSha,
                expectedGeneration: 1,
                expectedUrl: workspaceUrl,
                expectedDesiredSha: previousSha,
              }),
            ).toBe(true)
            // This case isolates PostgreSQL activation; index completion is fixture state.
            expect(
              await persistIndexedSha({
                workspaceId,
                indexedSha: targetSha,
                expectedGeneration: 1,
                expectedUrl: workspaceUrl,
                expectedDesiredSha: targetSha,
              }),
            ).toBe(true)
            const revision = await captureWorkspaceRevision({
              workspaceId,
              expected: {
                generation: 1,
                url: workspaceUrl,
                sha: targetSha,
                githubConnectionId: null,
                defaultBranch: "main",
              },
              tip: { sha: targetSha, branch: "main" },
            })
            if (!revision) throw new Error("Fixture revision was not captured")
            return revision
          })
        const readSnapshot = () =>
          withOrgIdContext(org, () =>
            getWorkspaceProjectionSnapshot(workspaceId),
          )
        rmSync(join(directory, "document-000.md"))
        writeFileSync(
          join(directory, "replacement.md"),
          "# Replacement\nNew committed content.\n",
        )
        writeFileSync(
          join(directory, "broken.md"),
          "---\nUnclosed front matter\n",
        )
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
        expect(
          replaced.units.map(({ path, body }) => ({ path, body })),
        ).toEqual([
          {
            path: "replacement.md",
            body: "# Replacement\nNew committed content.\n",
          },
        ])
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

        const rejectedRevision = await selectRevision(nextSha, sha)
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
      }
      if (projectionIdentity) {
        const revision = {
          workspaceId,
          generation: 1,
          remote: { url: workspaceUrl, githubConnectionId: null },
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
              return (
                input &&
                typeof input === "object" &&
                !Array.isArray(input) &&
                input.workspaceId === workspaceId &&
                input.role === "workspace" &&
                input.jobGeneration === 2
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
        await withOrgIdContext(org, async () => {
          const [unit] = (await getWorkspaceProjectionSnapshot(workspaceId))
            .units
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
      }
    } finally {
      await worker.stop()
      await backend.stop()
      try {
        await getSystemDb().execute(
          sql`delete from openworkflow.workflow_runs where namespace_id = ${id} or input->>'workspaceId' = ${workspaceId}`,
        )
        await withOrgDbContext(org.id, async (db) => {
          await db.delete(repositories).where(eq(repositories.orgId, org.id))
          await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
          await db.delete(connections).where(eq(connections.id, connectionId))
        })
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, org.id))
      } finally {
        await closeDb()
        invalidateGithubAppCacheForConnection(connectionId)
        server.close()
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(directory, { recursive: true, force: true })
      }
    }
  },
)
