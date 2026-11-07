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
//   [MANIFEST=<file>] selected.mjs <results dir> <plan.json> <job> [<shard>]
// <plan.json> is the record of the plan job, which the job downloads by the
// artifact id of the plan job. <job> is the ci.yaml job, and <shard> the
// matrix entry of a sharded job. Its plan is `ids` and `rerun`.
// MANIFEST is a manifest that an earlier step listed (pnpm checks:list). A
// step with a credential sets it, so that the check discovery (which imports
// PR code) runs without the credential. The
// script writes the result records to <results dir>/records.ndjson, prints
// them, and prints the end of the log of each check that did not pass. Each
// failed check in `rerun` runs once more (rerun-failed.mjs): a stored pass
// has its key, so the merge gate needs a second result. The exit code is
// that of the first run.
try {
  const [, , results, planPath, job, shard] = process.argv
  if (!job || process.argv.length > 6)
    throw new Error(
      "Usage: selected.mjs <results dir> <plan.json> <job> [<shard>]",
    )
  const planned = JSON.parse(readFileSync(planPath, "utf8")).jobs?.[job]
  const plan = Array.isArray(planned)
    ? planned.find((entry) => String(entry.shard) === shard)?.plan
    : planned
  if (!Array.isArray(plan?.ids) || !plan.ids.length)
    throw new Error(
      `the plan has no check ids for ${job}${shard ? ` shard ${shard}` : ""}`,
    )
  const directory = resolve(results)
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
