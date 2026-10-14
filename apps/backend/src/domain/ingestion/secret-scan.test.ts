import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { findSuspectedSecret } from "./secret-scan.js"

describe("findSuspectedSecret on the documents of this repository", () => {
  it("finds no secret in a tracked Markdown, YAML, JSON, or TOML file", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
    }).trim()
    const paths = execFileSync(
      "git",
      ["ls-files", "-z", "*.md", "*.yaml", "*.yml", "*.json", "*.toml"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean)
    expect(paths.length).toBeGreaterThan(100)
    const hits: string[] = []
    for (const path of paths) {
      const full = join(root, path)
      const stat = statSync(full, { throwIfNoEntry: false })
      if (!stat?.isFile() || stat.size > 1024 * 1024) continue
      const finding = findSuspectedSecret(readFileSync(full, "utf8"))
      if (finding) hits.push(`${path}: ${finding.reason}`)
    }
    expect(hits).toEqual([])
  })
})
