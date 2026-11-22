// Exact versions in package.json (CTX-1539). The lockfile is the pin: a dependency in package.json takes a range
// (`^1.2.3`), so an update moves only the lockfile. An exact version (`1.2.3`, `=1.2.3`) fails, unless the allowlist
// names it with the reason that it must stay exact. An allowlist file that holds no exact version of its package
// fails too, so the list stays true.
//
// A copy of `.github/ci/pins.mjs` in the factory repo (ctxpipe-ai/factory, #612). ctxpipe does not use the factory's
// CI scripts, so a fix to one copy goes into the other too. The ctxpipe differences: the allowlist is
// scripts/ci/pins.json, and <dir> is the current directory when it is not given (run it from the repo root).
//
//   node scripts/ci/check-pins.mjs [<dir>]        (from the repo root)
//
// It reads every package.json under <dir> (not node_modules, not a folder whose name starts with a dot) and prints
// one line per problem, with repo-relative paths. Exit 0 when there are none. Node's standard library only.
//
// The allowlist is pins.json beside this file: { "entries": [{ "package": "<name>", "files": ["<path>", ...],
// "reason": "<why>" }] }, each path a package.json relative to the repo root.
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

export const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

// An exact version: a full semver, optionally after `=` (with or without a space), `v`, or both. An npm alias
// (`npm:name@1.2.3`) is exact when its version is. Ranges, tags, `workspace:`, `link:`, `file:`, `catalog:`, git and
// URL specifiers are not.
export function isExact(spec) {
  const version = spec.startsWith("npm:") ? spec.slice(spec.lastIndexOf("@") + 1) : spec
  return /^(=\s*)?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version.trim())
}

// The package.json files under `dir`, sorted, as `/`-separated paths that start with `dir`.
export function manifests(dir) {
  const out = []
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === "package.json") out.push(full.split(path.sep).join("/"))
    }
  }
  walk(dir)
  return out.sort()
}

// Every exact version in the package.json files under `dir`: { file, field, name, spec }.
export function exactPins(dir) {
  return manifests(dir).flatMap((file) => {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    return FIELDS.flatMap((field) =>
      Object.entries(pkg[field] ?? {})
        .filter(([, spec]) => typeof spec === "string" && isExact(spec))
        .map(([name, spec]) => ({ file, field, name, spec })),
    )
  })
}

// Reads and checks the allowlist: each entry has a package, at least one file and a reason.
export function readAllowlist(file) {
  const { entries } = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!Array.isArray(entries)) throw new Error(`${file}: "entries" must be a list`)
  for (const [i, entry] of entries.entries()) {
    const ok =
      typeof entry.package === "string" &&
      entry.package &&
      Array.isArray(entry.files) &&
      entry.files.length &&
      entry.files.every((name) => typeof name === "string" && name) &&
      typeof entry.reason === "string" &&
      entry.reason.trim()
    if (!ok) throw new Error(`${file}: entry ${i} needs "package", "files" and a "reason"`)
  }
  return entries
}

// The problems of `dir` against `entries`: an exact version that no entry allows, and an allowlist file under `dir`
// that has no exact version of the entry's package. A file outside `dir` is another module's and is not judged here.
export function problems(dir, entries) {
  const pins = exactPins(dir)
  const files = new Set(manifests(dir))
  const allowed = (pin) => entries.some((entry) => entry.package === pin.name && entry.files.includes(pin.file))
  const out = pins
    .filter((pin) => !allowed(pin))
    .map(
      (pin) =>
        `${pin.file}: ${pin.field}.${pin.name} is the exact version "${pin.spec}"; use a range ("^${pin.spec.replace(/^(=\s*)?v?/, "")}") or add it to the allowlist with the reason`,
    )
  for (const entry of entries) {
    for (const file of entry.files.filter((name) => files.has(name))) {
      if (!pins.some((pin) => pin.name === entry.package && pin.file === file)) {
        out.push(`${file}: the allowlist names ${entry.package} here, but it has no exact version of it; remove it from the allowlist`)
      }
    }
  }
  return out
}

function main([dir = "."]) {
  const allowlist = fileURLToPath(new URL("pins.json", import.meta.url))
  const found = problems(dir.replace(/\/+$/, ""), readAllowlist(allowlist))
  for (const line of found) console.log(line)
  if (found.length) console.log(`${found.length} problem(s). The lockfile pins each version; package.json takes ranges (AGENTS.md, "Versions").`)
  return found.length ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2))
