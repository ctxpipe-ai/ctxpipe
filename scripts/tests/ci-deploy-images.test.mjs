import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, afterEach, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"

import { images, planImages, uncoveredSources } from "../ci/deploy-images.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

// GitHub is an outside service: msw answers its HTTP calls.
const server = setupServer()
before(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => server.resetHandlers())
after(() => server.close())

const repo = "example-org/example-repo"
const names = images.map(({ image }) => image)
const digestOf = (image) =>
  `sha256:${Buffer.from(image).toString("hex").padEnd(64, "0").slice(0, 64)}`
const allDigests = Object.fromEntries(
  names.map((name) => [name, digestOf(name)]),
)

test("each deploy image declares every path that its Dockerfile copies", () => {
  for (const image of images)
    assert.deepEqual(uncoveredSources(root, image), [], image.image)
})

test("a copied path that the declared inputs do not cover is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxpipe-deploy-images-"))
  mkdirSync(join(dir, "ctx"))
  writeFileSync(
    join(dir, "ctx/Dockerfile"),
    [
      "FROM node:24 AS deps",
      "COPY package.json pnpm-lock.yaml* ./",
      "FROM deps AS test",
      "COPY scripts/checks ./scripts/checks",
      "FROM deps",
      "COPY --chown=1000:1000 apps/x/src \\",
      "  ./src",
      'COPY ["packages/y", "/y"]',
      "COPY --from=deps /app /app",
      "COPY --from=node:24 /usr/local/bin/node /node",
      "ADD https://example.com/a.tgz /a",
      "RUN --mount=type=bind,source=tools/run.sh,target=/run.sh \\",
      "    --mount=type=cache,target=/root/.cache \\",
      "    sh /run.sh",
      "COPY $SRC ./",
    ].join("\n"),
  )
  const image = {
    image: "x",
    dockerfile: "ctx/Dockerfile",
    context: "ctx",
    inputs: ["ctx/package.json", "ctx/pnpm-lock.yaml", "ctx/apps/x/src"],
  }
  // The stage `test` is not a stage of the default target: BuildKit does not
  // build it, so its copies are not inputs of the image.
  assert.deepEqual(uncoveredSources(dir, image), [
    "ctx/packages/y",
    "ctx/tools/run.sh",
    "ADD https://example.com/a.tgz /a",
    "COPY $SRC ./",
  ])
  assert.deepEqual(uncoveredSources(dir, { ...image, target: "test" }), [
    "ctx/scripts/checks",
  ])
})

// A repository with the Dockerfiles of the deploy images, one commit for the
// last successful Deploy run (the base), and one more commit with `changes`.
function repository(changes, { baseChanges = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ctxpipe-deploy-images-"))
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      { cwd: dir, encoding: "utf8" },
    ).trim()
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
  }
  git("init", "-q", "-b", "main")
  for (const path of [
    ".dockerignore",
    ...new Set(images.map(({ dockerfile }) => dockerfile)),
  ]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    copyFileSync(join(root, path), join(dir, path))
  }
  write({ "README.md": "base\n", ...baseChanges })
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  const base = git("rev-parse", "HEAD")
  write(changes)
  git("add", "-A")
  git("commit", "-q", "-m", "change")
  return { dir, base }
}

// The GitHub API of the base run: the last successful Deploy run on main,
// its Publish jobs, and the `deploy-image` notice of each job.
function github({ base, runs, notices = {} }) {
  const jobs = names.map((name, index) => ({
    id: 1000 + index,
    name: `Publish image (${name})`,
    conclusion: "success",
  }))
  return [
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yaml/runs`,
      ({ request }) => {
        const query = new URL(request.url).searchParams
        assert.equal(query.get("branch"), "main")
        assert.equal(query.get("event"), "push")
        assert.equal(query.get("status"), "success")
        return HttpResponse.json({
          workflow_runs: runs ?? [{ id: 7, head_sha: base }],
        })
      },
    ),
    http.get(`https://api.github.com/repos/${repo}/actions/runs/7/jobs`, () =>
      HttpResponse.json({ jobs }),
    ),
    http.get(
      `https://api.github.com/repos/${repo}/check-runs/:id/annotations`,
      ({ params }) => {
        const name = jobs.find(({ id }) => String(id) === params.id).name
        const image = name.slice("Publish image (".length, -1)
        const messages = notices[image] ?? [`${image} ${digestOf(image)}`]
        return HttpResponse.json(
          messages.map((message) => ({
            annotation_level: "notice",
            title: "deploy-image",
            message,
          })),
        )
      },
    ),
  ]
}

const plan = (dir, event = "push") =>
  planImages({ root: dir, event, repo, runId: "99", token: "t" })
const built = (result) => result.build.map(({ image }) => image)

