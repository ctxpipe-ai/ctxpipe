import type { ChildProcess } from "node:child_process"

/**
 * The workflow runs that a worker process executes now, for the log line of
 * the worker supervisor when the worker exits (CTX-1705). A worker that the
 * kernel stops (SIGKILL, out of memory) writes no log of its own, so the
 * supervisor names the runs from the last message of the worker.
 *
 * The supervisor sends `{ type: "held-runs-subscribe" }` on the IPC channel
 * of the worker. After that message, the worker sends
 * `{ type: "held-runs", runIds }` each time a run starts or ends. Before it,
 * the worker sends nothing: another parent (a test runner) can own the
 * channel of the process. Node keeps a message in the channel until the
 * first `message` listener, so the subscription is not lost while the CLI
 * loads the workflow files. The state is on `globalThis` because the
 * OpenWorkflow CLI can load the workflow files as more than one module
 * instance.
 */
const stateKey = Symbol.for("ctxpipe.openworkflow.held-runs")
type HeldRunsState = { runIds: Set<string>; subscribed: boolean }
const processGlobals = globalThis as { [stateKey]?: HeldRunsState }
const state = (processGlobals[stateKey] ??= subscribeToSupervisor())

type HeldRunsMessage = { type: "held-runs"; runIds: string[] }
const SUBSCRIBE = "held-runs-subscribe"

function subscribeToSupervisor(): HeldRunsState {
  const created: HeldRunsState = { runIds: new Set(), subscribed: false }
  if (process.channel)
    process.on("message", (message: unknown) => {
      if ((message as { type?: unknown } | null)?.type !== SUBSCRIBE) return
      created.subscribed = true
      // The channel is the supervisor's; it must not keep the worker alive.
      process.channel?.unref()
      sendHeldRuns()
    })
  return created
}

function sendHeldRuns(): void {
  if (!state.subscribed || !process.send || !process.connected) return
  const message: HeldRunsMessage = {
    type: "held-runs",
    runIds: [...state.runIds],
  }
  // With a callback, a send error comes here, not as a process 'error'
  // event, which would stop the worker. The supervisor only logs the ids.
  process.send(message, undefined, {}, () => {})
}

/** Run `work` as the execution of `runId`, and tell the supervisor. */
export async function holdRun<T>(
  runId: string,
  work: () => Promise<T>,
): Promise<T> {
  state.runIds.add(runId)
  sendHeldRuns()
  try {
    return await work()
  } finally {
    state.runIds.delete(runId)
    sendHeldRuns()
  }
}

/**
 * Supervisor side: subscribe to the runs of `child`, and keep its last
 * `held-runs` message. The child must be spawned with an `ipc` entry in
 * `stdio`. Returns a read of the runs that the child held at its last
 * message.
 */
export function trackHeldRuns(child: ChildProcess): () => string[] {
  let last: string[] = []
  child.on("message", (message: unknown) => {
    const m = message as Partial<HeldRunsMessage> | null
    if (m?.type === "held-runs" && Array.isArray(m.runIds))
      last = m.runIds.filter((id): id is string => typeof id === "string")
  })
  child.send({ type: SUBSCRIBE }, undefined, {}, () => {})
  return () => last
}
