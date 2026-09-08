import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { FalkorDB } from "falkordb"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaces } from "../db/schema/workspaces.js"
import { resolveWorkspaceReadRevision } from "../domain/workspaces/resolve-revision.js"
import { invalidateGithubAppCacheForConnection } from "../models/github-installation.js"
import {
  getWorkspaceProjection,
  persistWorkspaceIndexResult,
} from "../models/workspaces.js"
import { repositoryIndex } from "../openworkflow/workflows/repository-index.js"
import { workspaceHydrate } from "../openworkflow/workflows/workspace-hydrate.js"
import { workspaceIndex } from "../openworkflow/workflows/workspace-index.js"
import { workspaceTipCheck } from "../openworkflow/workflows/workspace-tip-check.js"
import { closeGraphDb } from "../platform/graph/client.js"

export type NativeHydrationOptions = {
  files?: Array<{ path: string; body: string; mode?: "100755" | "120000" }>
  initialCommitDate?: string
  count?: number
  github?: boolean
  githubWriteView?: "writable" | "missing"
  embeddings?: "ready" | "failed" | "empty"
  missingTip?: boolean
  writeStatus?: "read_only" | "writable"
}

async function createNativeHydrationFixture(
  options: NativeHydrationOptions = {},
) {
  const { github = false, writeStatus, missingTip = false } = options
  const count = options.files?.length ?? options.count ?? 1
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
  let beforeWriteCredential: (() => Promise<void>) | undefined
  const server = setupServer(
    http.post(
      "https://api.github.com/app/installations/123456789/access_tokens",
      async ({ request }) => {
        const body = await request.text()
        const requestBody = body ? JSON.parse(body) : {}
        tokenRequests.push(requestBody)
        const writing = requestBody.permissions?.contents === "write"
        if (writing) await beforeWriteCredential?.()
        if (failGithubTokens)
          return HttpResponse.json(
            { message: "Credential provider unavailable" },
            { status: 400 },
          )
        return HttpResponse.json(
          {
            token: writing
              ? "fixture-only-github-write-token"
              : "fixture-only-github-read-token",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            permissions: {
              contents: writing ? "write" : "read",
              metadata: "read",
            },
          },
          { status: 201 },
        )
      },
    ),
    http.get("https://api.github.com/repos/fixture/hydration-contract", () =>
      options.githubWriteView === "writable"
        ? HttpResponse.json({
            default_branch: "main",
            permissions: { push: true },
          })
        : HttpResponse.json({ message: "Use native Git" }, { status: 404 }),
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/git/trees/:sha",
      () => HttpResponse.json({ message: "Use native Git" }, { status: 404 }),
    ),
    http.post("https://hydrate-model.test/v1/chat/completions", () =>
      HttpResponse.json({
        id: "fixture-subject",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "ctxpipe - Bootstrap workspace knowledge",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
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
  runner.implementWorkflow(workspaceTipCheck.spec, workspaceTipCheck.fn)
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
        await closeGraphDb()
        if (process.env.GRAPH_DB_URI) {
          const graphDb = await FalkorDB.connect({
            url: process.env.GRAPH_DB_URI,
          })
          try {
            if ((await graphDb.list()).includes(org.id))
              await graphDb.selectGraph(org.id).delete()
          } finally {
            await graphDb.close()
          }
        }
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
    const expected =
      options.files ??
      Array.from({ length: count }, (_, index) => ({
        path: `document-${String(index).padStart(3, "0")}.md`,
        body: `# Document ${index}\nCommitted body ${index}.\n`,
      }))
    for (const file of expected) {
      mkdirSync(dirname(join(directory, file.path)), { recursive: true })
      writeFileSync(join(directory, file.path), file.body)
    }
    git("add", ".")
    for (const file of options.files ?? []) {
      if (file.mode) {
        const blob = git("rev-parse", `:${file.path}`)
        git("update-index", "--cacheinfo", `${file.mode},${blob},${file.path}`)
      }
    }
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Contract",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Immutable fixture",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(options.initialCommitDate
            ? {
                GIT_AUTHOR_DATE: options.initialCommitDate,
                GIT_COMMITTER_DATE: options.initialCommitDate,
              }
            : {}),
        },
      },
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
        slug: "knowledge",
        displayName: org.name,
        workspaceRepositoryUrl: workspaceUrl,
        githubConnectionId: github ? connectionId : null,
        desiredSha: missingTip ? null : sha,
        desiredGeneration: 1,
        desiredDefaultBranch: "main",
        indexedSha: sha,
        writeStatus: writeStatus ?? "unknown",
      }),
    )
    const resolveRevision = async () => {
      const resolved = await withOrgIdContext(org, () =>
        resolveWorkspaceReadRevision({
          orgId: org.id,
          workspaceId,
          env: parseEnv(process.env),
        }),
      )
      if (!resolved) throw new Error("Fixture revision could not be captured")
      return resolved.revision
    }
    const revision = await resolveRevision()
    const handle = await runner.runWorkflow(workspaceHydrate.spec, {
      orgId: org.id,
      workspaceId,
      revision,
    })
    const gitTrace = join(directory, "git-trace.jsonl")
    process.env.GIT_TRACE2_EVENT = gitTrace
    return {
      resolveRevision,
      revision,
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
      onWriteCredentialRequest: (callback: () => Promise<void>) => {
        beforeWriteCredential = callback
      },
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

export type NativeHydrationFixture = Awaited<
  ReturnType<typeof createNativeHydrationFixture>
>
export async function withNativeHydrationFixture(
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
