import { getHeapStatistics } from "node:v8"

import { log } from "../observability/logger.js"
import { guardedStepsInFlight, WORKER_BOOT_ID } from "./crash-loop.js"
import { mib } from "./worker-heap.js"

/** Bytes that the worker uses now. */
type MemorySample = { heapUsed: number; heapLimit: number; rss: number }

function sampleMemory(): MemorySample {
  const heap = getHeapStatistics()
  return {
    heapUsed: heap.used_heap_size,
    heapLimit: heap.heap_size_limit,
    rss: process.memoryUsage.rss(),
  }
}

/**
 * Returns a check that logs an error when the worker uses 85% of its heap
 * limit or 85% of the memory of its container (`memoryBytes`), at most once
 * a minute. The error names the ingestion steps that run now (the steps in
 * `withCrashLoopGuard`), so a log search finds the step that used the memory
 * before Node or the platform stops the worker. It does not name other
 * steps. evlog writes
 * the line to stdout at once, so the line is in the platform logs also when
 * the process stops before the OTLP export.
 */
export function memoryPressureCheck(
  memoryBytes: number,
  sample: () => MemorySample = sampleMemory,
): () => void {
  let loggedAt = Number.NEGATIVE_INFINITY
  return () => {
    const now = sample()
    const near =
      now.heapUsed >= 0.85 * now.heapLimit
        ? "heap"
        : now.rss >= 0.85 * memoryBytes
          ? "container"
          : undefined
    if (!near || Date.now() - loggedAt < 60_000) return
    loggedAt = Date.now()
    const steps = guardedStepsInFlight()
    log.error({
      step: "openworkflow.memory-near-limit",
      message: `The worker is near its ${near} memory limit during ${steps.length ? steps.map((s) => `${s.workflow ?? "workflow"} ${s.workflowRunId} step ${s.stepName}`).join(", ") : "no ingestion step"}`,
      limit: near,
      heapUsedMib: mib(now.heapUsed),
      heapLimitMib: mib(now.heapLimit),
      rssMib: mib(now.rss),
      memoryMib: mib(memoryBytes),
      runningSteps: steps.map((s) => s.stepName).join(","),
      workflowRunIds: steps.map((s) => s.workflowRunId).join(","),
      workerBootId: WORKER_BOOT_ID,
    })
  }
}
