import { type ChildProcess, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"

/** The body of a model step of the stand-in sandbox. */
export type IngestModelStep = {
  step: string
  root: string | null
  workspaceId: string
  args?: string[]
}

/**
 * An ingestion v2 worker in a child process, for a test that stops a worker
 * (a crash or a deploy). The child runs the parent and the shard workflow
 * with the stand-in sandbox and the bundle in `bundleDir`. A local server in
 * the test process mints its GitHub tokens and answers its model steps with
 * `reply`; when `reply` gives undefined, the step gets no answer.
 */
export async function ingestChildWorker(input: {
  folder: string
  bundleDir: string
  modelUrl: string
  reply: (body: IngestModelStep) => object | undefined
}) {
  const local = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    response.setHeader("content-type", "application/json")
    if (request.url?.endsWith("/access_tokens")) {
      response.statusCode = 201
      response.end(
        JSON.stringify({
          token: "fixture-only-github-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
        }),
      )
    } else if (request.url === "/v1/step") {
      const reply = input.reply(body)
      if (reply !== undefined) response.end(JSON.stringify(reply))
    } else {
      response.statusCode = 404
      response.end("{}")
    }
  })
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve))
  const address = local.address()
  if (!address || typeof address === "string")
    throw new Error("The local GitHub and model stand-in has no port")
  const proxy = `http://127.0.0.1:${address.port}`
  const require = createRequire(import.meta.url)
  const fileUrl = (path: string) =>
    JSON.stringify(new URL(path, import.meta.url).href)
  const script = join(input.folder, `ingestion-v2-worker-${address.port}.ts`)
  writeFileSync(
    script,
    `
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  return nativeFetch(["api.github.com", "ingest-model.test"].includes(url.hostname)
    ? new Request(${JSON.stringify(proxy)} + url.pathname + url.search, request) : request);
};
const { OpenWorkflow } = await import(${JSON.stringify(pathToFileURL(require.resolve("openworkflow")).href)});
const { BackendPostgres } = await import(${JSON.stringify(pathToFileURL(require.resolve("openworkflow/postgres")).href)});
const { initDb } = await import(${fileUrl("../db/client.ts")});
const { readIngestSkillBundle } = await import(${fileUrl("../domain/ingestion/skill-bundle.ts")});
const { standInIngestShardRuntime } = await import(${fileUrl("./ingest-shard-stand-in.ts")});
const { defineIngestionShardWorkflow } = await import(${fileUrl("../openworkflow/workflows/ingestion-shard.ts")});
const { defineRepositoryIngestionV2Workflow } = await import(${fileUrl("../openworkflow/workflows/repository-ingestion-v2.ts")});
initDb(process.env.DATABASE_URL);
const backend = await BackendPostgres.connect(process.env.DATABASE_URL, { namespaceId: ${JSON.stringify(openWorkflowNamespaceId())}, runMigrations: false });
const runner = new OpenWorkflow({ backend });
const deps = {
  runtime: standInIngestShardRuntime({ modelUrl: ${JSON.stringify(input.modelUrl)}, folder: ${JSON.stringify(input.folder)} }),
  bundle: () => readIngestSkillBundle(${JSON.stringify(input.bundleDir)}),
};
const shard = defineIngestionShardWorkflow(deps);
const parent = defineRepositoryIngestionV2Workflow({ ...deps, shard });
runner.implementWorkflow(shard.spec, shard.fn);
runner.implementWorkflow(parent.spec, parent.fn);
await runner.newWorker({ concurrency: 4 }).start();
await new Promise(() => {});
`,
  )
  const children: ChildProcess[] = []
  let errors = ""
  const kill = (child: ChildProcess) => {
    if (child.pid && child.exitCode === null && child.signalCode === null)
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        // The process group stopped between the check and the kill.
      }
  }
  return {
    /** Start a worker process; `env` adds to the test's environment. */
    launch(env: NodeJS.ProcessEnv = {}): ChildProcess {
      const child = spawn("bun", [script], {
        cwd: input.folder,
        detached: true,
        env: { ...process.env, ...env },
        stdio: ["ignore", "ignore", "pipe"],
      })
      child.stderr?.on("data", (data) => {
        errors = (errors + data.toString()).slice(-8_000)
      })
      children.push(child)
      return child
    },
    /** Stop a worker process at once, as a crash or a deploy does. */
    kill,
    /**
     * Run the test body `fn`. Its error gets the end of the workers' stderr,
     * and each worker process and the local server stop at the end.
     */
    async run<T>(fn: () => Promise<T>): Promise<T> {
      try {
        return await fn()
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nChild worker stderr: ${errors}`,
        )
      } finally {
        for (const child of children) kill(child)
        local.close()
      }
    },
  }
}
