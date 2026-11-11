/**
 * The rehearsal of the cutover database copy (CTX-1217), with synthetic rows
 * of production's shape (no customer data). It migrates a source database,
 * fills it, copies it with copyDatabase, runs migrate on the copy, and
 * prints the time of each phase as JSON on stdout. The progress goes to the
 * log.
 *
 *   bun run src/scripts/cutoverRehearsal.ts --print-shape-query
 *     The read-only query that gives the shape: run it on the source with
 *     `psql -At`, and keep its output as the shape file. It reads only the
 *     table names, the row estimates and the sizes.
 *
 *   bun run src/scripts/cutoverRehearsal.ts [--shape shape.json [--scale 0.1]]
 *     [--default-rows 1000] [--jobs 8]
 *     Local: a Neon-like and an Aurora-like Postgres 17 in Docker. The work
 *     directory is under `node_modules/.cache`, because a Docker VM (Colima)
 *     shares only the home directory.
 *
 *   PGPASSWORD=… bun run src/scripts/cutoverRehearsal.ts --host <host[:port]>
 *     --user <master login> --work-dir <dir> [the options above]
 *     Remote: one server, for example an Aurora cluster of the sandbox
 *     account (`ops/aws-cutover/sandbox-rehearsal`). It makes the databases
 *     `cutover_rehearsal_source` and `cutover_rehearsal_target` as the master
 *     login, and drops them at the end. It refuses a server that holds other
 *     databases. Each connection to a host that is
 *     not loopback uses TLS with a certificate check: the RDS CA bundle for an
 *     RDS host, else the system roots.
 *
 * `--scale` multiplies each row count and each size of the shape. A table
 * that is not in the shape gets `--default-rows`. The run fails when a table
 * of the shape stays much smaller than its size in the shape.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { initLogger } from "evlog"
import pg from "pg"
import { z } from "zod"

import { copyDatabase } from "../db/copy-database.js"
import { runMigrations } from "../db/run-migrations.js"
import { flushEvlog, initEvlog, log } from "../observability/logger.js"
import { flag } from "./cli-args.js"
import { fillSyntheticRows, type TableShape } from "./cutover/synthetic-rows.js"

// The log goes to stderr as JSON lines: stdout holds only the report.
try {
  initEvlog({ stderr: true })
} catch {
  // A one-off task and a local run give no app env (AUTH_SECRET). The evlog
  // defaults would write to stdout, so the log gets the same stderr output
  // here, without the OTLP drain.
  initLogger({
    pretty: false,
    silent: true,
    drain: (ctx) => {
      process.stderr.write(`${JSON.stringify(ctx.event)}\n`)
    },
  })
}

type Phase = { name: string; ms: number }

/** The databases of one rehearsal, and how to remove them. */
type Databases = {
  /** The owner login of the source. */
  sourceUrl: string
  /** A login that can set `session_replication_role` on the source. */
  sourceSuperUrl: string
  /** The login that owns the restored objects (the Aurora master user). */
  targetUrl: string
  remove: () => Promise<void>
}

async function query<T extends pg.QueryResultRow>(
  url: string,
  statement: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<T>(statement, values)).rows
  } finally {
    await client.end()
  }
}

async function timed<T>(
  phases: Phase[],
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now()
  log.info({ step: "cutover-rehearsal", message: `[rehearsal] ${name}` })
  const result = await fn()
  const ms = Date.now() - started
  phases.push({ name, ms })
  log.info({ step: "cutover-rehearsal", message: `[rehearsal] ${name}`, ms })
  return result
}

/**
 * Docker containers with the role models of Neon and Aurora. The container
 * helper loads the CI image pins, which the backend image does not hold, so
 * it loads only in this mode.
 */
async function localDatabases(workRoot: string): Promise<Databases> {
  const { clientToolsDirectory, startPostgresPair } =
    await import("../test/postgres-pair.js")
  process.env.PATH = `${await clientToolsDirectory(workRoot)}:${process.env.PATH ?? ""}`
  const pair = await startPostgresPair(["ctxpipe"])
  return {
    sourceUrl: pair.sourceUrl,
    sourceSuperUrl: pair.sourceSuperUrl,
    targetUrl: pair.targetUrl("ctxpipe"),
    remove: async () => {
      await pair.stop()
      await rm(workRoot, { recursive: true, force: true })
    },
  }
}

