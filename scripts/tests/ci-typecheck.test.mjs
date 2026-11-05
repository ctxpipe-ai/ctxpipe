import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

test("a known diagnostic cannot hide a new error outside the workspace paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-typecheck-"))
  try {
    mkdirSync(join(directory, "src"))
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: [], skipLibCheck: true },
        include: ["src/**/*.ts"],
      }),
    )
    writeFileSync(
      join(directory, "src/legacy.ts"),
      'export const value: number = "legacy"\n',
    )
    writeFileSync(
      join(directory, "baseline.json"),
      JSON.stringify({
        version: 1,
        diagnostics: [
          {
            file: "src/legacy.ts",
            code: 2322,
            message: "Type 'string' is not assignable to type 'number'.",
            count: 1,
          },
        ],
      }),
    )
    const check = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../ci/typecheck.mjs", import.meta.url)),
          join(directory, "tsconfig.json"),
          join(directory, "baseline.json"),
        ],
        { encoding: "utf8" },
      )
    const known = check()
    assert.equal(known.status, 0, known.stdout + known.stderr)
    assert.match(known.stdout, /ACKNOWLEDGED.*1/)

    writeFileSync(
      join(directory, "src/elsewhere.ts"),
      'export const value: number = "new"\n',
    )
    const regression = check()
    assert.equal(regression.status, 1, regression.stdout + regression.stderr)
    assert.match(regression.stdout, /src\/elsewhere\.ts/)
    assert.match(regression.stdout, /UNEXPECTED/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a package check script does not replace the checker, and a multi-line message is one diagnostic", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-typecheck-"))
  try {
    mkdirSync(join(directory, "src"))
    // `bun check` runs this script instead of the checker, unless the runner
    // passes --no-script.
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { check: "exit 7" } }),
    )
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: [], skipLibCheck: true },
        include: ["src/**/*.ts"],
      }),
    )
    writeFileSync(
      join(directory, "src/legacy.ts"),
      "declare const inner: { b: string }\nexport const value: { a: { b: number } } = { a: inner }\n",
    )
    const baseline = (message) =>
      writeFileSync(
        join(directory, "baseline.json"),
        JSON.stringify({
          version: 1,
          diagnostics: [
            { file: "src/legacy.ts", code: 2322, message, count: 1 },
          ],
        }),
      )
    const check = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../ci/typecheck.mjs", import.meta.url)),
          join(directory, "tsconfig.json"),
          join(directory, "baseline.json"),
          join(directory, "report.json"),
        ],
        { encoding: "utf8" },
      )
    baseline("anything")
    const first = check()
    assert.equal(first.status, 1, first.stdout + first.stderr)
    const report = JSON.parse(
      readFileSync(join(directory, "report.json"), "utf8"),
    )
    assert.equal(report.diagnostics.length, 1)
    assert.equal(report.diagnostics[0].file, "src/legacy.ts")
    assert.equal(report.diagnostics[0].code, 2322)
    assert.match(report.diagnostics[0].message, /\n {2}/)
    // The text of the allowance is not equal to the observed text: the
    // diagnostic is new, and the old entry is stale.
    assert.match(first.stdout, /UNEXPECTED src\/legacy\.ts TS2322/)
    assert.match(first.stdout, /STALE allowance/)

    baseline(report.diagnostics[0].message)
    const known = check()
    assert.equal(known.status, 0, known.stdout + known.stderr)
    assert.match(known.stdout, /ACKNOWLEDGED 1 /)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
