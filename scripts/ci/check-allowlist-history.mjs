import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

try {
  const paths = process.argv.slice(2)
  if (!paths.length)
    throw new Error("Usage: check-allowlist-history.mjs baseline.json [...]")
  if (
    execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      encoding: "utf8",
    }).trim() !== "false"
  ) {
    throw new Error(
      "Full Git history is required to check shrinking diagnostic allowances",
    )
  }
  for (const path of paths) {
    const revisions = execFileSync(
      "git",
      ["log", "--first-parent", "--reverse", "--format=%H", "HEAD", "--", path],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
    let previous
    for (const revision of [...revisions, null]) {
      const current = JSON.parse(
        revision
          ? execFileSync("git", ["show", `${revision}:${path}`], {
              encoding: "utf8",
            })
          : readFileSync(path, "utf8"),
      )
      const entries = current.diagnostics ?? current.failures
      if (current.version !== 1 || !Array.isArray(entries))
        throw new Error(`Invalid baseline ${path}`)
      if (previous) {
        for (const item of entries) {
          const before = previous.find(
            (entry) =>
              entry.file === item.file &&
              entry.code === item.code &&
              entry.title === item.title &&
              entry.message === item.message,
          )
          if (!before || (item.count ?? 1) > (before.count ?? 1)) {
            throw new Error(
              `${path} may only shrink: ${item.file} ${item.title ?? `TS${item.code}`} expanded at ${revision ?? "working tree"}`,
            )
          }
        }
      }
      previous = entries
    }
    process.stdout.write(`${path}: allowance history only shrinks\n`)
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
