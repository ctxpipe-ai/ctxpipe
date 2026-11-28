// Fails for a changeset that names a package and has no kind tag on the first
// line of its summary (ADR-020, item 7). An empty changeset needs no kind.
//
// `node scripts/release/check-changeset-kinds.mjs [file...]` checks the given
// files, or every pending .changeset/*.md file when no file is given.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { parseKind } from "./changelog.mjs"

// The problem of one changeset file, or null when it is valid.
export function changesetProblem(text) {
  const match = /^---\r?\n([\s\S]*?)^---[ \t]*$/m.exec(text)
  if (!match || match.index !== 0) return "has no front matter"
  const names = match[1].split("\n").some((line) => line.trim() !== "")
  if (!names) return null
  if (parseKind(text.slice(match[0].length))) return null
  return 'names a package but has no kind. Start the summary with "feature: ", "improvement: " or "fix: " ("fix!: " for a breaking change)'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files =
    process.argv.length > 2
      ? process.argv.slice(2)
      : readdirSync(".changeset")
          .filter((name) => name.endsWith(".md") && name !== "README.md")
          .map((name) => join(".changeset", name))
  let failed = false
  for (const file of files) {
    const problem = changesetProblem(readFileSync(file, "utf8"))
    if (problem) {
      failed = true
      console.error(`::error file=${file}::${file} ${problem} (ADR-020).`)
    }
  }
  process.exit(failed ? 1 : 0)
}
