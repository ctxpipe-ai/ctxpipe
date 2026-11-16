import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const guard = fileURLToPath(new URL("../ci/check-ci-jobs.mjs", import.meta.url))
// The workflow that PR #679 (commit ebb588924) added, as it merged.
const pr679 = readFileSync(
  new URL("fixtures/ci-jobs/pr-679-pr-preview-images.yaml", import.meta.url),
  "utf8",
)

// Runs the guard on a directory with `files`.
function check(files) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-ci-jobs-"))
  try {
    for (const [path, text] of Object.entries({
      ".github/workflows/.keep": "",
      "scripts/checks/non-portable.json": "{}",
      ...files,
    })) {
      mkdirSync(join(root, dirname(path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return spawnSync(process.execPath, [guard, "--root", root], {
      encoding: "utf8",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("PR #679: a pull request workflow outside the merge gate is blocked", () => {
  const result = check({ ".github/workflows/pr-preview-images.yaml": pr679 })
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /pr-preview-images\.yaml:35: job "build" starts on each pull request push outside the merge gate/,
  )
  // The push job runs only after the build: one finding, at its root.
  assert.doesNotMatch(result.stderr, /job "push"/)
})

// Before PR #725, the test of the check runner imported trace-edges.mjs,
// whose hooks import a package file by a computed path. The selector gave
// `policy:tests-ci-checks` no cache key, and the gate ran it on each PR.
// `call` is split, so that this file has no import() of its own.
const call = "im" + "port("
const pre725 = {
  "scripts/tests/ci-checks.test.mjs": `import { test } from "node:test"
test("the table hook", async () => {
  const { emptyEdges, noteTables } = await ${call}"../checks/trace-edges.mjs")
})
`,
  "scripts/checks/trace-edges.mjs": `import { join } from "node:path"
import { pathToFileURL } from "node:url"
const esm = (lane, name, file, probe) =>
  ${call}pathToFileURL(join(packageDir(lane, name, probe), file)).href)
`,
}
test("pre-#725 policy:tests-ci-checks: a test without a cache key is blocked", () => {
  const result = check(pre725)
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /scripts\/tests\/ci-checks\.test\.mjs: scripts\/checks\/trace-edges\.mjs:4 has an import\(\) with a computed specifier/,
  )
  // After #725 the test imports only the parser, by a literal specifier.
  const after = check({
    "scripts/tests/ci-checks.test.mjs": `import { noteTables } from "../checks/trace-tables.mjs"\n`,
    "scripts/checks/trace-tables.mjs": "export const noteTables = () => {}\n",
  })
  assert.equal(after.status, 0, after.stderr)
})

test("a computed specifier that starts with a string, or after a space, has no key", () => {
  for (const text of [
    `${call}"./checks/" + name + ".mjs")\n`,
    `im` + `port ("./a.mjs" + suffix)\n`,
  ]) {
    const result = check({ "scripts/ci/check-x.mjs": text })
    assert.equal(result.status, 1, text)
    assert.match(result.stderr, /check-x\.mjs:1 has an import\(\)/)
  }
})

test("a check that is not portable states its reason", () => {
  const id = "vitest:contracts:apps/backend/src/a.test.ts"
  const list = check({
    "scripts/checks/non-portable.json": JSON.stringify([id]),
  })
  assert.match(list.stderr, /give each check its reason/)
  const empty = check({
    "scripts/checks/non-portable.json": JSON.stringify({ [id]: " " }),
  })
  assert.match(
    empty.stderr,
    /"vitest:contracts:apps\/backend\/src\/a\.test\.ts" has no reason/,
  )
  const stated = check({
    "scripts/checks/non-portable.json": JSON.stringify({
      [id]: "it reads the environment of the host",
    }),
  })
  assert.equal(stated.status, 0, stated.stderr)
})

test("a job is in the gate, after a job, not on a pull request, or has a reason", () => {
  const open = "$" + "{{"
  const ci = `name: CI
on:
  pull_request:
  schedule:
    - cron: "1 1 * * *"
jobs:
  # outside-gate: the merge gate itself
  merge-gate-plan:
    runs-on: ubuntu-24.04-arm
  lint:
    needs: merge-gate-plan
    if: |
      !cancelled() &&
      (needs.merge-gate-plan.outputs.mode != 'gate' || needs.merge-gate-plan.outputs.lint != '')
    runs-on: ubuntu-24.04-arm
    steps:
      - run: node scripts/checks/selected.mjs out plan.json lint
  report: # after the lint job
    needs: [lint]
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
  nightly:
    if: github.event_name == 'schedule'
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
  after-nightly:
    needs: nightly
    if: always() && needs.nightly.outputs.run != ''
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
  main-only:
    if: (github.ref == 'refs/heads/main') && github.event_name != 'schedule'
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
  copy:
    needs: merge-gate-plan
    if: ${open} !cancelled() && needs.merge-gate-plan.result == 'success' }}
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
  every-push:
    if: always()
    needs: lint
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
  each-gated-push:
    needs: merge-gate-plan
    if: needs.merge-gate-plan.outputs.mode == 'gate'
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
  tests:
    needs: merge-gate-plan
    if: needs.merge-gate-plan.outputs.tests != ''
    runs-on: blacksmith-4vcpu-ubuntu-2404-arm
    steps:
      - run: pnpm exec vitest run
  # outside-manifest: the image is the result of its check (stepResults)
  images:
    needs: merge-gate-plan
    if: needs.merge-gate-plan.outputs.images != ''
    runs-on: blacksmith-4vcpu-ubuntu-2404-arm
    steps:
      - uses: docker/build-push-action@0000000000000000000000000000000000000000
`
  const result = check({ ".github/workflows/ci.yaml": ci })
  assert.equal(result.status, 1)
  // A job after the plan that is not selected runs on each push.
  assert.deepEqual(result.stderr.match(/job "[\w-]+" \w+ \w+/g), [
    'job "copy" starts on',
    'job "every-push" starts on',
    'job "each-gated-push" starts on',
    'job "tests" starts a',
  ])
  // A workflow without a pull request trigger has no rule.
  const push = check({
    ".github/workflows/x.yaml": ci.replace("  pull_request:\n", "  push:\n"),
  })
  assert.equal(push.status, 0, push.stderr)
  // A job key that the guard cannot read fails.
  const inline = check({
    ".github/workflows/x.yaml":
      "on: pull_request\njobs:\n  build: { runs-on: ubuntu-24.04-arm }\n",
  })
  assert.match(inline.stderr, /x\.yaml:3: a job key that the guard cannot read/)
})

test("the workflows and the checks of the repository pass", () => {
  const result = spawnSync(process.execPath, [guard], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
})
