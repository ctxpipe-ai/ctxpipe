/**
 * The database copy of the cutover from Neon to Aurora (CTX-1217). It dumps
 * the source, restores into the empty target, and compares each table. It
 * prints the report as JSON, writes it to `<work-dir>/report.json`, and exits
 * with 1 when a check fails.
 *
 * Give the URLs in the environment, not as arguments, so that no password
 * shows in the process list. Give direct URLs, not a pooler. Give a work
 * directory on the storage of the task only: the dump holds every row, and
 * the copy deletes it at the end. The target URL is the login that owns the
 * restored objects (on Aurora, the master user). Run migrate after the copy:
 * it makes `ctxpipe_app` and its grants.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… \
 *     bun run src/scripts/copyDatabase.ts --work-dir /scratch/copy [--jobs 8]
 *     [--preflight-only] [--cancel-open-runs]
 *
 * `--cancel-open-runs` is for a rehearsal only: it cancels the unfinished
 * OpenWorkflow runs in the copy before a worker starts on it.
 */
import { copyDatabase, preflight } from "../db/copy-database.js"
import { flushEvlog, initEvlog, log } from "../observability/logger.js"

try {
  initEvlog()
} catch {
  // A one-off task gives no app env (AUTH_SECRET). Logs then keep the evlog
  // defaults, as in migrate.ts.
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}.`)
  return value
}

async function main(argv: string[]): Promise<number> {
  const sourceUrl = required("SOURCE_DATABASE_URL")
  const targetUrl = required("TARGET_DATABASE_URL")
  if (argv.includes("--preflight-only")) {
    const report = await preflight(sourceUrl, targetUrl)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.problems.length === 0 ? 0 : 1
  }
  const workDir = flag(argv, "--work-dir")
  if (!workDir) throw new Error("Give --work-dir <directory>.")
  const jobs = Number(flag(argv, "--jobs") ?? 8)
  if (!Number.isInteger(jobs) || jobs < 1)
    throw new Error("--jobs must be a whole number of 1 or more.")
  const report = await copyDatabase({
    sourceUrl,
    targetUrl,
    workDir,
    jobs,
    cancelOpenRuns: argv.includes("--cancel-open-runs"),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.ok ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main(process.argv.slice(2))
} catch (error) {
  // The messages of copyDatabase hold no row data and no password.
  log.error({
    step: "copy-database",
    message: "[copy-database] failed",
    error: error instanceof Error ? error.message : String(error),
  })
}
await flushEvlog()
process.exit(exitCode)
