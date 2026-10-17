import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const open = "$" + "{{"

function check(text) {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-workflow-inputs-"))
  try {
    writeFileSync(join(directory, "a.yaml"), text)
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../ci/check-workflow-inputs.mjs", import.meta.url),
        ),
        directory,
      ],
      { encoding: "utf8" },
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function job(steps, permissions = "permissions: {}\n") {
  return `${permissions}jobs:\n  a:\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n    steps:\n${steps}`
}

test("an input read from env passes", () => {
  const result = check(
    job(
      `      - env:\n          PR_NUMBER: ${open} inputs.pr_number }}\n        run: |\n          echo "$PR_NUMBER"\n`,
    ),
  )
  assert.equal(result.status, 0, result.stderr)
})

test("an input inside a run script fails", () => {
  const result = check(
    job(`      - run: |\n          echo "${open} inputs.pr_number }}"\n`),
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /a\.yaml:7/)
})

test("a branch name on a one-line run fails", () => {
  const result = check(job(`      - run: echo ${open} github.ref_name }}\n`))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /a\.yaml:6/)
})

test("a repository value inside a run script passes", () => {
  const result = check(
    job(`      - run: |\n          echo "${open} github.repository }}"\n`),
  )
  assert.equal(result.status, 0, result.stderr)
})

test("a workflow without permissions fails", () => {
  const result = check(job("      - run: echo hi\n", ""))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no top-level permissions/)
})

test("permissions on each job pass", () => {
  const result = check(
    "jobs:\n  a:\n    permissions:\n      contents: read\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n    steps:\n      - run: echo hi\n",
  )
  assert.equal(result.status, 0, result.stderr)
})
