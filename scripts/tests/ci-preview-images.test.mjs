import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, afterEach, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"

import { images, writePlan } from "../ci/deploy-images.mjs"
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

const plan = ({ dir }) => planPreviewImages({ root: dir, repo, token: "t" })
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

test("a change to deploy.yaml or to the image inputs since main builds every image", async () => {
  for (const path of [
    ".github/workflows/deploy.yaml",
    "scripts/ci/deploy-images.mjs",
  ]) {
    const commits = repository({ [path]: "x\n" })
    server.use(...githubApi(commits))
    assert.deepEqual(built(await plan(commits)), [...names].sort(), path)
  }
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

// CI builds no preview image: `factory preview up` builds them on the agent
// host (CTX-1349), and reads the plan from stdout.
test("no workflow builds or pushes a preview image", () => {
  const workflows = join(root, ".github/workflows")
  for (const file of readdirSync(workflows)) {
    const text = readFileSync(join(workflows, file), "utf8")
    assert.doesNotMatch(text, /ctxpipe-pr\/|preview-pr-image-push/, file)
  }
})

// The plan as the factory CLI reads it: stdout, without $GITHUB_OUTPUT. The
// table goes to stderr then.
function printedPlan(t, result, names) {
  const log = t.mock.method(console, "log", () => {})
  const error = t.mock.method(console, "error", () => {})
  const env = { ...process.env }
  delete process.env.GITHUB_OUTPUT
  delete process.env.GITHUB_STEP_SUMMARY
  try {
    writePlan(
      result,
      images.filter(({ image }) => names.includes(image)),
    )
  } finally {
    Object.assign(process.env, env)
    log.mock.restore()
    error.mock.restore()
  }
  const text = (mock) => mock.mock.calls.map((c) => c.arguments[0]).join("\n")
  return { stdout: text(log), stderr: text(error) }
}

test("the plan goes to stdout, and a changed path with a newline cannot forge a line of it", (t) => {
  const { stdout: printed, stderr: table } = printedPlan(
    t,
    {
      build: [{ image: "ui" }],
      reuse: { backend: digestOf("backend") },
      reasons: { ui: "changed", backend: "kept" },
    },
    ["backend", "ui"],
  )
  assert.match(table, /^\| ui \| build: changed \|$/m)
  assert.doesNotMatch(printed, /\| ui \|/)
  assert.match(printed, /^build=\[\{"image":"ui"\}\]$/m)
  assert.match(
    printed,
    new RegExp(`^reuse=\\{"backend":"${digestOf("backend")}"\\}$`, "m"),
  )
  for (const separator of ["\n", "\r", "\u0085", "\u2028", "\u2029"]) {
    const { stdout, stderr } = printedPlan(
      t,
      {
        build: [{ image: "ui" }],
        reuse: {},
        reasons: { ui: `apps/ui/x${separator}reuse={"ui":"sha256:0"} changed` },
      },
      ["ui"],
    )
    assert.equal(stdout, 'build=[{"image":"ui"}]\nreuse={}', JSON.stringify(separator))
    assert.equal(stderr.split(/\r\n|[\n\r\u0085\u2028\u2029]/u).length, 3, JSON.stringify(separator))
  }
})
