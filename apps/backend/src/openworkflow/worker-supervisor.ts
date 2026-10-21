/**
 * PR preview: supervises `openworkflow worker` and exits the container when
 * OpenWorkflow has been idle long enough for Railway Serverless (>10m no outbound).
 * Elsewhere it starts the worker and waits for it.
 *
 * The worker image runs this file under Node, bundled by `bun build`, and the
 * worker child is the OpenWorkflow CLI under Node. No long-lived process of
 * the worker container runs on Bun: a Bun 1.4.2 panic in this process once
 * stopped a healthy worker (CTX-971). Run it from the backend folder.
 *
 * Requires DATABASE_URL. Optional: OPENWORKFLOW_IDLE_EXIT_SECONDS (default 660),
 * OPENWORKFLOW_IDLE_POLL_MS (default 10000), OPENWORKFLOW_POSTGRES_SCHEMA (default openworkflow),
 * OPENWORKFLOW_IDLE_STALE_AFTER_HOURS (default 3) — runs/steps older than this are ignored for idle detection.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { resolve } from "node:path"
import process from "node:process"
import postgres from "postgres"
import { openworkflowWorkerStartArgs } from "./codesearchCapacity.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/** Same namespace the worker claims from; PR previews run in `preview-pr-N`, not `default`. */
const NAMESPACE_ID = openWorkflowNamespaceId()
const DEFAULT_SCHEMA = "openworkflow"
const DEFAULT_IDLE_EXIT_SEC = 660
const DEFAULT_POLL_MS = 10_000

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

function quoteIdentifier(ident: string): string {
  if (!/^[a-zA-Z_]\w*$/.test(ident)) {
    throw new Error(`Invalid OpenWorkflow schema identifier: ${ident}`)
  }
  return `"${ident.replaceAll('"', '""')}"`
}

const openWorkflowSchema = quoteIdentifier(
  process.env.OPENWORKFLOW_POSTGRES_SCHEMA ?? DEFAULT_SCHEMA,
)
const idleExitSeconds = Math.max(
  120,
  Number.parseInt(
    process.env.OPENWORKFLOW_IDLE_EXIT_SECONDS ?? String(DEFAULT_IDLE_EXIT_SEC),
    10,
  ) || DEFAULT_IDLE_EXIT_SEC,
)
const pollMs = Math.max(
  1000,
  Number.parseInt(
    process.env.OPENWORKFLOW_IDLE_POLL_MS ?? String(DEFAULT_POLL_MS),
    10,
  ) || DEFAULT_POLL_MS,
)
/** Only count work started (or created if pending) within this window so stuck rows do not block sleep. */
const staleAfterHours = Math.max(
  1,
  Math.min(
    168,
    Number.parseInt(
      process.env.OPENWORKFLOW_IDLE_STALE_AFTER_HOURS ?? "3",
      10,
    ) || 3,
  ),
)

async function isWorkflowSystemIdle(sql: postgres.Sql): Promise<boolean> {
  const query = `SELECT (
      (SELECT COUNT(*)::bigint FROM ${openWorkflowSchema}.workflow_runs
        WHERE namespace_id = $1
        AND status IN ('pending', 'running', 'sleeping')
        AND COALESCE(started_at, created_at) >= (NOW() - (${staleAfterHours} * INTERVAL '1 hour')))
      +
      (SELECT COUNT(*)::bigint FROM ${openWorkflowSchema}.step_attempts
        WHERE namespace_id = $1
        AND status = 'running'
        AND COALESCE(started_at, created_at) >= (NOW() - (${staleAfterHours} * INTERVAL '1 hour')))
    ) AS busy`
  const rows = await sql.unsafe(query, [NAMESPACE_ID])
  const row = rows[0] as { busy: string | bigint } | undefined
  const busy = Number(row?.busy ?? 1)
  return busy === 0
}

function isRailwayPrPreview(): boolean {
  const name = process.env.RAILWAY_ENVIRONMENT_NAME?.trim()
  return Boolean(name?.startsWith("pr-"))
}

/**
 * Idle-exit when PR deploy opts in. Prefer explicit flags over Railway env name:
 * RAILWAY_ENVIRONMENT_NAME is not always present, which previously left the
 * worker running forever and blocked Serverless sleep.
 */
function shouldIdleExitOnEmptyQueue(): boolean {
  return (
    process.env.OPENWORKFLOW_PR_IDLE_EXIT === "true" ||
    process.env.OPENWORKFLOW_IDLE_EXIT_SECONDS != null ||
    isRailwayPrPreview()
  )
}

/**
 * The OpenWorkflow CLI from the backend's own dependencies. Its bin runs
 * Node; `bunx` would keep a Bun process between this one and the worker.
 */
function startOpenworkflowWorker(backendRoot: string): ChildProcess {
  const [, ...args] = openworkflowWorkerStartArgs()
  return spawn(resolve(backendRoot, "node_modules/.bin/openworkflow"), args, {
    cwd: backendRoot,
    stdio: "inherit",
    env: process.env,
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
  const databaseUrl = requiredEnv("DATABASE_URL")
  const backendRoot = process.cwd()

  if (!shouldIdleExitOnEmptyQueue()) {
    const child = startOpenworkflowWorker(backendRoot)
    const stopping = forwardStopSignals(child)
    await new Promise<void>((resolvePromise, reject) => {
      child.on("error", reject)
      child.on("exit", (code, signal) => {
        logWorkerExit(code, signal)
        if (stopping() || code === 0 || signal === "SIGTERM") resolvePromise()
        else reject(new Error(`worker exited with ${code} ${signal ?? ""}`))
      })
    })
    return
  }

  const sql = postgres(databaseUrl, { max: 1 })

  const child = startOpenworkflowWorker(backendRoot)
  const stopping = forwardStopSignals(child)

  let consecutiveIdlePolls = 0
  const pollsNeeded = Math.ceil((idleExitSeconds * 1000) / pollMs)
  let intentionalShutdown = false

  const interval = setInterval(() => {
    void (async () => {
      try {
        if (child.exitCode !== null) return
        const idle = await isWorkflowSystemIdle(sql)
        if (idle) {
          consecutiveIdlePolls += 1
          if (consecutiveIdlePolls >= pollsNeeded) {
            clearInterval(interval)
            intentionalShutdown = true
            child.kill("SIGTERM")
            setTimeout(() => {
              child.kill("SIGKILL")
            }, 15_000).unref?.()
          }
        } else {
          consecutiveIdlePolls = 0
        }
      } catch {
        consecutiveIdlePolls = 0
      }
    })()
  }, pollMs)

  await new Promise<void>((resolvePromise, reject) => {
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      logWorkerExit(code, signal)
      clearInterval(interval)
      void sql.end({ timeout: 5 }).catch(() => {})
      if (
        intentionalShutdown ||
        stopping() ||
        code === 0 ||
        signal === "SIGTERM" ||
        code === 143
      ) {
        resolvePromise()
        return
      }
      reject(new Error(`worker exited with ${code} ${signal ?? ""}`))
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
