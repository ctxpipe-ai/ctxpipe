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
import { parse } from "yaml"

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

// The GitHub API of the base run: the successful Deploy runs on main, the
// Publish jobs of each run (a prerelease dispatch has none), and the
// `deploy-image` notice of each job.
function github({ base, runs, prereleases = [], notices = {} }) {
  const jobs = names.map((name, index) => ({
    id: 1000 + index,
    name: `Publish image (${name})`,
    conclusion: "success",
    check_run_url: `https://api.github.com/repos/${repo}/check-runs/${2000 + index}`,
  }))
  return [
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yaml/runs`,
      ({ request }) => {
        const query = new URL(request.url).searchParams
        assert.equal(query.get("branch"), "main")
        assert.equal(query.get("status"), "success")
        return HttpResponse.json({
          workflow_runs: runs ?? [{ id: 7, head_sha: base, event: "push" }],
        })
      },
    ),
    http.get(
      `https://api.github.com/repos/${repo}/actions/runs/:run/jobs`,
      ({ params }) =>
        HttpResponse.json({
          jobs: prereleases.includes(Number(params.run))
            ? [{ id: 1, name: "Prerelease", conclusion: "success" }]
            : jobs,
        }),
    ),
    http.get(
      `https://api.github.com/repos/${repo}/check-runs/:id/annotations`,
      ({ params, request }) => {
        const name = jobs.find(({ check_run_url }) =>
          check_run_url.endsWith(`/${params.id}`),
        ).name
        const image = name.slice("Publish image (".length, -1)
        const annotations = (
          notices[image] ?? [`${image} ${digestOf(image)}`]
        ).map((message) =>
          typeof message === "string"
            ? { annotation_level: "notice", title: "deploy-image", message }
            : message,
        )
        const query = new URL(request.url).searchParams
        const size = Number(query.get("per_page"))
        const page = Number(query.get("page"))
        return HttpResponse.json(
          annotations.slice((page - 1) * size, page * size),
        )
      },
    ),
  ]
}

const plan = (dir, event = "push") =>
  planImages({ root: dir, event, repo, token: "t" })
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
  server.use(
    ...github({
      base,
      runs: [{ id: 7, head_sha: "f".repeat(40), event: "push" }],
    }),
  )
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

test("a notice on a later page of annotations counts, and too many annotations build the image", async () => {
  const { dir, base } = repository({ "README.md": "x\n" })
  const other = { annotation_level: "notice", title: "other", message: "x" }
  server.use(
    ...github({
      base,
      notices: {
        // A forged notice and 99 other annotations push the real notice of
        // ui to page 2.
        ui: [
          `ui ${digestOf("forged")}`,
          ...Array(99).fill(other),
          `ui ${digestOf("ui")}`,
        ],
        worker: [...Array(1000).fill(other), `worker ${digestOf("worker")}`],
      },
    }),
  )
  assert.deepEqual(built(await plan(dir)), ["worker", "ui"])
})

test("a deploy dispatch is a base, and a prerelease dispatch is not", async () => {
  const { dir, base } = repository({ "apps/ui/src/page.tsx": "x\n" })
  const other = "e".repeat(40)
  // The newest run is a prerelease dispatch: the plan skips it and takes the
  // deploy dispatch behind it.
  server.use(
    ...github({
      base,
      prereleases: [9],
      runs: [
        { id: 9, head_sha: other, event: "workflow_dispatch" },
        { id: 8, head_sha: base, event: "workflow_dispatch" },
        { id: 7, head_sha: other, event: "push" },
      ],
    }),
  )
  const result = await plan(dir)
  assert.deepEqual(built(result), ["ui"])
  assert.match(result.reasons.backend, new RegExp(`since ${base.slice(0, 7)}`))
  // Only prerelease dispatches: no base, so every image builds.
  server.use(
    ...github({
      base,
      prereleases: [9],
      runs: [{ id: 9, head_sha: base, event: "workflow_dispatch" }],
    }),
  )
  assert.deepEqual(built(await plan(dir)), names)
})

