import { execFile } from "node:child_process"
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import pg from "pg"

import { mapPool } from "../lib/mapPool.js"

/*
 * The copy of the production database from Neon into Aurora (CTX-1217, the
 * cutover runbook). It dumps the source with `pg_dump` (directory format,
 * parallel jobs), restores into an empty target with `pg_restore`, and then
 * compares each table of the two databases. The source roles do not exist on
 * the target: the restore uses `--no-owner --no-privileges`, so the target
 * login owns every object. Migrate then makes `ctxpipe_app` and its grants.
 *
 * `pg_dump`, `pg_restore` and a server of the same major version must be
 * on PATH. The copy reads each password from its URL and gives it to the
 * child process in PGPASSWORD, so no password shows in the process list.
 * Give direct URLs, not a pooler (Neon `-pooler`): the checksum sessions set
 * session settings.
 *
 * The output of the tools can hold row values (a COPY or a constraint
 * error), so it goes to a file of mode 0600 in the work directory, never into
 * an error message or a log. The dump directory is deleted at the end.
 */

const exec = promisify(execFile)

const SYSTEM_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'`

type Phase = { name: string; ms: number }

type TableResult = {
  table: string
  sourceRows: string
  targetRows: string | null
  match: boolean
}

type CopyReport = {
  ok: boolean
  phases: Phase[]
  totalMs: number
  preflight: PreflightReport
  dumpBytes: number
  verify: VerifyReport
  canceledRuns?: number
  /** Set when a phase failed. The phases before it keep their times. */
  error?: string
}

type PreflightReport = {
  sourceVersion: string
  targetVersion: string
  clientVersion: string
  sourceBytes: string
  sourceReadOnly: boolean
  extensions: { name: string; source: string; target: string | null }[]
  problems: string[]
}

type VerifyReport = {
  ok: boolean
  tables: TableResult[]
  sequences: { sequence: string; source: string; target: string | null }[]
  objects: { kind: string; source: number; target: number }[]
  problems: string[]
}

type Connection = {
  /** The URL without its password, for `--dbname`. */
  dbname: string
  password: string | undefined
}

/**
 * The libpq form of a URL: its password (from the user part or the
 * `password` parameter) goes to PGPASSWORD, not to the arguments. libpq
 * checks no certificate for `sslmode=require`, so a URL of a remote host
 * gets `sslmode=verify-full` and the system roots: the dump of production
 * crosses the internet. Node-postgres already treats `require` as
 * `verify-full`.
 */
function connection(url: string, verifyRemote: boolean): Connection {
  const parsed = new URL(url)
  const password =
    (parsed.password ? decodeURIComponent(parsed.password) : undefined) ??
    parsed.searchParams.get("password") ??
    undefined
  parsed.password = ""
  parsed.searchParams.delete("password")
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  if (verifyRemote && !local) {
    parsed.searchParams.set("sslmode", "verify-full")
    if (!parsed.searchParams.has("sslrootcert"))
      parsed.searchParams.set("sslrootcert", "system")
  }
  return { dbname: parsed.toString(), password }
}

/**
 * Runs a tool and returns its stdout. Its stderr goes to `<tool>.log` in the
 * work directory (mode 0600), because it can hold row values. A failure
 * names the log and the exit code only.
 */
async function pgTool(
  tool: "pg_dump" | "pg_restore",
  args: string[],
  password: string | undefined,
  workDir: string,
): Promise<string> {
  const logFile = join(workDir, `${tool}.log`)
  try {
    const { stdout, stderr } = await exec(tool, args, {
      env: { ...process.env, PGPASSWORD: password ?? "" },
      maxBuffer: 256 * 1024 * 1024,
    })
    await writeFile(logFile, stderr, { mode: 0o600, flag: "a" })
    return stdout
  } catch (error) {
    const stderr =
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : ""
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "unknown"
    await writeFile(logFile, stderr, { mode: 0o600, flag: "a" })
    throw new Error(
      `${tool} failed (exit ${code}). Its output is in ${logFile}; it can hold row data, so do not paste it into a ticket or a log.`,
    )
  }
}

function pool(url: string, max: number): pg.Pool {
  const created = new pg.Pool({ connectionString: url, max })
  created.on("connect", (client) => {
    // The text form of a row must be the same on both servers, so that one
    // row gives one checksum on each side.
    client
      .query(
        "SET TimeZone = 'UTC'; SET DateStyle = 'ISO, YMD'; SET IntervalStyle = 'postgres'; SET extra_float_digits = 1; SET bytea_output = 'hex'; SET statement_timeout = 0",
      )
      .catch(() => {
        // The next query on this client shows a broken connection.
      })
  })
  return created
}

