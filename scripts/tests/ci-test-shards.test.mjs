import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const suite = fileURLToPath(new URL("../ci/test-suite.mjs", import.meta.url))
const backend = fileURLToPath(new URL("../../apps/backend/", import.meta.url))
const list = (...args) => {
  const result = spawnSync(process.execPath, [suite, ...args, "--list"], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

for (const [lane, count] of [
  ["backend", 4],
  ["contracts", 5],
]) {
  test(`the ${count} ${lane} shards select each required file exactly once`, () => {
    const shards = Array.from({ length: count }, (_, index) =>
      list(lane, `--shard=${index + 1}/${count}`),
    )
    for (const shard of shards) assert.ok(shard.length > 0)
    assert.deepEqual(shards.flat().sort(), list(lane))
  })
}

test("an incorrect shard argument stops the suite", () => {
  for (const shard of [
    "--shard=0/4",
    "--shard=5/4",
    "--shard=1/0",
    "--shard=x",
  ])
    assert.equal(
      spawnSync(process.execPath, [suite, "contracts", shard, "--list"]).status,
      1,
    )
})

test("the merged shard results must cover the full inventory once, with clean runner exits", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-test-shards-"))
  try {
    const count = 3
    const write = (index, files, exitCode = 0) => {
      const output = join(directory, "contracts", `shard-${index}-of-${count}`)
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, "exit-code"), String(exitCode))
      writeFileSync(
        join(output, "results.json"),
        JSON.stringify({
          numTotalTests: files.length,
          numPassedTests: files.length,
          numFailedTests: 0,
          numPendingTests: 0,
          numTodoTests: 0,
          testResults: files.map((file) => ({
            name: join(backend, file),
            status: "passed",
            message: "",
            assertionResults: [{ fullName: "fixture", status: "passed" }],
          })),
        }),
      )
    }
    const merge = () =>
      spawnSync(process.execPath, [suite, "contracts", "--merge"], {
        encoding: "utf8",
        env: { ...process.env, CI_TEST_RESULTS_DIR: directory },
      })
    const shards = Array.from({ length: count }, (_, index) =>
      list("contracts", `--shard=${index + 1}/${count}`),
    )
    for (const [index, files] of shards.entries()) write(index + 1, files)
    const merged = merge()
    assert.equal(merged.status, 0, merged.stdout + merged.stderr)
    assert.match(merged.stdout, /EXECUTED .* zero skipped/)

    write(2, [...shards[1], shards[0][0]])
    assert.match(merge().stderr, /differ from the required inventory/)

    write(2, shards[1], 1)
    assert.match(merge().stderr, /cannot conceal process\/setup failures/)

    rmSync(join(directory, "contracts", `shard-2-of-${count}`), {
      recursive: true,
    })
    assert.match(merge().stderr, /Incomplete contracts shards/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
