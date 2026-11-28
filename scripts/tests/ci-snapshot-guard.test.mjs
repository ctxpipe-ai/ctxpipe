import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, afterEach, before, test } from "node:test"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"

import { stableVersionsToPublish } from "../ci/snapshot-guard.mjs"

// npm is an outside service: msw answers its HTTP calls.
const server = setupServer()
before(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => server.resetHandlers())
after(() => server.close())

const registry = "https://registry.example.test"

/** A workspace with one package.json in packages/ for each entry. */
function workspace(packages) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-snapshot-guard-"))
  for (const [folder, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, "packages", folder), { recursive: true })
    writeFileSync(
      join(root, "packages", folder, "package.json"),
      JSON.stringify(manifest),
    )
  }
  return root
}

/** npm has each `name@version` of `published`, and no other version. */
function npmHas(published) {
  server.use(
    http.get(`${registry}/:name/:version`, ({ params }) =>
      published.includes(
        `${decodeURIComponent(params.name)}@${params.version}`,
      )
        ? HttpResponse.json({ version: params.version })
        : HttpResponse.json({ error: "not found" }, { status: 404 }),
    ),
  )
}

test("snapshot versions of the tag and stable versions on npm pass", async () => {
  const root = workspace({
    "aws-cdk": {
      name: "@ctxpipe/aws-cdk",
      version: "0.0.0-canary-20261128120000",
    },
    cli: { name: "ctxpipe", version: "0.5.1" },
    review: { name: "@ctxpipe/visual-review", version: "0.0.0", private: true },
  })
  npmHas(["ctxpipe@0.5.1"])
  assert.deepEqual(
    await stableVersionsToPublish({ root, tag: "canary", registry }),
    [],
  )
})

test("a stable version that npm does not have is reported", async () => {
  const root = workspace({
    "aws-cdk": {
      name: "@ctxpipe/aws-cdk",
      version: "0.0.0-canary-20261128120000",
    },
    cli: { name: "ctxpipe", version: "0.6.0" },
  })
  npmHas(["ctxpipe@0.5.1"])
  assert.deepEqual(
    await stableVersionsToPublish({ root, tag: "canary", registry }),
    ["ctxpipe@0.6.0"],
  )
})

test("a snapshot of another tag is not a snapshot of this tag", async () => {
  const root = workspace({
    "aws-cdk": {
      name: "@ctxpipe/aws-cdk",
      version: "0.0.0-beta-20261128120000",
    },
  })
  npmHas([])
  assert.deepEqual(
    await stableVersionsToPublish({ root, tag: "canary", registry }),
    ["@ctxpipe/aws-cdk@0.0.0-beta-20261128120000"],
  )
})

test("an npm error fails the guard", async () => {
  const root = workspace({ cli: { name: "ctxpipe", version: "0.6.0" } })
  server.use(
    http.get(`${registry}/:name/:version`, () =>
      HttpResponse.text("down", { status: 503 }),
    ),
  )
  await assert.rejects(
    stableVersionsToPublish({ root, tag: "canary", registry }),
    /HTTP 503/,
  )
})
