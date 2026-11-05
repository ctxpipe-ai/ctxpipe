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
        // A diagnostic entry has the text of the checker that wrote it, and a
        // checker change rewrites the text. Thus the allowance of a typecheck
        // compares the count of each file and code. A failure entry (a test
        // baseline) keeps its title and message in the identity.
        const key = (entry) =>
          JSON.stringify([
            entry.file,
            entry.code,
            entry.title,
            current.diagnostics ? undefined : entry.message,
          ])
        const total = (list) => {
          const counts = new Map()
          for (const entry of list)
            counts.set(
              key(entry),
              (counts.get(key(entry)) ?? 0) + (entry.count ?? 1),
            )
          return counts
        }
        const before = total(previous)
        for (const [entry, count] of total(entries)) {
          if (!before.has(entry) || count > before.get(entry)) {
            const item = JSON.parse(entry)
            throw new Error(
              `${path} may only shrink: ${item[0]} ${item[2] ?? `TS${item[1]}`} expanded at ${revision ?? "working tree"}`,
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
