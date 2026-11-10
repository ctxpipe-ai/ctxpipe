/**
 * The database copy of the cutover from Neon to Aurora (CTX-1217). It dumps
 * the source, restores into the empty target, and compares each table. It
 * prints the report as JSON, writes it to `<work-dir>/report.json`, and exits
 * with 1 when a check fails.
 *
 * Give the URLs in the environment, not as arguments, so that no password
 * shows in the process list. The target URL is the login that owns the
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
  const report = await copyDatabase({
    sourceUrl,
    targetUrl,
    workDir,
    jobs: Number(flag(argv, "--jobs") ?? 8),
    cancelOpenRuns: argv.includes("--cancel-open-runs"),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.ok ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  },
)
