/**
 * The rehearsal of the cutover database copy (CTX-1217), with synthetic rows
 * of production's shape (no customer data). It migrates a source database,
 * fills it, copies it with copyDatabase, runs migrate on the copy, and
 * prints the time of each phase as JSON.
 *
 *   bun run src/scripts/cutoverRehearsal.ts --print-shape-query
 *     The read-only query that gives the shape: run it on the source with
 *     `psql -At`, and keep its output as the shape file. It reads only the
 *     table names, the row estimates and the sizes.
 *
 *   bun run src/scripts/cutoverRehearsal.ts [--shape shape.json]
 *     [--scale 0.1] [--default-rows 1000] [--jobs 8] [--keep]
 *     Local: a Neon-like and an Aurora-like Postgres 17 in Docker. The work
 *     directory is under `node_modules/.cache`, because a Docker VM (Colima)
 *     shares only the home directory.
 *
 *   PGPASSWORD=… bun run src/scripts/cutoverRehearsal.ts --host <host[:port]>
 *     --user <master login> --work-dir <dir> [the options above]
 *     Remote: one server, for example an Aurora cluster of the sandbox
 *     account (`ops/aws-cutover/sandbox-rehearsal`). It makes the databases
 *     `cutover_rehearsal_source` and `cutover_rehearsal_target` as the master
 *     login, and drops them at the end. For an RDS host it fetches the RDS CA
 *     bundle, so that each connection checks the certificate.
 *
 * `--scale` multiplies each row count of the shape. Then the report also
 * gives the window at full size, at the same speed. `--keep` leaves the
 * containers or the databases.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

import { copyDatabase } from "../db/copy-database.js"
import { runMigrations } from "../db/run-migrations.js"
import {
  clientToolsDirectory,
  rows,
  sql,
  startPostgresPair,
} from "../test/postgres-pair.js"
import {
  fillSyntheticRows,
  SHAPE_QUERY,
  type TableShape,
} from "../test/synthetic-rows.js"

const shapeFile = z.array(
  z.object({
    table: z.string(),
    rows: z.coerce.number().int().nonnegative(),
    bytes: z.coerce.number().int().nonnegative().optional(),
  }),
)

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

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

function progress(message: string): void {
  process.stderr.write(`[rehearsal] ${message}\n`)
}

async function timed<T>(
  phases: Phase[],
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now()
  progress(`${name}…`)
  const result = await fn()
  phases.push({ name, ms: Date.now() - started })
  progress(`${name}: ${Date.now() - started} ms`)
  return result
}

/** Docker containers with the role models of Neon and Aurora. */
async function localDatabases(workRoot: string): Promise<Databases> {
  process.env.PATH = `${await clientToolsDirectory(workRoot)}:${process.env.PATH ?? ""}`
  const pair = await startPostgresPair(["ctxpipe"])
  return {
    sourceUrl: pair.sourceUrl,
    sourceSuperUrl: pair.sourceSuperUrl,
    targetUrl: pair.targetUrl("ctxpipe"),
    remove: pair.stop,
  }
}

/**
 * Two new databases on one server, as its master login. On Aurora the
 * master login (`rds_superuser`) can set `session_replication_role`, so it
 * is the owner and the filler of the source.
 */
async function remoteDatabases(
  host: string,
  user: string,
  workDir: string,
): Promise<Databases> {
  const password = process.env.PGPASSWORD
  if (!password) throw new Error("Set PGPASSWORD to the master password.")
  const params = new URLSearchParams()
  if (host.endsWith(".rds.amazonaws.com")) {
    const bundle = join(workDir, "rds-global-bundle.pem")
    const response = await fetch(
      "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
    )
    if (!response.ok)
      throw new Error(`The RDS CA bundle gave HTTP ${response.status}.`)
    await writeFile(bundle, await response.text())
    params.set("sslrootcert", bundle)
  }
  const url = (database: string) =>
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host.includes(":") ? host : `${host}:5432`}/${database}?${params}`
  const names = ["cutover_rehearsal_source", "cutover_rehearsal_target"]
  for (const name of names)
    await sql(url("postgres"), `CREATE DATABASE ${name}`)
  return {
    sourceUrl: url(names[0] as string),
    sourceSuperUrl: url(names[0] as string),
    targetUrl: url(names[1] as string),
    remove: async () => {
      for (const name of names)
        await sql(
          url("postgres"),
          `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
        )
    },
  }
}

/**
 * A password for `ctxpipe_app` only when the server has no such role. With a
 * password, migrate would also reset the password of an existing role, and
 * the role belongs to the whole server: on a shared server other databases
 * use it.
 */
async function newAppRolePassword(url: string): Promise<string | undefined> {
  const found = await rows(
    url,
    "SELECT 1 FROM pg_roles WHERE rolname = 'ctxpipe_app'",
  )
  return found.length > 0 ? undefined : `rehearsal-${Date.now()}`
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--print-shape-query")) {
    process.stdout.write(`${SHAPE_QUERY};\n`)
    return 0
  }
  const scale = Number(flag(argv, "--scale") ?? 1)
  const jobs = Number(flag(argv, "--jobs") ?? 8)
  const defaultRows = Number(flag(argv, "--default-rows") ?? 1000)
  if (!(scale > 0) || !Number.isInteger(jobs) || jobs < 1)
    throw new Error(
      "--scale must be above 0, and --jobs a whole number of 1 or more.",
    )
  const path = flag(argv, "--shape")
  const shape: Record<string, TableShape> = {}
  if (path)
    for (const table of shapeFile.parse(
      JSON.parse(await readFile(path, "utf8")),
    ))
      shape[table.table] = {
        rows: Math.round(table.rows * scale),
        ...(table.bytes === undefined
          ? {}
          : { bytes: Math.round(table.bytes * scale) }),
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
          if (table.error) progress(`${table.table}: ${table.error}`)
        },
      ),
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
    const windowMs = window.reduce((sum, phase) => sum + phase.ms, 0)
    const summary = {
      ok: report.ok && filled.every((table) => !table.error),
      mode: host ? "remote" : "local",
      scale,
      jobs,
      sourceBytes: Number(report.preflight.sourceBytes),
      dumpBytes: report.dumpBytes,
      extensions: report.preflight.extensions,
      rows: filled.reduce((sum, table) => sum + table.rows, 0),
      window,
      windowMs,
      ...(scale !== 1
        ? { fullSizeWindowMs: Math.round(windowMs / scale) }
        : {}),
      setup,
      fillErrors: filled.filter((table) => table.error),
      verifyProblems: report.verify.problems,
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return summary.ok ? 0 : 1
  } finally {
    if (argv.includes("--keep")) progress("databases kept")
    else {
      await databases.remove()
      if (!host) await rm(workRoot, { recursive: true, force: true })
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    // No URL in the message: copyDatabase and the pg client name no password.
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  },
)
