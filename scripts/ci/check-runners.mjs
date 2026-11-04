// Rejects a workflow job that runs on a runner other than Blacksmith arm64.
//
// Every `runs-on` in .github/workflows must be `blacksmith-<n>vcpu-ubuntu-2404-arm`,
// also in a matrix expression. A laptop runs linux/arm64 containers, so CI runs
// the same platform. A job may use another label only when `runs-on` carries
// a reason comment on its own line or on the line before:
//   `amd64: <reason>`        for `blacksmith-<n>vcpu-ubuntu-2404` (x64)
//   `github-hosted: <reason>` for any other label
//
// Usage: node scripts/ci/check-runners.mjs [directory]   (default .github/workflows)

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = resolve(process.argv[2] ?? ".github/workflows")
const root = fileURLToPath(new URL("../..", import.meta.url))
const GITHUB_HOSTED = /#\s*github-hosted:[ \t]*\S/
const AMD64 = /#\s*amd64:[ \t]*\S/
const failures = []

for (const name of readdirSync(directory).sort()) {
  if (!/\.ya?ml$/.test(name)) continue
  const lines = readFileSync(join(directory, name), "utf8").split("\n")
  lines.forEach((line, index) => {
    const match = line.match(/^\s*runs-on:\s*(.*)$/)
    if (!match) return
    const value = match[1].replace(/\s+#.*$/, "").trim()
    if (/^blacksmith-\d+vcpu-ubuntu-2404-arm$/.test(value)) return
    const near = `${lines[index - 1] ?? ""}\n${line}`
    const reason = /^blacksmith-\d+vcpu-ubuntu-2404$/.test(value)
      ? AMD64
      : GITHUB_HOSTED
    if (reason.test(near)) return
    failures.push(
      `${join(directory, name).replace(`${root}/`, "")}:${index + 1}: runs-on "${value}" is not an arm64 Blacksmith label. Use blacksmith-4vcpu-ubuntu-2404-arm, or add "# amd64: <reason>" (x64 Blacksmith label) or "# github-hosted: <reason>".`,
    )
  })
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
