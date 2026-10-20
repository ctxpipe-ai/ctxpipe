import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
