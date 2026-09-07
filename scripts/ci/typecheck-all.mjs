import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

process.chdir(fileURLToPath(new URL("../../", import.meta.url)))
const projects = JSON.parse(readFileSync("scripts/ci/projects.json", "utf8"))
let failed = false
const history = spawnSync(
  process.execPath,
  [
    "scripts/ci/check-allowlist-history.mjs",
    ...projects.map((project) => `scripts/ci/diagnostics/${project.name}.json`),
  ],
  { stdio: "inherit" },
)
if (history.status !== 0) failed = true
for (const { name, project } of projects) {
  if (name === "docs") {
    const generated = spawnSync(
      "pnpm",
      ["--filter", "@ctxpipe/docs", "exec", "fumadocs-mdx"],
      { stdio: "inherit" },
    )
    if (generated.status !== 0) failed = true
  }
  const result = spawnSync(
    process.execPath,
    [
      "scripts/ci/typecheck.mjs",
      project,
      `scripts/ci/diagnostics/${name}.json`,
    ],
    { stdio: "inherit" },
  )
  if (result.status !== 0) failed = true
}
process.exitCode = failed ? 1 : 0
