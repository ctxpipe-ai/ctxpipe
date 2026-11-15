import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, afterEach, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { parse } from "yaml"

import { images } from "../ci/deploy-images.mjs"
import { planPreviewImages } from "../ci/preview-images.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

// GitHub is an outside service: msw answers its HTTP calls.
const server = setupServer()
before(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => server.resetHandlers())
after(() => server.close())

const repo = "example-org/example-repo"
const names = ["backend", "worker", "ui", "codesearch"]
const digestOf = (image) =>
  `sha256:${Buffer.from(image).toString("hex").padEnd(64, "0").slice(0, 64)}`

// A repository with the Dockerfiles of the images: a commit `main` (the last
// Deploy run on main) with `mainChanges`, and the PR head with `changes`. A
// change `null` deletes the file.
function repository(changes = {}, mainChanges = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ctxpipe-preview-images-"))
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      { cwd: dir, encoding: "utf8" },
    ).trim()
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        rmSync(join(dir, path))
        continue
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    git("add", "-A")
    git("commit", "-q", "--allow-empty", "-m", message)
    return git("rev-parse", "HEAD")
  }
  git("init", "-q", "-b", "main")
  for (const path of [
    ".dockerignore",
    ...new Set(images.map(({ dockerfile }) => dockerfile)),
  ]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    copyFileSync(join(root, path), join(dir, path))
  }
  const main = commit({ "README.md": "main\n", ...mainChanges }, "main")
  const head = commit(changes, "head")
  return { dir, main, head }
}

// The GitHub API of main: the last successful Deploy run, its Publish jobs
// and the `deploy-image` notice of each job.
function githubApi({ main, deployRuns }) {
  const jobs = images.map(({ image }, index) => ({
    name: `Publish image (${image})`,
    conclusion: "success",
    check_run_url: `https://api.github.com/repos/${repo}/check-runs/${3000 + index}`,
  }))
  return [
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yaml/runs`,
      () =>
        HttpResponse.json({
          workflow_runs: deployRuns ?? [
            { id: 9, head_sha: main, event: "push" },
          ],
        }),
    ),
    http.get(`https://api.github.com/repos/${repo}/actions/runs/9/jobs`, () =>
      HttpResponse.json({ jobs }),
    ),
    http.get(
      `https://api.github.com/repos/${repo}/check-runs/:id/annotations`,
      ({ params }) => {
        const image = images[Number(params.id) - 3000].image
        return HttpResponse.json([
          {
            annotation_level: "notice",
            title: "deploy-image",
            message: `${image} ${digestOf(image)}`,
          },
        ])
      },
    ),
  ]
}

const plan = ({ dir, head }) =>
  planPreviewImages({ root: dir, repo, token: "t", head })
const built = (result) => result.build.map(({ image }) => image).sort()

test("a PR that changes no image input builds nothing and keeps each image of main", async () => {
  const commits = repository({ "README.md": "docs\n" })
  server.use(...githubApi(commits))
  const result = await plan(commits)
  assert.deepEqual(built(result), [])
  assert.deepEqual(
    result.reuse,
    Object.fromEntries(names.map((name) => [name, digestOf(name)])),
  )
})

test("a change to the UI builds only ui", async () => {
  const commits = repository({ "apps/ui/src/a.ts": "x\n" })
  server.use(...githubApi(commits))
  const result = await plan(commits)
  assert.deepEqual(built(result), ["ui"])
  assert.equal(result.reuse.codesearch, digestOf("codesearch"))
  assert.match(result.reasons.ui, /apps\/ui\/src\/a\.ts changed since/)
})

test("a change to the backend source builds each image that copies it, and keeps codesearch", async () => {
  const commits = repository({ "apps/backend/src/a.ts": "x\n" })
  server.use(...githubApi(commits))
  const result = await plan(commits)
  assert.deepEqual(built(result), ["backend", "ui", "worker"])
  assert.deepEqual(Object.keys(result.reuse), ["codesearch"])
})

test("a PR head behind main builds the images whose inputs differ from main", async () => {
  // Main has a UI file that the PR head does not have yet.
  const commits = repository(
    { "apps/ui/src/a.ts": null },
    { "apps/ui/src/a.ts": "x\n" },
  )
  server.use(...githubApi(commits))
  assert.deepEqual(built(await plan(commits)), ["ui"])
})

test("a changed path that git quotes still builds its image", async () => {
  const commits = repository({ "apps/ui/src/café\tx.ts": "x\n" })
  server.use(...githubApi(commits))
  assert.deepEqual(built(await plan(commits)), ["ui"])
})

test("a lockfile change builds every image", async () => {
  const commits = repository({ "pnpm-lock.yaml": "x\n" })
  server.use(...githubApi(commits))
  assert.deepEqual(built(await plan(commits)), [...names].sort())
})

test("a change to deploy.yaml since main builds every image", async () => {
  const commits = repository({ ".github/workflows/deploy.yaml": "x\n" })
  server.use(...githubApi(commits))
  assert.deepEqual(built(await plan(commits)), [...names].sort())
})

test("without a base, or when the GitHub API fails, every image builds", async () => {
  const commits = repository()
  server.use(...githubApi({ ...commits, deployRuns: [] }))
  const none = await plan(commits)
  assert.deepEqual(built(none), [...names].sort())
  assert.equal(none.reasons.ui, "no successful Deploy run on main")
  server.use(
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yaml/runs`,
      () => new HttpResponse(null, { status: 502 }),
    ),
  )
  const failed = await plan(commits)
  assert.deepEqual(built(failed), [...names].sort())
  assert.match(failed.reasons.ui, /HTTP 502/)
})

// The workflow: the first attempt of a run builds nothing, and each push job
// copies a kept image or pushes the built image, and runs no code of the PR.
test("the first attempt of a preview run plans and builds nothing", () => {
  const { jobs } = parse(
    readFileSync(
      join(root, ".github/workflows/pr-preview-images.yaml"),
      "utf8",
    ),
  )
  const attemptSteps = jobs.plan.steps.filter((step) =>
    String(step.if ?? "").includes("github.run_attempt != '1'"),
  )
  assert.ok(attemptSteps.some(({ id }) => id === "plan"))
  assert.match(jobs.build.if, /needs\.plan\.outputs\.build != '\[\]'/)
  assert.match(jobs.build.if, /needs\.plan\.outputs\.build != ''/)
  assert.match(jobs.push.if, /needs\.plan\.outputs\.build != ''/)
  assert.deepEqual(jobs.push.strategy.matrix.image, names)
  for (const step of jobs.push.steps) {
    assert.doesNotMatch(String(step.uses ?? ""), /checkout|^\.\//)
  }
})
