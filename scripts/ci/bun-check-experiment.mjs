// CTX-1145 experiment, not a gate. Runs `bun check` on each project of
// projects.json, prints the time of each run, and compares the diagnostics
// with the allowance of the project by file and error code. The allowance
// message text can differ (TypeScript 7 orders union members in a stable
// way), so the comparison ignores the message.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const projects = JSON.parse(
  readFileSync(resolve(root, "scripts/ci/projects.json"), "utf8"),
)
let mismatch = false
let total = 0
for (const { name, project } of projects) {
  const allowance = JSON.parse(
    readFileSync(resolve(root, `scripts/ci/diagnostics/${name}.json`), "utf8"),
  )
  const expected = new Map()
  for (const { file, code, count } of allowance.diagnostics) {
    const key = `${file} TS${code}`
    expected.set(key, (expected.get(key) ?? 0) + count)
  }
  const started = performance.now()
  const run = spawnSync(
    "bun",
    ["check", "--no-script", "--no-pretty", "-p", "tsconfig.json"],
    {
      cwd: resolve(root, dirname(project)),
      encoding: "utf8",
      maxBuffer: 1 << 28,
    },
  )
  const seconds = (performance.now() - started) / 1000
  total += seconds
  const observed = new Map()
  for (const line of run.stdout.split("\n")) {
    const match = /^(.+?)\(\d+,\d+\): error TS(\d+):/.exec(line)
    if (!match) continue
    const key = `${match[1]} TS${match[2]}`
    observed.set(key, (observed.get(key) ?? 0) + 1)
  }
  const differences = []
  for (const key of new Set([...expected.keys(), ...observed.keys()])) {
    if (expected.get(key) !== observed.get(key))
      differences.push(
        `${key}: allowed ${expected.get(key) ?? 0}, bun check ${observed.get(key) ?? 0}`,
      )
  }
  if (differences.length) mismatch = true
  process.stdout.write(
    `${name}: bun check ${seconds.toFixed(2)} s, exit ${run.status}, ${[...observed.values()].reduce((a, b) => a + b, 0)} diagnostics, ${differences.length ? "DIFFERENT" : "same as the allowance"}\n`,
  )
  for (const line of differences) process.stdout.write(`  ${line}\n`)
  if (run.error) process.stdout.write(`  ${run.error.message}\n`)
}
process.stdout.write(`bun check total ${total.toFixed(2)} s\n`)
process.exitCode = mismatch ? 1 : 0
