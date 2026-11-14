// Checks that `.ai/memory/decisions/index.md` lists each ADR file of the
// decisions directory (AGENTS.md "Architecture decisions & ADRs"). A new or
// renamed ADR that the index omits fails. The check reads only the files of
// that directory, not the git history, so its cache key holds all that it
// reads.
//
// Usage: node scripts/ci/check-adr.mjs [repository root]

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

function adrProblems(root) {
  const directory = join(root, ".ai/memory/decisions")
  const listed = readFileSync(join(directory, "index.md"), "utf8")
  return readdirSync(directory)
    .filter((name) => /^ADR-.+\.md$/.test(name))
    .filter((name) => !listed.includes(name.replace(/\.md$/, "")))
    .sort()
    .map(
      (name) =>
        `.ai/memory/decisions/${name}: list the ADR in .ai/memory/decisions/index.md.`,
    )
}

function main() {
  const problems = adrProblems(resolve(process.argv[2] ?? "."))
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log("ADR check passed.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
