import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { eq, sql } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, onTestFinished } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { orgFirstWorkspaces, workspaces } from "../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import { generateObjectId } from "../lib/id.js"
import { repositoryIndex } from "../openworkflow/workflows/repository-index.js"
import { workspaceIndex } from "../openworkflow/workflows/workspace-index.js"
import { workspaceTipCheck } from "../openworkflow/workflows/workspace-tip-check.js"
import { codeSearch } from "../retrieval/services/codeSearch.js"

async function availablePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("No fixture port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const closed = once(child, "close")
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
  try {
    await closed
  } finally {
    clearTimeout(timer)
  }
}

export async function createNativeIndexFixture(
  extraFiles: Record<string, string | Uint8Array> = {},
) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for native index proof")
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-index-workflow-"))
  const namespace = `index_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const org = {
    id: generateObjectId("org"),
    slug: namespace,
    name: "Native index contract",
  }
  const workspaceId = generateObjectId("ws")
  const repositoryId = generateObjectId("repo")
  const savedUrl = process.env.CODESEARCH_URL
  let codesearch: ChildProcess | undefined
  let zoekt: ChildProcess | undefined
  let backend: BackendPostgres | undefined
  let worker: ReturnType<OpenWorkflow["newWorker"]> | undefined
  initDb(databaseUrl)
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await worker?.stop()
      await backend?.stop()
      await stop(codesearch)
      await stop(zoekt)
      try {
        await getSystemDb().execute(
          sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace} or input->>'orgId' = ${org.id}`,
        )
        await withOrgDbContext(org.id, async (db) => {
          await db
            .delete(orgFirstWorkspaces)
            .where(eq(orgFirstWorkspaces.orgId, org.id))
          await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
          await db.delete(repositories).where(eq(repositories.id, repositoryId))
        })
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, org.id))
      } finally {
        await closeDb()
        await rm(directory, { recursive: true, force: true })
        if (savedUrl === undefined) delete process.env.CODESEARCH_URL
        else process.env.CODESEARCH_URL = savedUrl
      }
    })()
    return cleanupPromise
  }
  onTestFinished(cleanup)

  try {
    const remote = join(directory, "remote")
    await mkdir(remote)
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: remote, encoding: "utf8" }).trim()
    git("init", "-b", "trunk")
    await writeFile(
      join(remote, "AGENTS.md"),
      "# Revision search contract\nUse amberquartz instructions.\n",
    )
    await writeFile(
      join(remote, "sample.js"),
      "function publishedHelper() { return 7; }\npublishedHelper();\n",
    )
    for (const [path, content] of Object.entries(extraFiles)) {
      await mkdir(dirname(join(remote, path)), { recursive: true })
      await writeFile(join(remote, path), content)
    }
    git("add", ".")
    git(
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-m",
      "Published search",
    )
    const sha = git("rev-parse", "HEAD")
    const revision: WorkspaceRevision = {
      workspaceId,
      generation: 1,
      remote: { url: remote, connectionId: null },
      defaultBranch: "trunk",
      sha,
      access: "read",
    }
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, createdAt: new Date() })
    await withOrgDbContext(org.id, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId: org.id,
        slug: "knowledge",
        displayName: org.name,
        workspaceRepositoryUrl: remote,
        desiredGeneration: 1,
        desiredSha: sha,
        desiredDefaultBranch: "trunk",
        activeRevision: revision,
        activeProjectionUrl: remote,
        activeProjectionSha: sha,
        hydrateStatus: "ready",
      })
      await db.insert(repositories).values({
        id: repositoryId,
        orgId: org.id,
        name: "Native index",
        gitUrl: remote,
      })
    })
    const cold = join(directory, "zoekt-index")
    const hot = join(directory, "zoekt-hot")
    await mkdir(cold)
    await mkdir(hot)
    const port = await availablePort()
    zoekt = spawn(
      "zoekt-webserver",
      ["-rpc", "-listen", `127.0.0.1:${port}`, "-index", hot],
      { stdio: "ignore" },
    )
    let zoektError: Error | undefined
    zoekt.on("error", (error) => {
      zoektError = error
    })
    await expect
      .poll(
        async () => {
          if (zoektError) throw zoektError
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 1_000)
          try {
            const response = await fetch(`http://127.0.0.1:${port}/`, {
              signal: controller.signal,
            })
            await response.arrayBuffer()
            return response.status
          } catch {
            return 0
          } finally {
            clearTimeout(timer)
          }
        },
        { timeout: 10_000 },
      )
      .toBe(200)
    const ready = join(directory, "codesearch-ready.json")
    codesearch = spawn(
      "bun",
      [
        fileURLToPath(
          new URL("./codesearch-contract-server.ts", import.meta.url),
        ),
        ready,
      ],
      {
        env: {
          ...process.env,
          REPO_CACHE_DIR: join(directory, "repos"),
          ZOEKT_INDEX_DIR: cold,
          ZOEKT_WEBSERVER_URL: `http://127.0.0.1:${port}`,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    )
    let serviceError = ""
    codesearch.stderr?.on("data", (chunk) => {
      serviceError = (serviceError + chunk.toString()).slice(-8000)
    })
    await expect
      .poll(
        async () => {
          if (codesearch?.exitCode !== null)
            throw new Error(serviceError || "Codesearch exited before ready")
          return readFile(ready, "utf8").catch(() => "")
        },
        { timeout: 10_000 },
      )
      .not.toBe("")
    const service = JSON.parse(await readFile(ready, "utf8")) as {
      port: number
    }
    process.env.CODESEARCH_URL = `http://127.0.0.1:${service.port}`
    backend = await BackendPostgres.connect(databaseUrl, {
      runMigrations: false,
      namespaceId: namespace,
    })
    const runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
    runner.implementWorkflow(workspaceIndex.spec, workspaceIndex.fn)
    runner.implementWorkflow(workspaceTipCheck.spec, workspaceTipCheck.fn)
    worker = runner.newWorker({ concurrency: 2 })
    await worker.start()
    const indexInput = { orgId: org.id, revision }
    return {
      databaseUrl,
      directory,
      namespace,
      org,
      workspaceId,
      repositoryId,
      remote,
      git,
      sha,
      revision,
      cold,
      hot,
      runner,
      indexInput,
      cleanup,
      index: async () => {
        const handle = await runner.runWorkflow(workspaceIndex.spec, indexInput)
        expect(await handle.result({ timeoutMs: 30_000 })).toEqual({
          published: true,
          role: "workspace",
        })
        await withOrgIdContext(org, async () => {
          await expect
            .poll(
              async () => {
                const result = await codeSearch(org.id, {
                  workspaceId,
                  query: "amberquartz",
                })
                return result[0]?.response.Files
              },
              { timeout: 10_000 },
            )
            .toMatchObject([{ FileName: "AGENTS.md", Version: sha }])
        })
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export type NativeIndexFixture = Awaited<
  ReturnType<typeof createNativeIndexFixture>
>
export async function withNativeIndexFixture(
  run: (fixture: NativeIndexFixture) => Promise<void>,
  indexed = true,
  extraFiles: Record<string, string | Uint8Array> = {},
) {
  const fixture = await createNativeIndexFixture(extraFiles)
  try {
    if (indexed) await fixture.index()
    await run(fixture)
  } finally {
    await fixture.cleanup()
  }
}
