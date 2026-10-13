#!/usr/bin/env node
// Placeholder: each folder with a known manifest file is a root.
import { execFileSync } from "node:child_process"
import { posix } from "node:path"

const MANIFESTS = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
])
const source = process.argv[2] || "."
const files = execFileSync("git", ["-C", source, "ls-files", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
const roots = new Map()
for (const file of files) {
  const name = posix.basename(file)
  if (!MANIFESTS.has(name)) continue
  const path = posix.dirname(file)
  roots.set(path, [...(roots.get(path) ?? []), name])
}
const result = {
  roots: [...roots]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, manifests]) => ({ path, manifests: manifests.sort() })),
}
process.stdout.write(`${JSON.stringify(result)}\n`)
