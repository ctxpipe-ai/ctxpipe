import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

test("proof policy rejects aliased skips, retries and owned module mocks without matching prose", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-proof-policy-"))
  try {
    const file = join(directory, "contract.test.ts")
    const check = (source) => {
      writeFileSync(file, source)
      return spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../ci/check-test-policy.mjs", import.meta.url),
          ),
          file,
        ],
        { encoding: "utf8" },
      )
    }
    const normal = check(
      'import { it as scenario } from "vitest"; scenario("describes .skip and vi.mock in prose", () => {})',
    )
    assert.equal(normal.status, 0, normal.stderr)
    for (const source of [
      'import { test } from "vitest"; test.skip.each([1])("proof", () => {})',
      'import { test } from "vitest"; const omit = test.skip; omit("proof", () => {})',
      'import * as v from "vitest"; v.test.skip.each([1])("proof", () => {})',
      'import { defineConfig } from "vitest/config"; export default defineConfig({ test: { retry: 2 } })',
    ]) {
      const rejected = check(source)
      assert.equal(rejected.status, 1, source)
    }
    const domainRetry = check(
      'test("retry policy", () => withTransientHttpRetry(operation, { retries: 2 }))',
    )
    assert.equal(domainRetry.status, 0, domainRetry.stderr)
    assert.equal(
      check(
        'import { it as scenario } from "vitest"; scenario.skipIf(false)("proof", () => {})',
      ).status,
      1,
    )
    assert.equal(
      check('import { it } from "vitest"; it("proof", { retry: 2 }, () => {})')
        .status,
      1,
    )
    const mocked = check(
      'import { vi } from "vitest"; vi.mock("./owned-store.js", () => ({}))',
    )
    assert.equal(mocked.status, 1)
    assert.match(mocked.stderr, /mock/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
