import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

// Writes the toolchain record (schema/toolchain.v1.schema.json) to stdout:
// the versions, the platform and the hashed environment that a result cache
// adds to the key of a check. A process that only computes keys reads it
// instead of its own toolchain. The merge gate writes it in the manifest job,
// which has the same setup as the jobs that run the checks.
// Usage: toolchain.mjs <manifest.json>
// The environment holds the variables that a check of the manifest declares,
// and NODE_OPTIONS and TZ. Each value is `unset` or `sha256:<16 hex>` of the
// value: the record never holds a value as text.

export const hashed = (value) =>
  value === undefined
    ? "unset"
    : `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`

export function toolchain(manifest, env = process.env, version = probe) {
  const names = new Set(["NODE_OPTIONS", "TZ"])
  for (const check of manifest.checks)
    for (const { name } of check.env ?? []) names.add(name)
  const bun = version("bun")
  return {
    schemaVersion: 1,
    node: process.version,
    pnpm: version("pnpm"),
    ...(bun && { bun }),
    // The names of the Rust standard library (std::env::consts), which the
    // factory uses for the same fields.
    os:
      { linux: "linux", darwin: "macos", win32: "windows" }[process.platform] ??
      process.platform,
    arch: { x64: "x86_64", arm64: "aarch64" }[process.arch] ?? process.arch,
    env: Object.fromEntries(
      [...names].sort().map((name) => [name, hashed(env[name])]),
    ),
  }
}

// The version that a tool prints, or undefined when it is not installed.
function probe(tool) {
  try {
    return execFileSync(tool, ["--version"], { encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    if (process.argv.length !== 3)
      throw new Error("Usage: toolchain.mjs <manifest.json>")
    const record = toolchain(JSON.parse(readFileSync(process.argv[2], "utf8")))
    if (!record.pnpm) throw new Error("pnpm --version failed")
    process.stdout.write(`${JSON.stringify(record)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
