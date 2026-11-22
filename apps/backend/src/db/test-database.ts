import { fileURLToPath } from "node:url"

import pg from "pg"

import { flushEvlog, initEvlog } from "../observability/logger.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { runMigrations } from "./run-migrations.js"

/*
 * The database of one shard of a serial test lane (scripts/checks/lanes.mjs).
 * The check runner gives each shard its own database, as CI gives each shard
 * job its own Postgres. The shard databases are on the local Postgres of the
 * app role, as the database of a linked worktree (scripts/worktree-db.sh).
 *
 * CLI, with DATABASE_URL set to the app-role URL of the shard database:
 *   tsx src/db/test-database.ts reset
 *   tsx src/db/test-database.ts drop
 */

/** Runs one statement as the owner, on the `postgres` database. */
async function onServer(appUrl: string, sql: (name: string) => string) {
  const owner = new URL(ownerUrlForMigrate(appUrl))
  // The rewrite to the owner is only for a local app role, so this guard
  // keeps the drop away from a hosted database.
  if (owner.toString() === new URL(appUrl).toString())
    throw new Error(
      "A test database must be on a local Postgres, with the URL of the app role ctxpipe_app.",
    )
  const name = decodeURIComponent(owner.pathname.slice(1))
  owner.pathname = "/postgres"
  const client = new pg.Client({ connectionString: owner.toString() })
  await client.connect()
  try {
    await client.query(sql(`"${name.replaceAll('"', '""')}"`))
  } finally {
    await client.end()
  }
}

/**
 * Drops the database of `appUrl` if it is there. WITH (FORCE) ends the
 * sessions that a stopped earlier run left.
 */
export async function dropTestDatabase(appUrl: string): Promise<void> {
  await onServer(
    appUrl,
    (name) => `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
  )
}

/**
 * Makes the database of `appUrl` new, from the default template, and applies
 * the migrations of this checkout as the owner. The app role must exist:
 * migrate changes no password of it.
 */
export async function resetTestDatabase(appUrl: string): Promise<void> {
  await dropTestDatabase(appUrl)
  await onServer(appUrl, (name) => `CREATE DATABASE ${name}`)
  await runMigrations({
    connectionString: ownerUrlForMigrate(appUrl),
    appRolePassword: undefined,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2)
  const url = process.env.DATABASE_URL
  let exitCode = 0
  try {
    if (!url) throw new Error("DATABASE_URL is required")
    if (command === "reset") {
      try {
        initEvlog()
      } catch {
        // The check runner gives no app env (AUTH_SECRET). Logs then keep
        // the evlog defaults.
      }
      await resetTestDatabase(url)
    } else if (command === "drop") await dropTestDatabase(url)
    else throw new Error("Usage: test-database.ts reset|drop")
  } catch (error) {
    exitCode = 1
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
  }
  await flushEvlog()
  process.exit(exitCode)
}
