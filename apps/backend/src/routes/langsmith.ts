import { fileURLToPath } from "node:url"
import assistantsApi from "@langchain/langgraph-api/api/assistants"
import metaApi from "@langchain/langgraph-api/api/meta"
import runsApi from "@langchain/langgraph-api/api/runs"
import storeApi from "@langchain/langgraph-api/api/store"
import threadsApi from "@langchain/langgraph-api/api/threads"
import { registerFromEnv } from "@langchain/langgraph-api/graph/load"
import { ensureContentType } from "@langchain/langgraph-api/http/middleware"
import { queue } from "@langchain/langgraph-api/queue"
import type { Ops, StorageEnv, Store } from "@langchain/langgraph-api/storage"
import { checkpointer } from "@langchain/langgraph-api/storage/checkpoint"
import { FileSystemOps } from "@langchain/langgraph-api/storage/ops"
import { FileSystemPersistence } from "@langchain/langgraph-api/storage/persist"
import { store as graphStore } from "@langchain/langgraph-api/storage/store"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { z } from "zod/v3"
import type { AppEnv } from "../app/env.js"
import * as graphs from "../graphs/index.js"

const backendDir = fileURLToPath(new URL("../../", import.meta.url))
const graphSpecs = Object.fromEntries(
  Object.keys(graphs).map((graphId) => [
    graphId,
    `./src/graphs/index.ts:${graphId}`,
  ]),
)

let langsmithOpsPromise: Promise<Ops> | undefined
let workersStarted = false
let runtimeStartedPromise: Promise<void> | undefined

async function initializeLangsmithOps(): Promise<Ops> {
  await checkpointer.initialize(backendDir)
  await graphStore.initialize(backendDir)
  const opsConn = new FileSystemPersistence<Store>(
    ".langgraphjs_ops.json",
    () => ({
      runs: {},
      threads: {},
      assistants: {},
      assistant_versions: [],
      retry_counter: {},
    }),
  )
  await opsConn.initialize(backendDir)

  const ops = new FileSystemOps(opsConn)
  await registerFromEnv(ops.assistants, graphSpecs, { cwd: backendDir })
  return ops
}

function getLangsmithOps() {
  langsmithOpsPromise ??= initializeLangsmithOps()
  return langsmithOpsPromise
}

function ensureWorkers(ops: Ops) {
  if (workersStarted) return
  workersStarted = true
  void queue(ops).catch((error: unknown) => {
    workersStarted = false
    console.error("Langsmith queue worker stopped unexpectedly", error)
  })
}

function startLangsmithRuntime() {
  runtimeStartedPromise ??= getLangsmithOps()
    .then((ops) => {
      ensureWorkers(ops)
    })
    .catch((error: unknown) => {
      runtimeStartedPromise = undefined
      console.error("Langsmith runtime failed to initialize", error)
    })
  return runtimeStartedPromise
}

function createLangsmithApp() {
  const app = new Hono<StorageEnv>()
  void startLangsmithRuntime()

  app.use(contextStorage())
  app.use("*", async (c, next) => {
    const ops = await getLangsmithOps()
    c.set("LANGGRAPH_OPS", ops)
    await next()
  })

  app.post("/internal/truncate", async (c) => {
    const flags = z
      .object({
        runs: z.boolean().optional(),
        threads: z.boolean().optional(),
        assistants: z.boolean().optional(),
        checkpointer: z.boolean().optional(),
        store: z.boolean().optional(),
      })
      .parse(await c.req.json())
    await c.var.LANGGRAPH_OPS.truncate(flags)
    return c.json({ ok: true })
  })

  app.use(ensureContentType())

  app.route("/", metaApi)
  app.route("/", assistantsApi)
  app.route("/", runsApi)
  app.route("/", threadsApi)
  app.route("/", storeApi)

  return app
}

/**
 * Mounts the embedded LangGraph API under /langsmith.
 */
export function registerLangsmithRoutes(app: Hono<AppEnv>) {
  if (process.env.ENABLE_LANGSMITH !== "true") return

  console.log(
    `Started LangSmith studio:   https://smith.langchain.com/studio/?baseUrl=https://localhost:3000/langsmith`,
  )

  app.route("/langsmith", createLangsmithApp())
}
