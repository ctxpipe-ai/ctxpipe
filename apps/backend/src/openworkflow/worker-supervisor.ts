/**
 * PR preview: supervises `openworkflow worker` and exits the container when
 * OpenWorkflow has been idle long enough for Railway Serverless (>10m no outbound).
 *
 * Requires DATABASE_URL. Optional: OPENWORKFLOW_IDLE_EXIT_SECONDS (default 660),
 * OPENWORKFLOW_IDLE_POLL_MS (default 10000), OPENWORKFLOW_POSTGRES_SCHEMA (default openworkflow).
 */

import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

const DEFAULT_NAMESPACE_ID = "default"
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

async function isWorkflowSystemIdle(sql: postgres.Sql): Promise<boolean> {
  const query = `SELECT (
      (SELECT COUNT(*)::bigint FROM ${openWorkflowSchema}.workflow_runs
        WHERE namespace_id = '${DEFAULT_NAMESPACE_ID}'
        AND status IN ('pending', 'running', 'sleeping'))
      +
      (SELECT COUNT(*)::bigint FROM ${openWorkflowSchema}.step_attempts
        WHERE namespace_id = '${DEFAULT_NAMESPACE_ID}'
        AND status = 'running')
    ) AS busy`
  const rows = await sql.unsafe(query)
  const row = rows[0] as { busy: string | bigint } | undefined
  const busy = Number(row?.busy ?? 1)
  return busy === 0
}

async function main() {
  const databaseUrl = requiredEnv("DATABASE_URL")
  const sql = postgres(databaseUrl, { max: 1 })

  const backendRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  )

  const child = spawn("bunx", ["@openworkflow/cli", "worker", "start"], {
    cwd: backendRoot,
    stdio: "inherit",
    env: process.env,
  })

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
      clearInterval(interval)
      void sql.end({ timeout: 5 }).catch(() => {})
      if (intentionalShutdown || code === 0 || signal === "SIGTERM") {
        resolvePromise()
        return
      }
      reject(new Error(`worker exited with ${code} ${signal ?? ""}`))
    })
  })
}

await main()
