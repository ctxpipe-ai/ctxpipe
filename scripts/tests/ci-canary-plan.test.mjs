import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, afterEach, before, test } from "node:test"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"

import { canaryPlan } from "../ci/canary-plan.mjs"

// npm is an outside service: msw answers its HTTP calls.
const server = setupServer()
before(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => server.resetHandlers())
after(() => server.close())

const registry = "https://registry.example.test"

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
}

/** A repository with one commit. `commit` writes or deletes files and commits. */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ctxpipe-canary-plan-"))
  git(dir, "init", "--quiet", "--initial-branch=main")
  git(dir, "config", "user.email", "ci@example.test")
  git(dir, "config", "user.name", "CI")
  const commit = (files) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) rmSync(join(dir, path))
      else {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), content)
      }
    }
    git(dir, "add", "--all")
    git(dir, "commit", "--quiet", "--allow-empty", "-m", "change")
    return git(dir, "rev-parse", "HEAD")
  }
  commit({ ".changeset/README.md": "# Changesets\n" })
  return { dir, commit }
}

const empty = "---\n---\n\nAn internal change.\n"
const awsCdk = '---\n"@ctxpipe/aws-cdk": patch\n---\n\nA fix.\n'
const cli = "---\nctxpipe: minor\n---\n\nThe CLI text mentions @ctxpipe/aws-cdk: patch.\n"

/** npm serves `pin` as the commit of the canary of @ctxpipe/aws-cdk. */
function canaryOnNpm(pin) {
  const version = "0.0.0-canary-20261128000000"
  const work = mkdtempSync(join(tmpdir(), "ctxpipe-canary-tarball-"))
  mkdirSync(join(work, "package/lib"), { recursive: true })
  writeFileSync(
    join(work, "package/lib/pinned-service-image-tag.js"),
    `"use strict";\nexports.PINNED_SERVICE_IMAGE_TAG = "${pin}";\n`,
  )
  execFileSync("tar", ["-czf", "package.tgz", "package"], { cwd: work })
  const tarball = readFileSync(join(work, "package.tgz"))
  server.use(
    http.get(`${registry}/@ctxpipe%2faws-cdk`, () =>
      HttpResponse.json({
        name: "@ctxpipe/aws-cdk",
        "dist-tags": { latest: "3.2.0", canary: version },
      }),
    ),
    http.get(
      `${registry}/@ctxpipe/aws-cdk/-/aws-cdk-${version}.tgz`,
      () => new HttpResponse(tarball),
    ),
  )
}

test("a changeset of @ctxpipe/aws-cdk after the canary commit publishes a canary", async () => {
  const { dir, commit } = repository()
  canaryOnNpm(commit({ ".changeset/a.md": empty }))
  commit({ ".changeset/b.md": awsCdk })
  const plan = await canaryPlan({ root: dir, registry })
  assert.equal(plan.publish, true, plan.reason)
  assert.match(plan.reason, /\.changeset\/b\.md/)
})

test("only empty changesets and changesets of other packages publish nothing", async () => {
  const { dir, commit } = repository()
  canaryOnNpm(commit({ ".changeset/a.md": awsCdk }))
  commit({ ".changeset/b.md": empty })
  commit({ ".changeset/c.md": cli, "packages/aws-cdk/src/x.ts": "x\n" })
  const plan = await canaryPlan({ root: dir, registry })
  assert.equal(plan.publish, false, plan.reason)
})

// The deploy-main group cancels a queued run. The next run compares with the
// canary on npm, not with the commit before it, so it publishes the change
// of the cancelled run.
test("the changeset of a cancelled run publishes in the next run", async () => {
  const { dir, commit } = repository()
  canaryOnNpm(commit({}))
  commit({ ".changeset/cancelled.md": awsCdk })
  commit({ ".changeset/next.md": empty })
  const plan = await canaryPlan({ root: dir, registry })
  assert.equal(plan.publish, true, plan.reason)
  assert.match(plan.reason, /cancelled\.md/)
})

test("a changeset that a version commit deleted still publishes a canary", async () => {
  const { dir, commit } = repository()
  canaryOnNpm(commit({}))
  commit({ ".changeset/b.md": awsCdk })
  commit({ ".changeset/b.md": null, "packages/aws-cdk/CHANGELOG.md": "# 3.3.0\n" })
  const plan = await canaryPlan({ root: dir, registry })
  assert.equal(plan.publish, true, plan.reason)
})

test("a canary commit that is not in the history publishes a canary", async () => {
  const { dir, commit } = repository()
  commit({ ".changeset/b.md": empty })
  canaryOnNpm("891aa0c2787c64e3086be447f49975d1a9d02b31")
  const plan = await canaryPlan({ root: dir, registry })
  assert.equal(plan.publish, true, plan.reason)
})

test("no canary on npm publishes a canary", async () => {
  const { dir } = repository()
  server.use(
    http.get(`${registry}/@ctxpipe%2faws-cdk`, () =>
      HttpResponse.json({ "dist-tags": { latest: "3.2.0" } }),
    ),
  )
  const plan = await canaryPlan({ root: dir, registry })
  assert.equal(plan.publish, true, plan.reason)
})

test("an npm error fails the plan", async () => {
  const { dir } = repository()
  server.use(
    http.get(`${registry}/@ctxpipe%2faws-cdk`, () =>
      HttpResponse.text("down", { status: 503 }),
    ),
  )
  await assert.rejects(canaryPlan({ root: dir, registry }), /HTTP 503/)
})