async function one<T extends pg.QueryResultRow>(
  db: pg.Pool,
  sql: string,
): Promise<T> {
  const row = (await db.query<T>(sql)).rows[0]
  if (!row) throw new Error(`no row from: ${sql}`)
  return row
}

/** Compares dotted versions such as `0.8.0` and `0.8.7`. */
function versionAtLeast(have: string, need: string): boolean {
  const a = have.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const b = need.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

/**
 * Checks before the copy: the same major version on the source, the target
 * and the client tools; every source extension on the target, at the same or
 * a newer version; an empty target. A problem stops the copy.
 */
export async function preflight(
  sourceUrl: string,
  targetUrl: string,
): Promise<PreflightReport> {
  const source = pool(sourceUrl, 1)
  const target = pool(targetUrl, 1)
  try {
    const problems: string[] = []
    for (const [name, url] of [
      ["source", sourceUrl],
      ["target", targetUrl],
    ] as const)
      if (new URL(url).hostname.includes("-pooler"))
        problems.push(
          `The ${name} URL is a pooler. Give the direct URL: the checksums need session settings.`,
        )
    const version = async (db: pg.Pool) =>
      (
        await one<{ v: string }>(
          db,
          "SELECT current_setting('server_version_num') AS v",
        )
      ).v
    const sourceVersion = await version(source)
    const targetVersion = await version(target)
    const { stdout } = await exec("pg_dump", ["--version"])
    const clientVersion = stdout.trim()
    const major = (num: string) => Math.floor(Number(num) / 10_000)
    if (major(sourceVersion) !== major(targetVersion))
      problems.push(
        `The source runs PostgreSQL ${major(sourceVersion)} and the target runs ${major(targetVersion)}. Use the same major version: the checksums compare the text form of each row.`,
      )
    const clientMajor = Number(/(\d+)\.\d+/.exec(clientVersion)?.[1] ?? 0)
    if (clientMajor < major(sourceVersion))
      problems.push(
        `pg_dump is version ${clientMajor}, older than the source (${major(sourceVersion)}). Use the client tools of the source version.`,
      )

    const sourceExtensions = (
      await source.query<{ name: string; version: string }>(
        "SELECT extname AS name, extversion AS version FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname",
      )
    ).rows
    const extensions: PreflightReport["extensions"] = []
    for (const extension of sourceExtensions) {
      // An installed extension keeps its version. A missing one gets the
      // default version when the restore creates it.
      const available = await target.query<{ version: string }>(
        `SELECT coalesce(
           (SELECT extversion FROM pg_extension WHERE extname = $1),
           (SELECT default_version FROM pg_available_extensions WHERE name = $1)
         ) AS version`,
        [extension.name],
      )
      const targetExtension = available.rows[0]?.version ?? null
      extensions.push({
        name: extension.name,
        source: extension.version,
        target: targetExtension,
      })
      if (!targetExtension)
        problems.push(
          `The extension ${extension.name} is not available on the target.`,
        )
      else if (!versionAtLeast(targetExtension, extension.version))
        problems.push(
          `The extension ${extension.name} is ${targetExtension} on the target, older than ${extension.version} on the source.`,
        )
    }

    const used = await one<{ n: string }>(
      target,
      `SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${SYSTEM_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`,
    )
    if (Number(used.n) > 0)
      problems.push(
        `The target database has ${used.n} tables, views or sequences. Restore only into an empty database.`,
      )

    // Row security hides rows from a login that does not own the table and
    // has no BYPASSRLS. Then the dump stops, and the counts are wrong.
    const hidden = await source.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${SYSTEM_SCHEMA} AND c.relrowsecurity
         AND NOT pg_has_role(current_user, c.relowner, 'USAGE')
         AND NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user)
       ORDER BY 1 LIMIT 5`,
    )
    if (hidden.rows.length > 0)
      problems.push(
        `Row security hides rows of ${hidden.rows.map((row) => row.name).join(", ")} from the source login. Use the owner login (on Neon, neondb_owner).`,
      )

    const size = await one<{ bytes: string; readonly: string }>(
      source,
      "SELECT pg_database_size(current_database())::text AS bytes, current_setting('default_transaction_read_only') AS readonly",
    )
    return {
      sourceVersion,
      targetVersion,
      clientVersion,
      sourceBytes: size.bytes,
      sourceReadOnly: size.readonly === "on",
      extensions,
      problems,
    }
  } finally {
    await Promise.all([source.end(), target.end()])
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0
  for (const name of await readdir(directory))
    total += (await stat(join(directory, name))).size
  return total
}

async function tables(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA} AND c.relkind = 'r'
     ORDER BY 1`,
  )
  return rows.map((row) => row.name)
}

