import { spawn } from "node:child_process"
import { once } from "node:events"
import { resolve } from "node:path"

import { expect, it } from "vitest"

import { trackHeldRuns } from "./held-runs.js"

const backendRoot = resolve(import.meta.dirname, "../..")

/**
 * A worker process that ends one run, holds two more, and then is killed
 * with SIGKILL, as the kernel kills a worker that is out of memory.
 */
const worker = `
import { holdRun } from "./src/openworkflow/held-runs.ts"
await holdRun("run-done", async () => {})
void holdRun("run-a", () => new Promise(() => {}))
void holdRun("run-b", () => new Promise(() => {}))
setTimeout(() => process.kill(process.pid, "SIGKILL"), 200)
`

function startWorker() {
  // One process, as the `exec node` of the worker image: the tsx CLI would
  // run the code in a second child.
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", worker],
    {
      cwd: backendRoot,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  )
}

it("gives the supervisor the runs that a killed worker held", async () => {
  const child = startWorker()
  const heldRuns = trackHeldRuns(child)

  const [, signal] = await once(child, "exit")

  expect(signal).toBe("SIGKILL")
  expect(heldRuns()).toEqual(["run-a", "run-b"])
}, 30_000)

it("sends nothing to a parent that did not subscribe", async () => {
  const child = startWorker()
  const messages: unknown[] = []
  child.on("message", (message) => messages.push(message))

  await once(child, "exit")

  expect(messages).toEqual([])
}, 30_000)