test("a merge that changes no image input builds no image and reuses each digest", async () => {
  const { dir, base } = repository({
    "README.md": "docs only\n",
    "apps/docs/content/page.mdx": "text\n",
  })
  server.use(...github({ base }))
  const result = await plan(dir)
  assert.deepEqual(built(result), [])
  assert.deepEqual(result.reuse, allDigests)
})

test("a merge that changes only apps/ui builds only ui", async () => {
  const { dir, base } = repository({ "apps/ui/src/page.tsx": "x\n" })
  server.use(...github({ base }))
  const result = await plan(dir)
  assert.deepEqual(built(result), ["ui"])
  assert.deepEqual(result.build[0], {
    image: "ui",
    dockerfile: "apps/ui/Dockerfile",
  })
  const { ui, ...others } = allDigests
  assert.equal(ui, digestOf("ui"))
  assert.deepEqual(result.reuse, others)
})

test("a change to the backend source builds each image that copies it", async () => {
  const { dir, base } = repository({ "apps/backend/src/server.ts": "x\n" })
  server.use(...github({ base }))
  assert.deepEqual(built(await plan(dir)), ["backend", "worker", "ui"])
})

test("a change to the lockfile or the chat sandbox files builds the images that copy them", async () => {
  const lockfile = repository({ "pnpm-lock.yaml": "x\n" })
  server.use(...github({ base: lockfile.base }))
  assert.deepEqual(built(await plan(lockfile.dir)), [
    "backend",
    "worker",
    "ui",
    "codesearch",
  ])
  const proxy = repository({
    "scripts/chat-sandbox/node-http-proxy.cjs": "x\n",
  })
  server.use(...github({ base: proxy.base }))
  assert.deepEqual(built(await plan(proxy.dir)), [
    "chat-sandbox",
    "chat-sandbox-agentcore",
  ])
  // Only the agentcore target copies the shim.
  const shim = repository({ "scripts/chat-sandbox/agentcore-shim.mjs": "x\n" })
  server.use(...github({ base: shim.base }))
  assert.deepEqual(built(await plan(shim.dir)), ["chat-sandbox-agentcore"])
})

test("a change to the deploy workflow or to this plan builds every image", async () => {
  for (const path of [
    ".github/workflows/deploy.yaml",
    "scripts/ci/deploy-images.mjs",
    "scripts/ci/changed-files.mjs",
  ]) {
    const { dir, base } = repository({ [path]: "x\n" })
    server.use(...github({ base }))
    const result = await plan(dir)
    assert.deepEqual(built(result), names, path)
    assert.deepEqual(result.reuse, {})
  }
})

test("a run that is not a push builds every image", async () => {
  const { dir } = repository({ "README.md": "x\n" })
  const result = await plan(dir, "workflow_dispatch")
  assert.deepEqual(built(result), names)
})

test("without a base that main contains, every image builds", async () => {
  const { dir, base } = repository({ "README.md": "x\n" })
  // No successful Deploy run yet.
  server.use(...github({ base, runs: [] }))
  assert.deepEqual(built(await plan(dir)), names)
  // A base that is not in the history of HEAD (a force push).
  server.use(...github({ base, runs: [{ id: 7, head_sha: "f".repeat(40) }] }))
  assert.deepEqual(built(await plan(dir)), names)
  // The run of this workflow itself is no base.
  server.use(...github({ base, runs: [{ id: 99, head_sha: base }] }))
  assert.deepEqual(built(await plan(dir)), names)
  // The GitHub API fails.
  server.use(
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yaml/runs`,
      () => new HttpResponse(null, { status: 502 }),
    ),
  )
  assert.deepEqual(built(await plan(dir)), names)
})

test("an image without exactly one valid digest notice in the base run builds", async () => {
  const { dir, base } = repository({ "README.md": "x\n" })
  server.use(
    ...github({
      base,
      notices: {
        backend: [],
        worker: ["worker sha256:abc"],
        codesearch: [
          `codesearch ${digestOf("codesearch")}`,
          `codesearch ${digestOf("other")}`,
        ],
        ui: [`backend ${digestOf("backend")}`],
      },
    }),
  )
  const result = await plan(dir)
  assert.deepEqual(built(result), ["backend", "worker", "ui", "codesearch"])
  assert.deepEqual(Object.keys(result.reuse), [
    "chat-sandbox",
    "chat-sandbox-agentcore",
  ])
})

test("an image whose Dockerfile copies an undeclared path builds on every merge", async () => {
  const dockerfile = readFileSync(join(root, "apps/ui/Dockerfile"), "utf8")
  const { dir, base } = repository(
    { "README.md": "x\n" },
    {
      baseChanges: {
        "apps/ui/Dockerfile": dockerfile.replace(
          "COPY shared ./shared",
          "COPY shared ./shared\nCOPY packages/new ./packages/new",
        ),
      },
    },
  )
  server.use(...github({ base }))
  const result = await plan(dir)
  assert.deepEqual(built(result), ["ui"])
  assert.match(result.reasons.ui, /packages\/new/)
})
