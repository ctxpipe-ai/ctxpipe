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
const digestOf = (source, image) =>
  `sha256:${Buffer.from(`${source}${image}`).toString("hex").padEnd(64, "0").slice(0, 64)}`
const workflowPath = ".github/workflows/pr-preview-images.yaml"

// A repository with the Dockerfiles of the images and the preview workflow:
// a commit `main` (the last Deploy run on main), a commit `previous` (the
// head of an earlier preview run of the PR) and the PR head, each with its
// own changes. A change `null` deletes the file.
function repository({ previous = {}, head = {} } = {}) {
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
    workflowPath,
    ...new Set(images.map(({ dockerfile }) => dockerfile)),
  ]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    copyFileSync(join(root, path), join(dir, path))
  }
  const main = commit({ "README.md": "main\n" }, "main")
  const previousSha = commit(previous, "previous")
  const headSha = commit(head, "head")
  return { dir, main, previous: previousSha, head: headSha }
}

// The GitHub API: the successful preview runs of the PR branch with the push
// jobs and their `preview-image` notices, and the last Deploy run on main
// with its publish jobs and their `deploy-image` notices.
function githubApi({ main, previous, previewRuns, deployRuns, noPushJobs }) {
  const jobsOf = (prefix, offset) =>
    names.map((name, index) => ({
      name: `${prefix} (${name})`,
      conclusion: "success",
      check_run_url: `https://api.github.com/repos/${repo}/check-runs/${offset + index}`,
    }))
  const push = jobsOf("Push preview image", 2000)
  const publish = jobsOf("Publish image", 3000)
  return [
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/pr-preview-images.yaml/runs`,
      ({ request }) => {
        const query = new URL(request.url).searchParams
        assert.equal(query.get("branch"), "feature/x")
        assert.equal(query.get("event"), "pull_request")
        assert.equal(query.get("status"), "success")
        return HttpResponse.json({
          workflow_runs: previewRuns ?? [
            {
              id: 41,
              run_attempt: 2,
              head_sha: previous,
              pull_requests: [{ number: 7 }],
            },
          ],
        })
      },
    ),
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yaml/runs`,
      () =>
        HttpResponse.json({
          workflow_runs: deployRuns ?? [
            { id: 9, head_sha: main, event: "push" },
          ],
        }),
    ),
    http.get(
      `https://api.github.com/repos/${repo}/actions/runs/:run/jobs`,
      ({ params }) =>
        HttpResponse.json({
          jobs:
            params.run === "9"
              ? publish
              : noPushJobs
                ? [{ name: "Plan the preview images", conclusion: "success" }]
                : push,
        }),
    ),
    http.get(
      `https://api.github.com/repos/${repo}/check-runs/:id/annotations`,
      ({ params }) => {
        const id = Number(params.id)
        const fromMain = id >= 3000
        const image = names[id - (fromMain ? 3000 : 2000)]
        return HttpResponse.json([
          {
            annotation_level: "notice",
            title: fromMain ? "deploy-image" : "preview-image",
            message: `${image} ${digestOf(fromMain ? "main" : "pr", image)}`,
          },
        ])
      },
    ),
  ]
}

const plan = ({ dir, head }) =>
  planPreviewImages({
    root: dir,
    repo,
    token: "t",
    pr: "7",
    head,
    branch: "feature/x",
  })
const built = (result) => result.build.map(({ image }) => image).sort()

test("a push that changes no image input since the PR's last preview builds nothing and keeps each image of that preview", async () => {
  const commits = repository({ head: { "README.md": "docs\n" } })
  server.use(...githubApi(commits))
  const result = await plan(commits)
  assert.deepEqual(built(result), [])
  assert.deepEqual(
    result.reuse,
    Object.fromEntries(
      names.map((name) => [name, `pr ${digestOf("pr", name)}`]),
    ),
  )
})

test("a change to the UI builds only ui, and the other images keep the PR's last preview", async () => {
  const commits = repository({ head: { "apps/ui/src/a.ts": "x\n" } })
  server.use(...githubApi(commits))
  const result = await plan(commits)
  assert.deepEqual(built(result), ["ui"])
  assert.equal(result.reuse.codesearch, `pr ${digestOf("pr", "codesearch")}`)
  assert.match(result.reasons.ui, /apps\/ui\/src\/a\.ts changed/)
})