/**
 * Two new databases on one server, as its master login. On Aurora the
 * master login (`rds_superuser`) can set `session_replication_role`, so it
 * is the owner and the filler of the source. Each connection to a host that
 * is not loopback uses TLS with a certificate check. node-postgres reads
 * `sslrootcert` as a file, so the system roots get no `sslrootcert`.
 */
async function remoteDatabases(
  host: string,
  user: string,
  workDir: string,
): Promise<Databases> {
  const password = process.env.PGPASSWORD
  if (!password) throw new Error("Set PGPASSWORD to the master password.")
  let server: URL
  try {
    server = new URL(`postgresql://${host}`)
  } catch {
    throw new Error("--host must be <host> or <host>:<port>.")
  }
  if (server.username || server.pathname || server.search)
    throw new Error("--host must be <host> or <host>:<port>.")
  const params = new URLSearchParams()
  if (!["localhost", "127.0.0.1", "[::1]"].includes(server.hostname)) {
    params.set("sslmode", "verify-full")
    if (server.hostname.endsWith(".rds.amazonaws.com")) {
      const bundle = join(workDir, "rds-global-bundle.pem")
      const response = await fetch(
        "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
      )
      if (!response.ok)
        throw new Error(`The RDS CA bundle gave HTTP ${response.status}.`)
      await writeFile(bundle, await response.text())
      params.set("sslrootcert", bundle)
    }
  }
  const url = (database: string) =>
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${server.hostname}:${server.port || "5432"}/${database}?${params}`
  const source = "cutover_rehearsal_source"
  const target = "cutover_rehearsal_target"
  // FORCE ends the sessions of a run that stopped before its cleanup.
  const remove = async () => {
    for (const name of [source, target])
      await query(
        url("postgres"),
        `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
      )
  }
  // The script makes and drops databases and runs migrate: it refuses a
  // server that holds any other database, for example production.
  const others = await query<{ datname: string }>(
    url("postgres"),
    `SELECT datname FROM pg_database
     WHERE NOT datistemplate AND datname <> ALL ($1::text[])`,
    [["postgres", "rdsadmin", source, target]],
  )
  if (others.length > 0)
    throw new Error(
      `The server at --host holds other databases (${others.length}). Use an empty server, such as the sandbox cluster.`,
    )
  await remove()
  try {
    for (const name of [source, target])
      await query(url("postgres"), `CREATE DATABASE ${name}`)
  } catch (error) {
    await remove()
    throw error
  }
  return {
    sourceUrl: url(source),
    sourceSuperUrl: url(source),
    targetUrl: url(target),
    remove,
  }
}

/**
 * A password for `ctxpipe_app` only when the server has no such role. With a
 * password, migrate would also reset the password of an existing role, and
 * the role belongs to the whole server: on a shared server other databases
 * use it.
 */
