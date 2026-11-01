import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))

// Reruns each failed check of a nightly job once, through the public runner
// (run.mjs), so that the factory Results writer quarantines a key only when
// its check fails again. Usage:
//   [MANIFEST=<file>] rerun-failed.mjs <results dir>
// It reads each records.ndjson below the directory, and writes the records of
// the rerun to <results dir>/rerun/rerun.ndjson, and the rerun logs to
// <results dir>/rerun/checks. The logs of the first run stay in
// .ci-results/checks. At most 50 checks run again; the others have no rerun
// record, so the writer does not quarantine them. The script prints the number
// of failed checks and of reruns, and writes the ids that did not run again to
// <results dir>/rerun/not-rerun.txt, which the Results writer shows. A failed rerun is data, so
// the exit code is 0; it is 1 only when the rerun cannot start.

// The ids of the failed records below `directory`, sorted, at most `limit`.
export function failedIds(directory, limit = 50) {
  return failedChecks(directory, limit).ids
}

// All failed ids, sorted: `ids` are the first `limit` (they run again) and
// `notRerun` are the others.
export function failedChecks(directory, limit = 50) {
  const ids = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === "records.ndjson")
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue
          const record = JSON.parse(line)
          if (record.status === "failed" && typeof record.id === "string")
            ids.add(record.id)
        }
    }
  }
  if (existsSync(directory)) walk(directory)
  const sorted = [...ids].sort()
  return {
    total: sorted.length,
    ids: sorted.slice(0, limit),
    notRerun: sorted.slice(limit),
  }
}

// With `only`, it runs again only the failed checks in that set (the merge
// gate passes the checks whose key has a stored pass).
export function main(directory, only) {
  const failed = failedChecks(directory, only ? Number.POSITIVE_INFINITY : 50)
  const chosen = only ? failed.ids.filter((id) => only.has(id)) : failed.ids
  const { total, notRerun } = failed
  const ids = chosen.slice(0, 50)
  if (only) notRerun.push(...chosen.slice(50))
  if (!ids.length) {
    console.error("No failed check: nothing to run again.")
    return 0
  }
  const out = join(directory, "rerun")
  mkdirSync(out, { recursive: true })
  console.error(
    `${total} checks failed; ${ids.length} run again, ${notRerun.length} do not.`,
  )
  if (notRerun.length) {
    writeFileSync(join(out, "not-rerun.txt"), `${notRerun.join("\n")}\n`)
    console.error(
      `Not run again (the Results writer does not quarantine their keys):\n${notRerun.join("\n")}`,
    )
  }
  const logs = join(root, ".ci-results", "checks")
  const first = join(root, ".ci-results", "checks-first-run")
  if (existsSync(logs)) renameSync(logs, first)
  const records = openSync(join(out, "rerun.ndjson"), "w")
  try {
    const run = spawnSync(
      process.execPath,
      [
        join(root, "scripts", "checks", "run.mjs"),
        // A step with a credential lists the checks in an earlier step
        // (selected.mjs, MANIFEST), so the rerun lists none either.
        ...(process.env.MANIFEST
          ? ["--manifest", resolve(process.env.MANIFEST)]
          : []),
      ],
      {
        cwd: root,
        input: `${ids.join("\n")}\n`,
        stdio: ["pipe", records, "inherit"],
      },
    )
    if (run.error) throw run.error
    console.error(
      `Ran ${ids.length} failed checks again (exit code ${run.status}).`,
    )
  } finally {
    closeSync(records)
    if (existsSync(logs)) renameSync(logs, join(out, "checks"))
    if (existsSync(first)) renameSync(first, logs)
  }
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3)
      throw new Error("Usage: rerun-failed.mjs <results dir>")
    process.exitCode = main(resolve(process.argv[2]))
  } catch (error) {
    console.error(`rerun-failed: ${error.message}`)
    process.exitCode = 1
  }
}
