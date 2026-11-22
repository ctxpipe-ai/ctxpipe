import { fileURLToPath } from "node:url"

import pg from "pg"

import { flushEvlog, initEvlog, log } from "../observability/logger.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { runMigrations } from "./run-migrations.js"

/*
 * The database of one shard of a serial test lane (scripts/checks/lanes.mjs).
 * The check runner gives each shard its own database, as CI gives each shard
 * job its own Postgres. The shard databases are on the local Postgres of the
 * app role, as the database of a linked worktree (scripts/worktree-db.sh).
 * The name of a shard database is `<base>_<pid>_<shard>`: the pid of the
 * runner process keeps two runs on one checkout apart.
 *
 * CLI, with DATABASE_URL set to the app-role URL of the shard database:
 *   tsx src/db/test-database.ts reset
 *   tsx src/db/test-database.ts drop
 */

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * Runs `work` with a client of the owner on the `postgres` database, and
 * gives it the name of the database of `appUrl`.
 */
async function onServer(
  appUrl: string,
  work: (client: pg.Client, name: string) => Promise<unknown>,
) {
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
    await work(client, name)
  } finally {
    await client.end()
  }
}

// WITH (FORCE) ends the sessions that a stopped run left.
const drop = (client: pg.Client, name: string) =>
  client.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`)

/** Whether the process `pid` runs on this host. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Drops the database of `appUrl` if it is there. */
export async function dropTestDatabase(appUrl: string): Promise<void> {
  await onServer(appUrl, drop)
}

/**
 * Makes the database of `appUrl` new, from the default template, and applies
 * the migrations of this checkout as the owner. The app role must exist:
 * migrate changes no password of it. When the name has the shape
 * `<base>_<pid>_<shard>`, it first drops each database `<base>_<pid>_<n>` of
 * a runner process that does not run now: a run that was stopped before its
 * drop left it.
 */
export async function resetTestDatabase(appUrl: string): Promise<void> {
  await onServer(appUrl, async (client, name) => {
    const base = /^(.+)_\d+_\d+$/.exec(name)?.[1]
    if (base) {
      const { rows } = await client.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
        [`${base}_`],
      )
      for (const { datname } of rows) {
        const pid = /^(\d+)_\d+$/.exec(datname.slice(base.length + 1))?.[1]
        if (pid && !running(Number(pid))) await drop(client, datname)
      }
    }
    await drop(client, name)
    await client.query(`CREATE DATABASE ${quote(name)}`)
  })
  await runMigrations({
    connectionString: ownerUrlForMigrate(appUrl),
    appRolePassword: undefined,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    initEvlog()
  } catch {
    // The check runner can give no app env (AUTH_SECRET). Logs then keep
    // the evlog defaults.
  }
  const [command] = process.argv.slice(2)
  const url = process.env.DATABASE_URL
  let exitCode = 0
  try {
    if (!url) throw new Error("DATABASE_URL is required")
    if (command === "reset") await resetTestDatabase(url)
    else if (command === "drop") await dropTestDatabase(url)
    else throw new Error("Usage: test-database.ts reset|drop")
  } catch (error) {
    exitCode = 1
    log.error({
      step: "test-database",
      message: `[test-database] ${command ?? ""} failed`,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  await flushEvlog()
  process.exit(exitCode)
}