/**
 * The row count and an order-free checksum of one table: the sum of the
 * first 64 bits of the md5 of each row's text form.
 */
async function tableDigest(
  db: pg.Pool,
  table: string,
): Promise<{ rows: string; sum: string }> {
  return one<{ rows: string; sum: string }>(
    db,
    `SELECT count(*)::text AS rows,
            coalesce(sum(('x' || left(md5(t::text), 16))::bit(64)::bigint::numeric), 0)::text AS sum
     FROM ONLY ${table} AS t`,
  )
}

async function objectCounts(db: pg.Pool): Promise<Map<string, number>> {
  const { rows } = await db.query<{ kind: string; n: string }>(
    `SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table'
              WHEN 'i' THEN 'index' WHEN 'I' THEN 'partitioned index' WHEN 'S' THEN 'sequence'
              WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE c.relkind::text END AS kind,
            count(*)::text AS n
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SYSTEM_SCHEMA} AND c.relkind NOT IN ('t', 'c')
     GROUP BY 1
     UNION ALL
     SELECT 'constraint', count(*)::text FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE ${SYSTEM_SCHEMA}
     UNION ALL
     SELECT 'function', count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${SYSTEM_SCHEMA} AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     UNION ALL
     SELECT 'trigger', count(*)::text FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SYSTEM_SCHEMA} AND NOT g.tgisinternal
     UNION ALL
     SELECT 'policy', count(*)::text FROM pg_policy y JOIN pg_class c ON c.oid = y.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SYSTEM_SCHEMA}`,
  )
  return new Map(rows.map((row) => [row.kind, Number(row.n)]))
}

/**
 * `last_value` and `is_called` of each sequence, read from the sequence
 * itself: `pg_sequences` gives NULL for each sequence that is not called,
 * whatever its value.
 */
async function sequences(db: pg.Pool): Promise<Map<string, string>> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT format('%I.%I', schemaname, sequencename) AS name
     FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  )
  const values = new Map<string, string>()
  for (const { name } of rows)
    values.set(
      name,
      (
        await one<{ value: string }>(
          db,
          `SELECT last_value || CASE WHEN is_called THEN ' called' ELSE ' not called' END AS value FROM ${name}`,
        )
      ).value,
    )
  return values
}

/**
 * Compares the two databases: the same tables with the same row count and
 * checksum, the same sequence values, and the same number of each kind of
 * object (indexes, constraints, triggers, policies, functions).
 */
export async function verifyDatabaseCopy(
  sourceUrl: string,
  targetUrl: string,
  jobs = 4,
): Promise<VerifyReport> {
  const source = pool(sourceUrl, jobs)
  const target = pool(targetUrl, jobs)
  try {
    const problems: string[] = []
    const sourceTables = await tables(source)
    const targetTables = new Set(await tables(target))
    for (const table of targetTables)
      if (!sourceTables.includes(table))
        problems.push(`The target has the table ${table}, the source has not.`)

    const tableResults = await mapPool(sourceTables, jobs, async (table) => {
      if (!targetTables.has(table)) {
        const from = await tableDigest(source, table)
        problems.push(`The target has no table ${table}.`)
        return {
          table,
          sourceRows: from.rows,
          targetRows: null,
          match: false,
        }
      }
      const [from, to] = await Promise.all([
        tableDigest(source, table),
        tableDigest(target, table),
      ])
      const match = from.rows === to.rows && from.sum === to.sum
      if (!match)
        problems.push(
          from.rows === to.rows
            ? `The rows of ${table} differ (same count ${from.rows}, other checksum).`
            : `${table} has ${from.rows} rows on the source and ${to.rows} on the target.`,
        )
      return { table, sourceRows: from.rows, targetRows: to.rows, match }
    })

    const sourceSequences = await sequences(source)
    const targetSequences = await sequences(target)
    const sequenceResults = [...sourceSequences].map(([sequence, value]) => {
      const copied = targetSequences.get(sequence) ?? null
      if (copied !== value)
        problems.push(
          `The sequence ${sequence} is ${copied ?? "missing"} on the target and ${value} on the source.`,
        )
      return { sequence, source: value, target: copied }
    })

    const sourceObjects = await objectCounts(source)
    const targetObjects = await objectCounts(target)
    const kinds = [
      ...new Set([...sourceObjects.keys(), ...targetObjects.keys()]),
    ].sort()
    const objects = kinds.map((kind) => {
      const counts = {
        kind,
        source: sourceObjects.get(kind) ?? 0,
        target: targetObjects.get(kind) ?? 0,
      }
      if (counts.source !== counts.target)
        problems.push(
          `The source has ${counts.source} of kind ${kind}, the target ${counts.target}.`,
        )
      return counts
    })

    return {
      ok: problems.length === 0,
      tables: tableResults,
      sequences: sequenceResults,
      objects,
      problems,
    }
  } finally {
    await Promise.all([source.end(), target.end()])
  }
}

