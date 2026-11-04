// Checks that a structural change comes with an ADR (AGENTS.md "Architecture
// decisions & ADRs").
//
// - A change that adds an app, a package, or a plugin (a new
//   `apps/*/package.json`, `packages/*/package.json`, or
//   `plugins/*/.claude-plugin/plugin.json`) adds or edits an
//   `.ai/memory/decisions/ADR-*.md` file.
// - A change that adds an ADR file also lists it in
//   `.ai/memory/decisions/index.md`.
//
// Usage: node scripts/ci/check-adr.mjs [repository root] [base ref]
//   (default base: origin/main)

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { changedFiles, fileAtHead } from "./changed-files.mjs"

const structural = [
  /^(apps|packages)\/[^/]+\/package\.json$/,
  /^plugins\/[^/]+\/\.claude-plugin\/plugin\.json$/,
]
const adrPath = /^\.ai\/memory\/decisions\/(ADR-[^/]+)\.md$/

export function adrProblems(files, readAtHead) {
  const problems = []
  const adrs = files.filter((f) => f.status !== "D" && adrPath.test(f.path))
  for (const file of files)
    if (
      file.status === "A" &&
      adrs.length === 0 &&
      structural.some((pattern) => pattern.test(file.path))
    )
      problems.push(
        `${file.path}: a new app, package, or plugin needs an ADR. Add or update one under .ai/memory/decisions/ (capture-adr skill).`,
      )
  const index = readAtHead(".ai/memory/decisions/index.md") ?? ""
  for (const file of adrs)
    if (file.status === "A") {
      const name = adrPath.exec(file.path)[1]
      if (!index.includes(name))
        problems.push(
          `${file.path}: list the new ADR in .ai/memory/decisions/index.md.`,
        )
    }
  return problems
}

function main() {
  const root = resolve(process.argv[2] ?? ".")
  const base = process.argv[3] ?? "origin/main"
  const problems = adrProblems(changedFiles(root, base), (path) =>
    fileAtHead(root, path),
  )
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log("ADR check passed.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