test("an image whose input changed since the last preview but not since main keeps the image of main", async () => {
  // The earlier preview had a UI change that the PR head reverts.
  const commits = repository({
    previous: { "apps/ui/src/a.ts": "x\n" },
    head: { "apps/ui/src/a.ts": null },
  })
  server.use(...githubApi(commits))
  const result = await plan(commits)
  assert.deepEqual(built(result), [])
  assert.equal(result.reuse.ui, `main ${digestOf("main", "ui")}`)
  assert.equal(result.reuse.backend, `pr ${digestOf("pr", "backend")}`)
})

test("the first preview of a PR keeps each image of main whose inputs did not change", async () => {
  const commits = repository({
    previous: { "apps/backend/src/a.ts": "x\n" },
  })
  server.use(...githubApi({ ...commits, previewRuns: [] }))
  const result = await plan(commits)
  assert.deepEqual(built(result), ["backend", "ui", "worker"])
  assert.equal(
    result.reuse.codesearch,
    `main ${digestOf("main", "codesearch")}`,
  )
})

test("a lockfile change builds every image", async () => {
  const commits = repository({ head: { "pnpm-lock.yaml": "x\n" } })
  server.use(...githubApi(commits))
  assert.deepEqual(built(await plan(commits)), [...names].sort())
})

test("a changed path that git quotes still builds its image", async () => {
  const commits = repository({ head: { "apps/ui/src/café\tx.ts": "x\n" } })
  server.use(...githubApi(commits))
  assert.deepEqual(built(await plan(commits)), ["ui"])
})

test("a change to a local action since the PR's last preview makes that preview no base", async () => {
  // The build job runs .github/actions/setup-buildx: a PR could change it,
  // build, and change it back.
  const commits = repository({
    previous: { ".github/actions/setup-buildx/action.yml": "x\n" },
    head: { ".github/actions/setup-buildx/action.yml": null },
  })
  server.use(...githubApi(commits))
  const result = await plan(commits)
  assert.deepEqual(built(result), [])
  assert.ok(Object.values(result.reuse).every((ref) => ref.startsWith("main ")))
})

test("a preview run with another workflow file, of another PR, a first attempt, or without push jobs is no base", async () => {
  const other = repository({
    previous: { [workflowPath]: "changed\n" },
    head: { [workflowPath]: readFileSync(join(root, workflowPath), "utf8") },
  })
  server.use(...githubApi(other))
  const result = await plan(other)
  // The earlier run had its own workflow file: only main is a base.
  assert.ok(Object.values(result.reuse).every((ref) => ref.startsWith("main ")))

  const commits = repository()
  server.use(
    ...githubApi({
      ...commits,
      previewRuns: [
        {
          id: 42,
          run_attempt: 2,
          head_sha: commits.previous,
          pull_requests: [{ number: 8 }],
        },
        // A first attempt builds nothing.
        {
          id: 43,
          run_attempt: 1,
          head_sha: commits.previous,
          pull_requests: [{ number: 7 }],
        },
      ],
    }),
  )
  assert.ok(
    Object.values((await plan(commits)).reuse).every((ref) =>
      ref.startsWith("main "),
    ),
  )
  server.use(...githubApi({ ...commits, noPushJobs: true }))
  assert.ok(
    Object.values((await plan(commits)).reuse).every((ref) =>
      ref.startsWith("main "),
    ),
  )
})

test("a change to deploy.yaml since main makes main no base", async () => {
  const commits = repository({
    previous: { ".github/workflows/deploy.yaml": "x\n" },
  })
  server.use(...githubApi({ ...commits, previewRuns: [] }))
  assert.deepEqual(built(await plan(commits)), [...names].sort())
})

test("without a base, or when the GitHub API fails, every image builds", async () => {
  const commits = repository()
  server.use(...githubApi({ ...commits, previewRuns: [], deployRuns: [] }))
  const none = await plan(commits)
  assert.deepEqual(built(none), [...names].sort())
  assert.equal(none.reasons.ui, "no earlier image")
  server.use(
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/pr-preview-images.yaml/runs`,
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
  const { jobs } = parse(readFileSync(join(root, workflowPath), "utf8"))
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
