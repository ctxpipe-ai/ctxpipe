/**
 * Supervises `openworkflow worker`: starts it with the Node options of the
 * container, forwards the stop signals, and exits with the worker.
 *
 * The worker image runs this file under Node, bundled by `bun build`, and the
 * worker child is the OpenWorkflow CLI under Node. No long-lived process of
 * the worker container runs on Bun: a Bun 1.4.2 panic in this process once
 * stopped a healthy worker (CTX-971). Run it from the backend folder.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { totalmem } from "node:os"
import { resolve } from "node:path"
import process from "node:process"

import { openworkflowWorkerStartArgs } from "./codesearchCapacity.js"
import { HEAP_SNAPSHOT_DIR, workerNodeOptions } from "./worker-heap.js"

/**
 * The OpenWorkflow CLI from the backend's own dependencies. Its bin runs
 * Node; `bunx` would keep a Bun process between this one and the worker.
 */
function startOpenworkflowWorker(backendRoot: string): ChildProcess {
  const [, ...args] = openworkflowWorkerStartArgs()
  // The container limit (cgroup), or the host memory when there is none.
  const limit = process.constrainedMemory()
  const nodeOptions = workerNodeOptions(
    process.env.NODE_OPTIONS,
    limit > 0 ? Math.min(limit, totalmem()) : totalmem(),
  )
  // Node writes a heap snapshot here before an out-of-memory exit.
  mkdirSync(HEAP_SNAPSHOT_DIR, { recursive: true })
  process.stderr.write(
    `${JSON.stringify({
      level: "info",
      step: "openworkflow.worker-node-options",
      message: `worker Node options: ${nodeOptions}`,
      nodeOptions,
      heapSnapshotDir: HEAP_SNAPSHOT_DIR,
      timestamp: new Date().toISOString(),
    })}\n`,
  )
  return spawn(resolve(backendRoot, "node_modules/.bin/openworkflow"), args, {
    cwd: backendRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  })
}

/**
 * One JSON line for each worker exit. (The restart saved search counts the
 * `openworkflow.config-loaded` lines of each worker start, not these.)
 */
function logWorkerExit(code: number | null, signal: NodeJS.Signals | null) {
  process.stderr.write(
    `${JSON.stringify({
      level: code === 0 || signal === "SIGTERM" ? "info" : "error",
      step: "openworkflow.worker-exited",
      message: `worker exited with ${code} ${signal ?? ""}`.trim(),
      code,
      signal,
      timestamp: new Date().toISOString(),
    })}\n`,
  )
}

/**
 * This process is PID 1 of the container (`exec node`). Send a SIGTERM or a
 * SIGINT on to the worker, so that it stops its OpenWorkflow worker and
 * flushes its logs and traces. `Worker.stop()` waits for each active run
 * with no limit, so after 25 seconds the worker gets SIGKILL. The platform
 * waits 30 seconds before its own SIGKILL (Railway drain time, Compose
 * `stop_grace_period`, ECS `stopTimeout`), so this kill comes first. Returns
 * true after a signal came.
 */
function forwardStopSignals(child: ChildProcess): () => boolean {
  let stopping = false
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      child.kill(signal)
      setTimeout(() => child.kill("SIGKILL"), 25_000).unref()
    })
  return () => stopping
}

async function main() {
  const child = startOpenworkflowWorker(process.cwd())
  const stopping = forwardStopSignals(child)
  await new Promise<void>((resolvePromise, reject) => {
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      logWorkerExit(code, signal)
      if (stopping() || code === 0 || signal === "SIGTERM") resolvePromise()
      else reject(new Error(`worker exited with ${code} ${signal ?? ""}`))
    })
  })
}

try {
  await main()
} catch (err) {
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
}
process.exit(0)
