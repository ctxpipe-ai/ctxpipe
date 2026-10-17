// Rejects two workflow patterns:
//
// 1. A `run:` script that puts a value from outside the repository into its
//    text with an expression, for example a branch name or a dispatch input.
//    GitHub writes the value into the script before the shell reads it. Put
//    the value in `env:` and read it from the shell, in double quotes.
// 2. A workflow without a `permissions:` block at the top or on each job.
//    Without it, the GitHub token gets the default permissions of the
//    repository.
//
// Usage: node scripts/ci/check-workflow-inputs.mjs [directory]   (default .github/workflows)

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = resolve(process.argv[2] ?? ".github/workflows")
const root = fileURLToPath(new URL("../..", import.meta.url))
const OUTSIDE_VALUE =
  /\$\{\{[^}]*\b(inputs\.|github\.event\.inputs\.|github\.head_ref\b|github\.ref_name\b|github\.event\.(pull_request\.(title|body|head\.ref|head\.label)|issue\.|comment\.|review\.|head_commit\.|commits\b|workflow_run\.head_branch))[^}]*\}\}/
const failures = []

function indentOf(line) {
  return line.length - line.trimStart().length
}

for (const name of readdirSync(directory).sort()) {
  if (!/\.ya?ml$/.test(name)) continue
  const file = join(directory, name).replace(`${root}/`, "")
  const lines = readFileSync(join(directory, name), "utf8").split("\n")

  let runIndent = -1
  lines.forEach((line, index) => {
    if (line.trim() === "") return
    const indent = indentOf(line)
    if (runIndent >= 0 && indent <= runIndent) runIndent = -1
    const run = line.match(/^(\s*)(-\s+)?run:\s*(.*)$/)
    if (run) {
      runIndent = indent + (run[2]?.length ?? 0)
      // A one-line script is on the same line as `run:`.
      if (!/^[|>]/.test(run[3]) && OUTSIDE_VALUE.test(run[3])) {
        failures.push(`${file}:${index + 1}`)
      }
      return
    }
    if (runIndent >= 0 && OUTSIDE_VALUE.test(line)) {
      failures.push(`${file}:${index + 1}`)
    }
  })

  if (lines.some((line) => /^permissions:/.test(line))) continue
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  let job = null
  const jobsWithout = []
  for (const line of lines.slice(jobsAt + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue
    if (indentOf(line) === 0) break
    const jobName = line.match(/^ {2}([\w-]+):/)
    if (jobName) {
      if (job && !job.permissions) jobsWithout.push(job.name)
      job = { name: jobName[1], permissions: false }
    } else if (job && /^ {4}permissions:/.test(line)) {
      job.permissions = true
    }
  }
  if (job && !job.permissions) jobsWithout.push(job.name)
  if (jobsAt < 0 || jobsWithout.length > 0) {
    failures.push(
      `${file}: no top-level permissions: block, and no permissions: on ${jobsWithout.join(", ") || "its jobs"}`,
    )
  }
}

if (failures.length > 0) {
  console.error(
    [
      ...failures,
      "Put an outside value (an input, a branch name, PR text) in env: and read it as \"$NAME\" in the script. Give each workflow a permissions: block.",
    ].join("\n"),
  )
  process.exit(1)
}
