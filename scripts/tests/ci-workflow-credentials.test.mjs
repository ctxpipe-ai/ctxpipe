import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-workflow-credentials.mjs", import.meta.url),
)

function check(workflow) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-credentials-"))
  mkdirSync(join(root, "scripts", "ci"), { recursive: true })
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  mkdirSync(join(root, ".github", "actions"), { recursive: true })
  cpSync(script, join(root, "scripts", "ci", "check-workflow-credentials.mjs"))
  writeFileSync(join(root, ".github", "workflows", "w.yaml"), workflow)
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "ci", "check-workflow-credentials.mjs")],
    { encoding: "utf8" },
  )
}

for (const [place, body] of [
  ["env", "    env:\n      URL: ${{ steps.db.outputs.db_url }}\n"],
  ["run", "    steps:\n      - run: psql ${{ steps.db.outputs.db_url_app }}\n"],
  [
    "with",
    "    steps:\n      - uses: x/y@v1\n        with:\n          pw: ${{ steps.db.outputs.password }}\n",
  ],
]) {
  test(`rejects a credential output read in ${place}`, () => {
    const result = check(`jobs:\n  a:\n${body}`)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /w\.yaml:/)
  })
}

test("accepts a workflow with no credential output", () => {
  const result = check(
    "jobs:\n  a:\n    steps:\n      - run: echo ${{ steps.db.outputs.branch }}\n",
  )
  assert.equal(result.status, 0)
})
