import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

// ADR-065: the light jobs, the test shards, the screenshots and each deploy
// job other than the image builds run on free GitHub-hosted arm runners. The
// other jobs that use Docker stay on Blacksmith.
const ci = parse(
  readFileSync(
    fileURLToPath(new URL("../../.github/workflows/ci.yaml", import.meta.url)),
    "utf8",
  ),
).jobs

// Each job of each workflow, as [<file>#<job>, job, workflow].
const directory = fileURLToPath(
  new URL("../../.github/workflows/", import.meta.url),
)
const allJobs = readdirSync(directory)
  .filter((file) => /\.ya?ml$/.test(file))
  .flatMap((file) => {
    const workflow = parse(readFileSync(join(directory, file), "utf8"))
    return Object.entries(workflow.jobs).map(([name, job]) => [
      `${file}#${name}`,
      job,
      workflow,
    ])
  })

test("a GitHub-hosted job uses no Docker, except the listed jobs", () => {
  // The GitHub-hosted jobs with Docker in their steps: the test shards
  // (service containers, FalkorDB, the chat sandbox image from the registry
  // cache) and the publish job of the deploy (manifest lists through `docker
  // buildx imagetools`, no container). The test reads only the steps: the
  // screenshots job starts the Playwright container from a script
  // (scripts/ci/visual-capture.mjs).
  const githubHostedDocker = [
    "ci.yaml#test-shards",
    "deploy.yaml#publish_images",
  ]
  const jobs = new Map(allJobs)
  for (const name of githubHostedDocker) {
    assert.ok(jobs.has(name), name)
    assert.doesNotMatch(String(jobs.get(name)["runs-on"]), /^blacksmith-/, name)
  }
  for (const [name, job] of jobs) {
    if (String(job["runs-on"]).startsWith("blacksmith-")) continue
    for (const step of job.steps ?? [])
      assert.doesNotMatch(step.uses ?? "", /useblacksmith/, name)
    if (githubHostedDocker.includes(name)) continue
    assert.equal(job.services, undefined, name)
    assert.equal(job.container, undefined, name)
    for (const step of job.steps ?? []) {
      // An image reference on docker.io is no Docker command.
      assert.doesNotMatch(step.run ?? "", /\bdocker\b(?!\.io\/)/, name)
      assert.doesNotMatch(step.uses ?? "", /docker/, name)
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
  assert.equal(ci["merge-gate-plan"]["runs-on"], ci["merge-gate"]["runs-on"])
})

// The workflow that fills the caches of main for the pull request jobs.
const caches = parse(
  readFileSync(
    fileURLToPath(
      new URL("../../.github/workflows/main-caches.yaml", import.meta.url),
    ),
    "utf8",
  ),
)
const uses = (job, prefix) =>
  job.steps?.find((step) => step.uses?.startsWith(prefix))

test("a lockfile change on main fills the pnpm store of both cache stores", () => {
  // setup-node keys the pnpm store by the OS, the architecture and the
  // lockfile, and each runner type has its own cache store. A later push
  // must not cancel a fill. Each job of a pull request workflow restores it.
  assert.deepEqual(caches.on.push.branches, ["main"])
  assert.ok(caches.on.push.paths.includes("pnpm-lock.yaml"))
  assert.ok(caches.on.push.paths.includes(".node-version"))
  assert.notEqual(caches.concurrency["cancel-in-progress"], true)
  const restorersByCacheJob = { "github-cache": [], "blacksmith-cache": [] }
  for (const [name, job, workflow] of allJobs) {
    if (!("pull_request" in (workflow.on ?? {}))) continue
    const setup = uses(job, "actions/setup-node@")
    if (setup?.with?.cache !== "pnpm") continue
    const store = String(job["runs-on"]).startsWith("blacksmith-")
      ? "blacksmith-cache"
      : "github-cache"
    assert.deepEqual(
      setup.with,
      uses(caches.jobs[store], "actions/setup-node@").with,
      name,
    )
    restorersByCacheJob[store].push(name)
  }
  for (const [store, jobs] of Object.entries(restorersByCacheJob)) {
    assert.ok(jobs.length > 0, store)
    assert.ok(
      caches.jobs[store].steps.some(
        (step) => step.run === "pnpm install --frozen-lockfile",
      ),
      store,
    )
  }
  assert.match(caches.jobs["github-cache"]["runs-on"], /^ubuntu-/)
  assert.match(caches.jobs["blacksmith-cache"]["runs-on"], /^blacksmith-/)
})
