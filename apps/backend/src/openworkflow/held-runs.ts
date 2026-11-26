import type { ChildProcess } from "node:child_process"

/**
 * The workflow runs that a worker process executes now, for the log line of
 * the worker supervisor when the worker exits (CTX-1705). A worker that the
 * kernel stops (SIGKILL, out of memory) writes no log of its own, so the
 * supervisor names the runs from the last message of the worker.
 *
 * The worker sends `{ type: "held-runs", runIds }` on its IPC channel each
 * time a run starts or ends. It sends only when the supervisor set
 * `SUPERVISOR_IPC_ENV` in its environment: another parent (a test runner)
 * can own the channel of the process. The set is on `globalThis` because the OpenWorkflow CLI can load
 * the workflow files as more than one module instance.
 */
const heldRunsKey = Symbol.for("ctxpipe.openworkflow.held-runs")
const processGlobals = globalThis as { [heldRunsKey]?: Set<string> }
const heldRuns = (processGlobals[heldRunsKey] ??= new Set())

/** Set by the supervisor in the environment of the worker that it spawns. */
export const SUPERVISOR_IPC_ENV = "CTXPIPE_WORKER_SUPERVISOR_IPC"
const toSupervisor = process.env[SUPERVISOR_IPC_ENV] === "1"
// The channel must not keep the worker alive after its work stops.
if (toSupervisor) process.channel?.unref()

type HeldRunsMessage = { type: "held-runs"; runIds: string[] }

function sendHeldRuns(): void {
  if (!toSupervisor || !process.send || !process.connected) return
  const message: HeldRunsMessage = { type: "held-runs", runIds: [...heldRuns] }
  // With a callback, a send error comes here, not as a process 'error'
  // event, which would stop the worker. The supervisor only logs the ids.
  process.send(message, undefined, {}, () => {})
}

/** Run `work` as the execution of `runId`, and tell the supervisor. */
export async function holdRun<T>(
  runId: string,
  work: () => Promise<T>,
): Promise<T> {
  heldRuns.add(runId)
  sendHeldRuns()
  try {
    return await work()
  } finally {
    heldRuns.delete(runId)
    sendHeldRuns()
  }
}

/**
 * Supervisor side: keep the last `held-runs` message of `child`. The child
 * must be spawned with an `ipc` entry in `stdio`. Returns a read of the runs
 * that the child held at its last message.
 */
export function trackHeldRuns(child: ChildProcess): () => string[] {
  let last: string[] = []
  child.on("message", (message: unknown) => {
    const m = message as Partial<HeldRunsMessage> | null
    if (m?.type === "held-runs" && Array.isArray(m.runIds))
      last = m.runIds.filter((id): id is string => typeof id === "string")
  })
  return () => last
}
