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
  getDesiredWorkspaceRevision,
  getWorkspaceProjection,
  getWorkspaceProjectionSnapshot,
  listWorkspaceKnowledgeUnits,
  persistEmbeddingFailure,
  persistHydrateFailure,
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

type NativeHydrationOptions = {
  count?: number
  github?: boolean
  embeddings?: "ready" | "failed" | "empty"
  missingTip?: boolean
  writeStatus?: "read_only" | "writable"
}

async function createNativeHydrationFixture(
  options: NativeHydrationOptions = {},
) {
  const { count = 1, github = false, writeStatus, missingTip = false } = options
  const embeddingFailure = options.embeddings === "failed"
  const incompleteEmbeddings = options.embeddings === "empty"
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

  let cleanupPromise: Promise<void> | undefined
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      await worker.stop()
      await backend.stop()
      try {
        await getSystemDb().execute(
          sql`delete from openworkflow.workflow_runs where namespace_id = ${id} or input->>'orgId' = ${org.id}`,
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
    })())
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
    const gitTrace = join(directory, "git-trace.jsonl")
    process.env.GIT_TRACE2_EVENT = gitTrace
    return {
      databaseUrl,
      directory,
      id,
      org,
      workspaceId,
      connectionId,
      git,
      tokenRequests,
      backend,
      runner,
      worker,
      expected,
      sha,
      remote,
      workspaceUrl,
      handle,
      gitTrace,
      count,
      cleanup,
      failTokens: () => {
        invalidateGithubAppCacheForConnection(connectionId)
        failGithubTokens = true
      },
      repairEmbeddings: () => {
        failEmbeddings = false
      },
      publish: async () => {
        await worker.start()
        expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: true,
          units: count,
          skipped: 0,
        })
        const run = await backend.getWorkflowRun({
          workflowRunId: handle.workflowRun.id,
        })
        expect(run?.status).toBe("completed")
        await withOrgIdContext(org, async () => {
          const active = await getWorkspaceProjection(workspaceId)
          if (active.kind !== "active")
            throw new Error("Expected active revision")
          await persistWorkspaceIndexResult({
            revision: active.revision,
            result: { kind: "ready" },
          })
        })
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

type NativeHydrationFixture = Awaited<
  ReturnType<typeof createNativeHydrationFixture>
>
async function withNativeHydrationFixture(
  options: NativeHydrationOptions,
  run: (fixture: NativeHydrationFixture) => Promise<void>,
) {
  const fixture = await createNativeHydrationFixture(options)
  try {
    await run(fixture)
  } finally {
    await fixture.cleanup()
  }
}

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

it(
  "records missing desired tip without publishing any units",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({ missingTip: true }, async (f) => {
      const { worker, handle, org, workspaceId } = f
      await worker.start()
      await expect(handle.result({ timeoutMs: 30_000 })).rejects.toThrow(
        "Could not resolve the git tip",
      )
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjectionSnapshot(workspaceId)).toMatchObject(
          {
            projection: { kind: "failed", desired: null, previous: null },
            units: [],
          },
        )
      })
      return
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
  "reads published Files while a replacement remote is unavailable",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      const { org, workspaceId, workspaceUrl } = f
      await f.publish()
      const active = await withOrgIdContext(org, () =>
        getWorkspaceProjection(workspaceId),
      )
      if (active.kind !== "active") throw new Error("Expected active revision")
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
