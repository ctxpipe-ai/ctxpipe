import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

function check(files) {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-runners-"))
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(directory, name), text)
    }
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../ci/check-runners.mjs", import.meta.url)),
        directory,
      ],
      { encoding: "utf8" },
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("Blacksmith labels pass", () => {
  const result = check({
    "a.yaml": "jobs:\n  a:\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n",
  })
  assert.equal(result.status, 0, result.stderr)
})

test("ubuntu-latest fails", () => {
  const result = check({
    "a.yaml": "jobs:\n  a:\n    runs-on: ubuntu-latest\n",
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /a\.yaml:3/)
})

test("a matrix runs-on expression fails", () => {
  const result = check({
    "a.yml": "jobs:\n  a:\n    runs-on: $\{{ matrix.os }}\n",
  })
  assert.equal(result.status, 1)
})

test("a github-hosted comment with a reason allows the label", () => {
  const same = check({
    "a.yaml":
      "jobs:\n  a:\n    runs-on: macos-latest # github-hosted: needs macOS\n",
  })
  assert.equal(same.status, 0, same.stderr)
  const before = check({
    "a.yaml":
      "jobs:\n  a:\n    # github-hosted: needs macOS\n    runs-on: macos-latest\n",
  })
  assert.equal(before.status, 0, before.stderr)
})

test("a github-hosted comment without a reason fails", () => {
  const result = check({
    "a.yaml": "jobs:\n  a:\n    runs-on: ubuntu-latest # github-hosted:\n",
  })
  assert.equal(result.status, 1)
})

test("the repository workflows pass", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../ci/check-runners.mjs", import.meta.url))],
    { encoding: "utf8", cwd: fileURLToPath(new URL("../..", import.meta.url)) },
  )
  assert.equal(result.status, 0, result.stderr)
})