/**
 * Cancels the OpenWorkflow runs that are not finished, in the target only.
 * A rehearsal does this before a worker starts on the copy, so that the copy
 * does not do the work of production a second time.
 */
async function cancelOpenRuns(targetUrl: string): Promise<number> {
  const target = pool(targetUrl, 1)
  try {
    const result = await target.query(
      `UPDATE openworkflow.workflow_runs
       SET status = 'canceled', worker_id = NULL, available_at = NULL,
           finished_at = now(), updated_at = now()
       WHERE status IN ('pending', 'running', 'sleeping')`,
    )
    return result.rowCount ?? 0
  } finally {
    await target.end()
  }
}

/**
 * Copies the source database into the empty target and verifies the copy.
 * It writes `report.json` into the work directory and returns the report.
 * It throws when the preflight finds a problem or a tool fails; then
 * `report.json` holds the phases that finished and the error. A verify
 * mismatch does not throw: the report has `ok: false`. The dump directory is
 * deleted at the end, because it holds every row of the source.
 */
export async function copyDatabase(options: {
  sourceUrl: string
  targetUrl: string
  /** A directory with space for the dump, on storage of this task only. */
  workDir: string
  jobs: number
  /**
   * Rehearsal only: cancel the unfinished OpenWorkflow runs in the copy,
   * also when verify finds a difference (a rehearsal reads a live source).
   */
  cancelOpenRuns?: boolean
}): Promise<CopyReport> {
  const phases: Phase[] = []
  const started = Date.now()
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const begin = Date.now()
    const result = await fn()
    phases.push({ name, ms: Date.now() - begin })
    return result
  }
  const source = connection(options.sourceUrl, true)
  const target = connection(options.targetUrl, false)
  const dumpDir = join(options.workDir, "dump")
  const jobs = String(options.jobs)
  const reportFile = join(options.workDir, "report.json")
  await mkdir(options.workDir, { recursive: true })

  const partial: Partial<CopyReport> = {}
  try {
    const checks = await timed("preflight", () =>
      preflight(options.sourceUrl, options.targetUrl),
    )
    partial.preflight = checks
    if (checks.problems.length > 0)
      throw new Error(
        `Preflight found problems. Nothing was copied.\n- ${checks.problems.join("\n- ")}`,
      )

    await timed("dump", () =>
      pgTool(
        "pg_dump",
        [
          "--format=directory",
          `--jobs=${jobs}`,
          "--no-owner",
          "--no-privileges",
          "--no-publications",
          "--no-subscriptions",
          `--file=${dumpDir}`,
          `--dbname=${source.dbname}`,
        ],
        source.password,
        options.workDir,
      ),
    )
    const dumpBytes = await directoryBytes(dumpDir)
    partial.dumpBytes = dumpBytes

    await timed("restore", async () => {
      const contents = await pgTool(
        "pg_restore",
        ["--list", dumpDir],
        undefined,
        options.workDir,
      )
      const listFile = join(options.workDir, "restore.list")
      // A login that is not a superuser (the Aurora master user) does not own
      // an extension, so it cannot set the comment of the extension.
      await writeFile(
        listFile,
        contents
          .split("\n")
          .filter((line) => !/^\d+; \d+ \d+ COMMENT \S+ EXTENSION /.test(line))
          .join("\n"),
      )
      await pgTool(
        "pg_restore",
        [
          `--jobs=${jobs}`,
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
          `--use-list=${listFile}`,
          `--dbname=${target.dbname}`,
          dumpDir,
        ],
        target.password,
        options.workDir,
      )
    })

    const verify = await timed("verify", () =>
      verifyDatabaseCopy(options.sourceUrl, options.targetUrl, options.jobs),
    )
    const canceledRuns = options.cancelOpenRuns
      ? await timed("cancel open runs", () => cancelOpenRuns(options.targetUrl))
      : undefined

    const report: CopyReport = {
      ok: verify.ok,
      phases,
      totalMs: Date.now() - started,
      preflight: checks,
      dumpBytes,
      verify,
      canceledRuns,
    }
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`)
    return report
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeFile(
      reportFile,
      `${JSON.stringify({ ...partial, ok: false, phases, totalMs: Date.now() - started, error: message }, null, 2)}\n`,
    )
    throw error
  } finally {
    await rm(dumpDir, { recursive: true, force: true })
  }
}