// The jobs of deploy.yaml that run, from the `if:` and `needs:` of each job,
// with GitHub's rules: a condition without a status function also needs
// success(), and success() and failure() look at every job before the job.
// Each job that runs succeeds, except the jobs in `fail`.
function jobsThatRun({
  event,
  ref = "refs/heads/main",
  deploy,
  build,
  fail = [],
}) {
  const { jobs } = parse(
    readFileSync(join(root, ".github/workflows/deploy.yaml"), "utf8"),
  )
  const needsOf = (name) => [jobs[name].needs ?? []].flat()
  const before = (name) =>
    needsOf(name).flatMap((need) => [need, ...before(need)])
  const truthy = (value) =>
    value !== null && value !== false && value !== "" && value !== 0
  const results = {}
  const order = []
  const visit = (name) => {
    if (order.includes(name)) return
    needsOf(name).forEach(visit)
    order.push(name)
  }
  Object.keys(jobs).forEach(visit)
  for (const name of order) {
    const earlier = before(name).map((job) => results[job])
    const functions = {
      success: () => earlier.every((result) => result === "success"),
      failure: () => earlier.includes("failure"),
      cancelled: () => false,
      always: () => true,
    }
    const values = {
      github: { event_name: event, ref },
      inputs: event === "workflow_dispatch" ? { deploy } : {},
      needs: Object.fromEntries(
        needsOf(name).map((need) => [
          need,
          {
            result: results[need],
            outputs: need === "image_plan" ? { build } : {},
          },
        ]),
      ),
    }
    let condition = String(jobs[name].if ?? "")
      .replace(/^\$\{\{|\}\}$/g, "")
      .trim()
    if (!/\b(success|failure|cancelled|always)\(\)/.test(condition))
      condition = condition ? `success() && (${condition})` : "success()"
    // A GitHub expression of the subset that deploy.yaml uses.
    const tokens = condition.match(
      /'[^']*'|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*|==|!=|&&|\|\||!|\(|\)/g,
    )
    let index = 0
    const primary = () => {
      const token = tokens[index++]
      if (token === "!") return !truthy(primary())
      if (token === "(") {
        const value = or()
        index += 1
        return value
      }
      if (token.startsWith("'")) return token.slice(1, -1)
      if (token.endsWith("()")) return functions[token.slice(0, -2)]()
      return (
        token.split(".").reduce((value, key) => value?.[key], values) ?? null
      )
    }
    const equality = () => {
      let value = primary()
      while (tokens[index] === "==" || tokens[index] === "!=") {
        const equal = tokens[index++] === "=="
        value = (value === primary()) === equal
      }
      return value
    }
    const and = () => {
      let value = equality()
      while (tokens[index] === "&&") {
        index += 1
        const right = equality()
        value = truthy(value) ? right : value
      }
      return value
    }
    const or = () => {
      let value = and()
      while (tokens[index] === "||") {
        index += 1
        const right = and()
        value = truthy(value) ? value : right
      }
      return value
    }
    results[name] = truthy(or())
      ? fail.includes(name)
        ? "failure"
        : "success"
      : "skipped"
  }
  return order.filter((name) => results[name] !== "skipped")
}

const deployJobs = [
  "image_plan",
  "build_images_amd64",
  "build_images_arm64",
  "publish_images",
  "ecr_digests",
  "copy_images_to_ecr",
  "terraform",
  "forge_deploy",
]
const sorted = (names) => [...names].sort()

test("a push to main runs the deploy, also when no image builds", () => {
  assert.deepEqual(
    sorted(jobsThatRun({ event: "push", build: '[{"image":"ui"}]' })),
    sorted([...deployJobs, "release"]),
  )
  const unbuilt = ["build_images_amd64", "build_images_arm64"]
  assert.deepEqual(
    sorted(jobsThatRun({ event: "push", build: "[]" })),
    sorted([...deployJobs, "release"].filter((job) => !unbuilt.includes(job))),
  )
})

test("a failed build stops the publish and every job after it", () => {
  assert.deepEqual(
    sorted(
      jobsThatRun({
        event: "push",
        build: '[{"image":"ui"}]',
        fail: ["build_images_arm64"],
      }),
    ),
    sorted(["image_plan", "build_images_amd64", "build_images_arm64"]),
  )
})

test("a dispatch without the input deploy runs only the prerelease", () => {
  assert.deepEqual(
    jobsThatRun({ event: "workflow_dispatch", deploy: false, build: "[]" }),
    ["prerelease"],
  )
})

test("a dispatch with the input deploy runs the deploy from main, without the release and the prerelease, and nothing from another branch", () => {
  assert.deepEqual(
    sorted(
      jobsThatRun({
        event: "workflow_dispatch",
        deploy: true,
        build: '[{"image":"ui"}]',
      }),
    ),
    sorted(deployJobs),
  )
  assert.deepEqual(
    jobsThatRun({
      event: "workflow_dispatch",
      deploy: true,
      ref: "refs/heads/feature",
      build: '[{"image":"ui"}]',
    }),
    [],
  )
})
