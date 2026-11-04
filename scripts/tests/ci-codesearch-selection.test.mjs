import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const runner = join(root, "apps/codesearch/scripts/run-vitest-contracts.mjs")

test("the container inventory selects only the requested runtime and file", () => {
  const full = spawnSync(process.execPath, [runner, "--list"], {
    encoding: "utf8",
  })
  assert.equal(full.status, 0, full.stderr)
  const inventory = JSON.parse(full.stdout)
  for (const runtime of ["node", "bun"]) {
    const file = inventory[runtime][0]
    const selected = spawnSync(
      process.execPath,
      [runner, "--list", `--${runtime}`, file],
      { encoding: "utf8" },
    )
    assert.equal(selected.status, 0, selected.stderr)
    assert.deepEqual(JSON.parse(selected.stdout), {
      node: runtime === "node" ? [file] : [],
      bun: runtime === "bun" ? [file] : [],
    })
  }
})

test("the image runner forwards selected files and runtimes through Docker", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codesearch-selection-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.DOCKER_CALLS, JSON.stringify(args) + "\\n")
if (args[0] === "info") process.stdout.write("aarch64\\n")
if (args[0] === "run") {
  const mount = args.find((arg) => arg.endsWith(":/records"))
  if (mount) {
    const records = JSON.parse(process.env.SELECTED_RECORDS)
    fs.writeFileSync(mount.slice(0, -9) + "/records.ndjson", records.map((r) => JSON.stringify(r)).join("\\n") + "\\n")
  }
}
`,
    { mode: 0o755 },
  )
  const checks = [
    {
      id: "vitest:codesearch:apps/codesearch/src/one.test.ts",
      lane: "codesearch",
      runtime: "node",
      file: "apps/codesearch/src/one.test.ts",
    },
    {
      id: "vitest:codesearch-bun:apps/codesearch/src/two.test.ts",
      lane: "codesearch-bun",
      runtime: "bun",
      file: "apps/codesearch/src/two.test.ts",
    },
  ]
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { runCodesearchImage } from "./scripts/checks/lanes.mjs"
    process.stdout.write(JSON.stringify(runCodesearchImage(${JSON.stringify(checks)})))
  `,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DOCKER_CALLS: join(dir, "calls"),
        SELECTED_RECORDS: JSON.stringify(
          checks.map(({ id }) => ({ schemaVersion: 1, id, status: "passed" })),
        ),
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    JSON.parse(result.stdout).map(({ status }) => status),
    ["passed", "passed"],
  )
  const calls = readFileSync(join(dir, "calls"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
  const runs = calls.filter(([command]) => command === "run")
  assert.equal(
    runs.length,
    1,
    "a selected run must not execute the unrelated OOM test",
  )
  assert.deepEqual(runs[0].slice(runs[0].indexOf("pnpm")), [
    "pnpm",
    "run",
    "test:vitest",
    "--records",
    "/records",
    "--node",
    "src/one.test.ts",
    "--bun",
    "src/two.test.ts",
  ])
})

test("a failed unselected file does not change a selected passing record", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codesearch-contracts-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const app = join(dir, "apps/codesearch")
  for (const file of [
    "apps/codesearch/scripts/run-vitest-contracts.mjs",
    "scripts/checks/lanes.mjs",
    "scripts/checks/log.mjs",
    "scripts/checks/trace.mjs",
    "scripts/ci/vitest-launch.mjs",
    "scripts/ci/check-test-report.mjs",
  ]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    copyFileSync(join(root, file), join(dir, file))
  }
  symlinkSync(
    join(root, "apps/codesearch/node_modules"),
    join(app, "node_modules"),
  )
  writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(
    join(app, "vitest.config.mjs"),
    "export default { test: { include: ['src/**/*.test.ts'] } }",
  )
  const full = spawnSync(process.execPath, [runner, "--list"], {
    encoding: "utf8",
  })
  assert.equal(full.status, 0, full.stderr)
  for (const file of [
    ...JSON.parse(full.stdout).bun,
    "src/unselected.test.ts",
    "src/selected.test.ts",
  ]) {
    mkdirSync(dirname(join(app, file)), { recursive: true })
    writeFileSync(
      join(app, file),
      `import { test, expect } from 'vitest'; test('contract', () => expect(true).toBe(${file === "src/selected.test.ts"}));`,
    )
  }
  const records = join(dir, "records")
  const invoke = (file) =>
    spawnSync(
      process.execPath,
      [
        join(app, "scripts/run-vitest-contracts.mjs"),
        "--node",
        file,
        "--records",
        records,
      ],
      { encoding: "utf8", timeout: 30000 },
    )
  const failed = invoke("src/unselected.test.ts")
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  const passed = invoke("src/selected.test.ts")
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  const written = readFileSync(join(records, "records.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
  assert.deepEqual(
    written.map(({ id, status }) => ({ id, status })),
    [
      {
        id: "vitest:codesearch:apps/codesearch/src/selected.test.ts",
        status: "passed",
      },
    ],
  )
})
