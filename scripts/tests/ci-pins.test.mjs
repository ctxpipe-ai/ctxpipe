// Tests of the exact-version check (scripts/ci/check-pins.mjs). A copy of
// `.github/ci/pins.test.mjs` in the factory repo; keep the two in step.
//   node --test scripts/tests/ci-pins.test.mjs
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { isExact, manifests, problems, readAllowlist } from "../ci/check-pins.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))

// A folder with the given files (path -> JSON value or text); returns its path.
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), typeof content === "string" ? content : JSON.stringify(content))
  }
  return dir
}

// Runs `fn` with the working directory at `dir`, so paths are relative as the CLI prints them.
function inDir(dir, fn) {
  const before = process.cwd()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(before)
  }
}

test("an exact version is a full semver, also after = (with a space too), v or both, and an npm alias to one", () => {
  for (const spec of ["1.2.3", "=1.2.3", "= 1.2.3", " =1.2.3 ", "=v1.2.3", "= v1.2.3", "v1.2.3", "0.0.1", "1.2.3-rc.1", "1.2.3+build.5", "npm:other@4.5.6", "npm:@scope/x@1.0.0"]) {
    assert.ok(isExact(spec), spec)
  }
  for (const spec of [
    "^1.2.3",
    "~1.2.3",
    ">=1.2.3",
    "1.2",
    "1.x",
    "*",
    "latest",
    "1.2.3 - 2.0.0",
    "1.2.3 || 2.0.0",
    "workspace:*",
    "link:../x",
    "file:../x",
    "catalog:",
    "github:owner/repo#abc",
    "https://example.com/x.tgz",
    "npm:other@^4.5.6",
  ]) {
    assert.ok(!isExact(spec), spec)
  }
})

test("manifests skips node_modules and dot folders", () => {
  const dir = tree({
    "m/package.json": {},
    "m/policy/package.json": {},
    "m/node_modules/x/package.json": {},
    "m/.cache/package.json": {},
  })
  inDir(dir, () => assert.deepEqual(manifests("m"), ["m/package.json", "m/policy/package.json"]))
})

test("an exact version fails in every dependency field, unless the allowlist names that package in that file", () => {
  const dir = tree({
    "m/package.json": {
      dependencies: { a: "1.0.0", ok: "^1.0.0", local: "workspace:*" },
      devDependencies: { b: "= v2.0.0" },
      optionalDependencies: { c: "3.0.0" },
      peerDependencies: { d: "4.0.0" },
      scripts: { build: "1.0.0" },
    },
    "m/policy/package.json": { dependencies: { a: "1.0.0" } },
  })
  const entries = [{ package: "a", files: ["m/package.json"], reason: "r" }]
  const found = inDir(dir, () => problems("m", entries))
  assert.equal(found.length, 4, found.join("\n"))
  assert.ok(found.some((line) => line.startsWith('m/package.json: devDependencies.b is the exact version "= v2.0.0"; use a range ("^2.0.0")')))
  assert.ok(found.some((line) => line.startsWith("m/package.json: optionalDependencies.c")))
  assert.ok(found.some((line) => line.startsWith("m/package.json: peerDependencies.d")))
  assert.ok(found.some((line) => line.startsWith("m/policy/package.json: dependencies.a")), "the entry covers m/package.json only")
})

test("an allowlist file without that exact version fails, and a file of another folder does not", () => {
  const dir = tree({ "m/package.json": { dependencies: { a: "^1.0.0" } } })
  const entries = [
    { package: "a", files: ["m/package.json"], reason: "r" },
    { package: "z", files: ["other/package.json"], reason: "r" },
  ]
  const found = inDir(dir, () => problems("m", entries))
  assert.deepEqual(found, ["m/package.json: the allowlist names a here, but it has no exact version of it; remove it from the allowlist"])
})

test("each allowlist entry needs a package, files and a reason", () => {
  const dir = tree({
    "good.json": { entries: [{ package: "a", files: ["m/package.json"], reason: "why" }] },
    "no-reason.json": { entries: [{ package: "a", files: ["m/package.json"], reason: " " }] },
    "no-files.json": { entries: [{ package: "a", files: [], reason: "why" }] },
    "no-list.json": { entries: {} },
  })
  assert.equal(readAllowlist(path.join(dir, "good.json")).length, 1)
  for (const file of ["no-reason.json", "no-files.json", "no-list.json"]) {
    assert.throws(() => readAllowlist(path.join(dir, file)), undefined, file)
  }
})

test("the CLI exits 1 with one line per problem, and 0 when clean", () => {
  // The CLI reads the repo's pins.json, which names no file of this folder.
  const dir = tree({
    "m/package.json": { dependencies: { a: "1.0.0" } },
    "clean/package.json": { dependencies: { a: "^1.0.0" } },
  })
  const cli = (...args) => spawnSync(process.execPath, [path.join(here, "../ci/check-pins.mjs"), ...args], { cwd: dir, encoding: "utf8" })
  const bad = cli("m")
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^m\/package\.json: dependencies\.a is the exact version "1\.0\.0"/)
  assert.equal(cli("clean/").status, 0)
})
