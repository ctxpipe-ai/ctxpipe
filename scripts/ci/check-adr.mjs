// Checks that each ADR file that a change adds is listed in
// `.ai/memory/decisions/index.md` (AGENTS.md "Architecture decisions & ADRs").
// A renamed ADR counts as an added file.
//
// Usage: node scripts/ci/check-adr.mjs [repository root] [base ref]
//   (default base: origin/main)

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { changedFiles, fileAtHead } from "./changed-files.mjs"

const adrPath = /^\.ai\/memory\/decisions\/(ADR-[^/]+)\.md$/

export function adrProblems(files, readAtHead) {
  const index = readAtHead(".ai/memory/decisions/index.md") ?? ""
  return files
    .filter((file) => file.status === "A" && adrPath.test(file.path))
    .filter((file) => !index.includes(adrPath.exec(file.path)[1]))
    .map(
      (file) =>
        `${file.path}: list the new ADR in .ai/memory/decisions/index.md.`,
    )
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