async function newAppRolePassword(url: string): Promise<string | undefined> {
  const found = await query(
    url,
    "SELECT 1 FROM pg_roles WHERE rolname = 'ctxpipe_app'",
  )
  return found.length > 0 ? undefined : `rehearsal-${Date.now()}`
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--print-shape-query")) {
    // Read-only: one JSON array with the name, the row estimate and the size
    // of each table. No row data. `reltuples` is the estimate of the last
    // ANALYZE, and -1 when the table has none. The counts of
    // `pg_stat_user_tables` restart when a Neon compute suspends.
    process.stdout.write(`SELECT json_agg(t ORDER BY t.bytes DESC) FROM (
  SELECT format('%I.%I', s.schemaname, s.relname) AS "table",
         greatest(c.reltuples, 0)::bigint AS rows,
         pg_table_size(s.relid) AS bytes
  FROM pg_stat_user_tables s
  JOIN pg_class c ON c.oid = s.relid
  WHERE s.schemaname IN ('public', 'openworkflow')
) t;\n`)
    return 0
  }
  const path = flag(argv, "--shape")
  if (argv.includes("--scale") && !path)
    throw new Error("--scale applies to the shape: give --shape too.")
  const scale = Number(flag(argv, "--scale") ?? 1)
  const jobs = Number(flag(argv, "--jobs") ?? 8)
  const defaultRows = Number(flag(argv, "--default-rows") ?? 1000)
  if (!(scale > 0) || !Number.isInteger(jobs) || jobs < 1)
    throw new Error(
      "--scale must be above 0, and --jobs a whole number of 1 or more.",
    )
  const shape: Record<string, TableShape> = {}
  if (path) {
    const shapeFile = z.array(
      z.object({
        table: z.string(),
        rows: z.coerce.number().int().nonnegative(),
        bytes: z.coerce.number().int().nonnegative().optional(),
      }),
    )
    for (const table of shapeFile.parse(
      JSON.parse(await readFile(path, "utf8")),
    ))
      shape[table.table] = {
        rows: Math.round(table.rows * scale),
        ...(table.bytes === undefined
          ? {}
          : { bytes: Math.round(table.bytes * scale) }),
      }
  }

  const host = flag(argv, "--host")
  const workRoot =
    flag(argv, "--work-dir") ??
    fileURLToPath(
      new URL(
        `../../node_modules/.cache/cutover-rehearsal-${Date.now()}`,
        import.meta.url,
      ),
    )
  await mkdir(workRoot, { recursive: true })
  const setup: Phase[] = []
  const databases = await timed(setup, "make databases", () =>
    host
      ? remoteDatabases(host, flag(argv, "--user") ?? "postgres", workRoot)
      : localDatabases(workRoot),
  )
  try {
    await timed(setup, "migrate source", async () =>
      runMigrations({
        connectionString: databases.sourceUrl,
        appRolePassword: await newAppRolePassword(databases.sourceUrl),
      }),
    )
    const filled = await timed(setup, "fill source", () =>
      fillSyntheticRows(
        databases.sourceSuperUrl,
        shape,
        defaultRows,
        (table) => {
          if (table.error)
            log.error({
              step: "cutover-rehearsal",
              message: "[rehearsal] a table refused the synthetic rows",
              table: table.table,
              error: table.error,
            })
        },
      ),
    )
    // The size that each table of the shape has after the fill. A table of
    // the shape that the schema does not have gets no size.
    const sizes = await query<{ table: string; bytes: string | null }>(
      databases.sourceSuperUrl,
      `SELECT t AS "table", pg_table_size(to_regclass(t)) AS bytes
       FROM unnest($1::text[]) AS t`,
      [Object.keys(shape)],
    )
    const shaped = sizes.map(({ table, bytes }) => ({
      table,
      requestedRows: shape[table]?.rows,
      rows: filled.find((result) => result.table === table)?.rows,
      requestedBytes: shape[table]?.bytes,
      bytes: bytes === null ? undefined : Number(bytes),
    }))
    // A table that stays much smaller than its shape makes the window too
    // short, so the run fails. The margin of 1 MiB keeps small tables out:
    // an empty table of the shape has a size of one page.
    const undersized = shaped.filter(
      ({ requestedBytes, bytes }) =>
        requestedBytes !== undefined &&
        bytes !== undefined &&
        bytes < requestedBytes * 0.8 &&
        requestedBytes - bytes > 1024 * 1024,
    )
    // Production is in the state of its last migrate.
    await timed(setup, "migrate source again", () =>
      runMigrations({
        connectionString: databases.sourceUrl,
        appRolePassword: undefined,
      }),
    )

    const report = await timed(setup, "copy", () =>
      copyDatabase({
        sourceUrl: databases.sourceUrl,
        targetUrl: databases.targetUrl,
        workDir: join(workRoot, "copy"),
        jobs,
      }),
    )
    const migrate: Phase[] = []
    await timed(migrate, "migrate", async () =>
      runMigrations({
        connectionString: databases.targetUrl,
        appRolePassword: await newAppRolePassword(databases.targetUrl),
      }),
    )
    const window = [...report.phases, ...migrate].filter(
      (phase) => phase.name !== "preflight",
    )
    const summary = {
      ok:
        report.ok &&
        filled.every((table) => !table.error) &&
        undersized.length === 0,
      mode: host ? "remote" : "local",
      scale,
      jobs,
      sourceBytes: Number(report.preflight.sourceBytes),
      dumpBytes: report.dumpBytes,
      extensions: report.preflight.extensions,
      rows: filled.reduce((sum, table) => sum + table.rows, 0),
      window,
      windowMs: window.reduce((sum, phase) => sum + phase.ms, 0),
      setup,
      shaped,
      undersized: undersized.map(({ table }) => table),
      fillErrors: filled.filter((table) => table.error),
      verifyProblems: report.verify.problems,
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return summary.ok ? 0 : 1
  } finally {
    await databases.remove()
  }
}

let exitCode = 1
try {
  exitCode = await main(process.argv.slice(2))
} catch (error) {
  // No URL in the message: copyDatabase and the pg client name no password.
  log.error({
    step: "cutover-rehearsal",
    message: "[rehearsal] failed",
    error: error instanceof Error ? error.message : String(error),
  })
}
await flushEvlog()
process.exit(exitCode)
