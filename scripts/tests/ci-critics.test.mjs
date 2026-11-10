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
    ["spec", "standards", "simplicity", "security", "visual"],
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

test("Visual is a command critic that runs visual:review only on changed screenshots", () => {
  const { triggers, command, models } = critic("visual")
  assert.equal(models, undefined)
  assert.deepEqual(triggers, ["**/screenshots/*.screenshot.png"])
  assert.ok(
    matchesGlob(
      "apps/ui/src/components/screenshots/Button.Primary.desktop.screenshot.png",
      triggers[0],
    ),
  )
  assert.ok(!matchesGlob("apps/ui/src/components/Button.tsx", triggers[0]))
  // The paths come after `--`, so that a path cannot act as an option.
  const { run } = command
  assert.deepEqual(run.slice(0, 3), ["pnpm", "-s", "visual:review"])
  assert.deepEqual(run.slice(-2), ["--", "{paths}"])
  assert.equal(run[run.indexOf("--images") + 1], "{folder}/binary")
  // The factory gives the rest of the spend limit of the PR (CTX-1233), so
  // that visual:review stops its own model calls there.
  assert.equal(run[run.indexOf("--budget-usd") + 1], "{budgetUsd}")
  const scripts = JSON.parse(readFileSync(`${root}package.json`, "utf8")).scripts
  assert.equal(
    scripts["visual:review"],
    "node packages/visual-review/src/command.ts",
  )
})

test("the Visual version holds the code of the command and the lockfile, not its tests", () => {
  // The factory reuses a stored visual verdict while the critic version
  // stays the same, so each file that can change a judgment is an input: the
  // rubric, the prompt, the model choice, the compare engine and the
  // dependencies. A test file is not, so a new test does not void the
  // stored verdicts.
  const { inputs } = critic("visual")
  const counted = (file) => inputs.some((input) => matchesGlob(file, input))
  const code = files.filter(
    (file) =>
      file.startsWith("packages/visual-review/src/") &&
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      file !== "packages/visual-review/src/compare/fixtures.ts",
  )
  assert.ok(code.length > 0)
  for (const file of [
    ...code,
    "packages/visual-review/package.json",
    "package.json",
    "pnpm-lock.yaml",
  ])
    assert.ok(counted(file), `${file} is not an input of the visual critic`)
  for (const file of files.filter((file) => file.endsWith(".test.ts")))
    assert.ok(!counted(file), file)
})
