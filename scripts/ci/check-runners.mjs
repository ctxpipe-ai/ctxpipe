// Rejects a workflow job that runs on a non-Blacksmith runner without a reason.
//
// Every `runs-on` in .github/workflows must start with `blacksmith-`, also in a
// matrix expression. A job may use another label only when `runs-on` carries
// the comment `github-hosted: <reason>` on its own line or on the line before.
//
// Usage: node scripts/ci/check-runners.mjs [directory]   (default .github/workflows)

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = resolve(process.argv[2] ?? ".github/workflows")
const root = fileURLToPath(new URL("../..", import.meta.url))
const REASON = /#\s*github-hosted:\s*\S/
const failures = []

for (const name of readdirSync(directory).sort()) {
  if (!/\.ya?ml$/.test(name)) continue
  const lines = readFileSync(join(directory, name), "utf8").split("\n")
  lines.forEach((line, index) => {
    const match = line.match(/^\s*runs-on:\s*(.*)$/)
    if (!match) return
    const value = match[1].replace(/\s+#.*$/, "").trim()
    if (/^blacksmith-[\w-]+$/.test(value)) return
    if (REASON.test(line) || REASON.test(lines[index - 1] ?? "")) return
    failures.push(
      `${join(directory, name).replace(`${root}/`, "")}:${index + 1}: runs-on "${value}" is not a Blacksmith label. Use blacksmith-4vcpu-ubuntu-2404, or add "# github-hosted: <reason>".`,
    )
  })
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
