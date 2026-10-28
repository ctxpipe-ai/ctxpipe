import { spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { main as rerun } from "./rerun-failed.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

// Runs the checks that the merge gate planned for one job of a gated run
// (scripts/checks/README.md, Merge gate), through the public runner. Usage:
//   PLAN='{"ids": [...], "rerun": [...]}' [MANIFEST=<file>] selected.mjs <results dir>
// PLAN is the output of the plan job for this job (or matrix entry).
// MANIFEST is a manifest that an earlier step listed (pnpm checks:list). A
// step with a credential sets it, so that the check discovery (which imports
// PR code) runs without the credential. The
// script writes the result records to <results dir>/records.ndjson, prints
// them, and prints the end of the log of each check that did not pass. Each
// failed check in `rerun` runs once more (rerun-failed.mjs): a stored pass
// has its key, so the merge gate needs a second result. The exit code is
// that of the first run.
try {
  if (process.argv.length !== 3)
    throw new Error("Usage: PLAN=<json> selected.mjs <results dir>")
  const plan = JSON.parse(process.env.PLAN ?? "")
  if (!Array.isArray(plan?.ids) || !plan.ids.length)
    throw new Error("PLAN has no check ids")
  const directory = resolve(process.argv[2])
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "records.ndjson")
  const out = openSync(path, "w")
  let run
  try {
    run = spawnSync(
      process.execPath,
      [
        join(root, "scripts", "checks", "run.mjs"),
        ...(process.env.MANIFEST
          ? ["--manifest", resolve(process.env.MANIFEST)]
          : []),
      ],
      {
        cwd: root,
        input: `${plan.ids.join("\n")}\n`,
        stdio: ["pipe", out, "inherit"],
      },
    )
  } finally {
    closeSync(out)
  }
  if (run.error) throw run.error
  const records = readFileSync(path, "utf8")
  process.stdout.write(records)
  for (const line of records.split("\n").filter(Boolean)) {
    const record = JSON.parse(line)
    if (!["failed", "error"].includes(record.status)) continue
    process.stdout.write(
      `\n::group::${record.status}: ${record.id}${record.message ? ` (${String(record.message).replace(/[\r\n]+/g, " ")})` : ""}\n`,
    )
    const log = record.log && resolve(root, record.log)
    if (log && existsSync(log))
      process.stdout.write(
        `${readFileSync(log, "utf8").split("\n").slice(-200).join("\n")}\n`,
      )
    process.stdout.write("::endgroup::\n")
  }
  if (run.status !== 0 && plan.rerun?.length)
    rerun(directory, new Set(plan.rerun))
  process.exitCode = run.status ?? 1
} catch (error) {
  console.error(`selected: ${error.message}`)
  process.exitCode = 1
}
