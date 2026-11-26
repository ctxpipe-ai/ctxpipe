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
import { resolve } from "node:path"
import process from "node:process"

import { openworkflowWorkerStartArgs } from "./codesearchCapacity.js"
import { SUPERVISOR_IPC_ENV, trackHeldRuns } from "./held-runs.js"
import {
  HEAP_SNAPSHOT_DIR,
  mib,
  workerMemoryBytes,
  workerNodeOptions,
} from "./worker-heap.js"

/**
 * The OpenWorkflow CLI from the backend's own dependencies. Its bin runs
 * Node; `bunx` would keep a Bun process between this one and the worker.
 */
function startOpenworkflowWorker(backendRoot: string): ChildProcess {
  const [, ...args] = openworkflowWorkerStartArgs()
  const memoryBytes = workerMemoryBytes()
  const nodeOptions = workerNodeOptions(process.env.NODE_OPTIONS, memoryBytes)
  // Node writes a heap snapshot here before an out-of-memory exit.
  mkdirSync(HEAP_SNAPSHOT_DIR, { recursive: true })
  process.stderr.write(
    `${JSON.stringify({
      level: "info",
      step: "openworkflow.worker-node-options",
      message: `worker Node options: ${nodeOptions}`,
      nodeOptions,
      memoryMib: mib(memoryBytes),
      heapSnapshotDir: HEAP_SNAPSHOT_DIR,
      timestamp: new Date().toISOString(),
    })}\n`,
  )
  // The IPC channel carries the runs that the worker holds (`held-runs.ts`).
  return spawn(resolve(backendRoot, "node_modules/.bin/openworkflow"), args, {
    cwd: backendRoot,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      [SUPERVISOR_IPC_ENV]: "1",
    },
  })
}

/**
 * One JSON line for each worker exit, with the workflow runs that the worker
 * held (`workflowRunIds`, comma-separated). (The restart saved search counts
 * the `openworkflow.config-loaded` lines of each worker start, not these.)
 */
function logWorkerExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  heldRunIds: string[],
) {
  process.stderr.write(
    `${JSON.stringify({
      level: code === 0 || signal === "SIGTERM" ? "info" : "error",
      step: "openworkflow.worker-exited",
      message: `worker exited with ${code} ${signal ?? ""}`.trim(),
      code,
      signal,
      workflowRunIds: heldRunIds.join(","),
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
  const heldRuns = trackHeldRuns(child)
  await new Promise<void>((resolvePromise, reject) => {
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      logWorkerExit(code, signal, heldRuns())
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
