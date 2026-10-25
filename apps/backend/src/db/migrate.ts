// The one migrate entry point for hosted (deploy.yaml), Docker Compose, AWS CDK
// and local dev (scripts/db-migrate.sh). Run it with the owner DATABASE_URL.
// DATABASE_APP_PASSWORD is optional when ctxpipe_app exists already.
import { config } from "dotenv"

import { flushEvlog, initEvlog, log } from "../observability/logger.js"
import { describeMigrateError } from "./describe-migrate-error.js"
import { runMigrations } from "./run-migrations.js"

config({ path: ".env.local", quiet: true })
config({ path: ".env", quiet: true })
try {
  initEvlog()
} catch {
  // Hosted and CI migrate jobs give no app env (AUTH_SECRET). Logs then keep
  // the evlog defaults, and errors still go to stderr.
}

let exitCode = 0
try {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[migrate] DATABASE_URL is required")
  await runMigrations({
    connectionString,
    appRolePassword: process.env.DATABASE_APP_PASSWORD || undefined,
  })
  log.info({ step: "migrate", message: "[migrate] done" })
} catch (error) {
  exitCode = 1
  // The whole cause chain: the wrapped message alone hides the statement.
  const message = describeMigrateError(error)
  log.error({ step: "migrate", message: "[migrate] failed", error: message })
  const frames = (error instanceof Error ? (error.stack ?? "") : "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
  process.stderr.write(`${[message, ...frames].join("\n")}\n`)
}
await flushEvlog()
process.exit(exitCode)
