import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { matchesGlob } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// The critics of the code-review skill. The factory reads this file at the
// merge base of a PR (`factory review plan` and the merge gate), so these
// tests guard what main gives every later PR.
const root = fileURLToPath(new URL("../../", import.meta.url))
const { critics } = JSON.parse(
  readFileSync(`${root}.agents/skills/code-review/critics.json`, "utf8"),
)
const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
const critic = (name) => critics.find((critic) => critic.name === name)

test("each critic names its inputs, and only Security may be not applicable", () => {
  assert.deepEqual(
    critics.map(({ name }) => name),
    ["spec", "standards", "simplicity", "security"],
  )
  for (const { name, inputs, notApplicable } of critics) {
    for (const input of inputs)
      assert.ok(
        files.some((file) => matchesGlob(file, input)),
        `${name}: ${input} matches no file`,
      )
    assert.equal(notApplicable.length > 0, name === "security", name)
  }
})

test("the Standards version holds the AGENTS.md of each app", () => {
  const { inputs } = critic("standards")
  for (const file of files.filter((file) => file.endsWith("AGENTS.md")))
    assert.ok(
      inputs.some((input) => matchesGlob(file, input)),
      file,
    )
})

test("Security runs on CI, install and check discovery paths, whatever the model says", () => {
  const { triggers, fullReview } = critic("security")
  assert.equal(fullReview, true)
  for (const path of [
    ".github/workflows/ci.yaml",
    ".github/merge-gate.json",
    "package.json",
    "apps/ui/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/checks/list.mjs",
    ".npmrc",
  ])
    assert.ok(
      triggers.some((trigger) => matchesGlob(path, trigger)),
      path,
    )
})
