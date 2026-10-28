import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

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

test("a warm run reads the build info, and a mismatch checks again without it", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-typecheck-"))
  const repository = fileURLToPath(new URL("../../", import.meta.url))
  const buildInfo = join(
    repository,
    "node_modules/.cache/typecheck",
    `${relative(repository, join(directory, "tsconfig.json")).replaceAll(/[\\/]/g, "_")}.tsbuildinfo`,
  )
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
    const baseline = (message) =>
      writeFileSync(
        join(directory, "baseline.json"),
        JSON.stringify({
          version: 1,
          diagnostics: [{ file: "src/legacy.ts", code: 2322, message, count: 1 }],
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
    baseline("Type 'string' is not assignable to type 'number'.")
    const cold = check()
    assert.equal(cold.status, 0, cold.stdout + cold.stderr)
    assert.match(cold.stdout, /\(full\)/)
    assert.ok(existsSync(buildInfo))

    const warm = check()
    assert.equal(warm.status, 0, warm.stdout + warm.stderr)
    assert.match(warm.stdout, /\(incremental\)/)

    // The text of a cached diagnostic is not equal to the allowance. The run
    // checks again without the build info, and reports the failure.
    baseline("Type 'string' is not assignable to type 'other'.")
    const mismatch = check()
    assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr)
    assert.match(mismatch.stdout, /full after an incremental mismatch/)
    assert.match(mismatch.stdout, /UNEXPECTED/)
    assert.ok(existsSync(buildInfo))
  } finally {
    rmSync(buildInfo, { force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})
