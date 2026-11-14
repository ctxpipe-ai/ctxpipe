import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { parse } from "yaml"

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

test("Blacksmith arm64 labels pass", () => {
  const result = check({
    "a.yaml": "jobs:\n  a:\n    runs-on: blacksmith-4vcpu-ubuntu-2404-arm\n",
  })
  assert.equal(result.status, 0, result.stderr)
})

test("an x64 Blacksmith label needs an amd64 reason", () => {
  const bare = check({
    "a.yaml": "jobs:\n  a:\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n",
  })
  assert.equal(bare.status, 1)
  const before = check({
    "a.yaml":
      "jobs:\n  a:\n    # amd64: the tool has no arm64 build\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n",
  })
  assert.equal(before.status, 0, before.stderr)
  const empty = check({
    "a.yaml":
      "jobs:\n  a:\n    # amd64:\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n",
  })
  assert.equal(empty.status, 1)
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
    "a.yml": "jobs:\n  a:\n    runs-on: $" + "{{ matrix.os }}\n",
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

// ADR-065: the light jobs run on free GitHub-hosted arm runners, and each job
// that uses Docker stays on Blacksmith.
const ci = parse(
  readFileSync(
    fileURLToPath(new URL("../../.github/workflows/ci.yaml", import.meta.url)),
    "utf8",
  ),
).jobs

test("a GitHub-hosted CI job uses no Docker", () => {
  for (const [name, job] of Object.entries(ci)) {
    if (String(job["runs-on"]).startsWith("blacksmith-")) continue
    assert.equal(job.services, undefined, name)
    assert.equal(job.container, undefined, name)
    for (const step of job.steps ?? []) {
      assert.doesNotMatch(step.run ?? "", /\bdocker\b/, name)
      assert.doesNotMatch(step.uses ?? "", /docker|useblacksmith/, name)
    }
  }
})

test("the toolchain record and the git lanes use the pinned git", () => {
  // The Merge gate manifest job records git (major and minor) for every key.
  // The Blacksmith and GitHub-hosted images have different git versions, so
  // the manifest job and each job that runs a lane with git in its key put
  // the pinned git first on PATH.
  for (const job of [
    "merge-gate-manifest",
    "test-shards",
    "package-tests",
    "upgrade-from-previous-release",
  ])
    assert.ok(
      ci[job].steps.some((step) => step.uses === "./.github/actions/git"),
      job,
    )
})

test("Merge gate plan and Merge gate share one cache store", () => {
  // The plan job restores the merge-gate-pr cache that Merge gate saves.
  assert.equal(
    ci["merge-gate-plan"]["runs-on"],
    ci["merge-gate"]["runs-on"],
  )
})

test("a push to main fills the cache that the GitHub-hosted jobs restore", () => {
  const job = ci["github-cache"]
  assert.equal(job.if, "github.event_name == 'push'")
  const uses = (name, prefix) =>
    ci[name].steps.find((step) => step.uses?.startsWith(prefix))
  // The pnpm store: setup-node keys it by the lockfile and the runner.
  for (const name of ["lint", "typecheck", "packages", "storybook-build"]) {
    assert.equal(ci[name]["runs-on"], job["runs-on"], name)
    assert.deepEqual(
      uses(name, "actions/setup-node@").with,
      uses("github-cache", "actions/setup-node@").with,
      name,
    )
  }
  assert.ok(job.steps.some((step) => step.run === "pnpm install --frozen-lockfile"))
  // The Terraform providers: the same path and key as Terraform configuration.
  assert.deepEqual(
    uses("github-cache", "actions/cache@").with,
    uses("terraform-validate", "actions/cache@").with,
  )
  assert.deepEqual(
    uses("github-cache", "hashicorp/setup-terraform@").with,
    uses("terraform-validate", "hashicorp/setup-terraform@").with,
  )
})
