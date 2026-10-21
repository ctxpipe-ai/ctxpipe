import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"

// config/paths.js reads these variables when it loads.
const { root } = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "checkout-gc-")))
  vi.stubEnv("REPO_CACHE_DIR", join(root, "repo-cache"))
  vi.stubEnv("ZOEKT_INDEX_DIR", join(root, "zoekt-index"))
  return { root }
})

const { getAccessibleRepositoryMock, getIndexableRepositoryMock } = vi.hoisted(
  () => ({
    getAccessibleRepositoryMock: vi.fn(),
    getIndexableRepositoryMock: vi.fn(),
  }),
)

// Codesearch tests have no database, so this stubs the repository row lookup.
vi.mock("../domain/repositories/service.js", () => ({
  getAccessibleRepository: getAccessibleRepositoryMock,
  getIndexableRepository: getIndexableRepositoryMock,
}))

import { withRepositoryIndexOperation } from "../domain/indexing/indexConcurrency.js"
import {
  zoektRepositoryName,
  zoektShardFilePrefix,
} from "../domain/zoekt/shardPrefix.js"
import { createLogger, withLogger } from "../observability/logger.js"
import { registerRepoRoutes } from "./repo.js"

const ORG = "org_gc1"
const REPO = "repo_gcabc"
const checkoutsDir = join(root, "repo-cache", ORG, REPO, "checkouts")
const coldDir = join(root, "zoekt-index")
const published = `rev:${"a".repeat(40)}`
const old = `rev:${"b".repeat(40)}`
const oldWorkspace = `ws:ws_one:${"c".repeat(40)}`
const zoektIds: Record<string, number> = {
  default: 1,
  [published]: 2,
  [old]: 3,
  [oldWorkspace]: 4,
}

function shardName(checkoutKey: string) {
  return `${zoektShardFilePrefix(
    zoektRepositoryName({ orgId: ORG, repoId: REPO, checkoutKey }),
  )}v16.00000.zoekt`
}

async function writeCheckout(checkoutKey: string) {
  await mkdir(join(checkoutsDir, checkoutKey, "src"), { recursive: true })
  await writeFile(
    join(checkoutsDir, checkoutKey, "src", "a.ts"),
    "x".repeat(100),
  )
  await writeFile(join(checkoutsDir, `${checkoutKey}.scip`), "s".repeat(10))
  await writeFile(join(checkoutsDir, `${checkoutKey}.go.scip`), "g".repeat(10))
  await writeFile(join(coldDir, shardName(checkoutKey)), "z".repeat(1000))
}

function app(sub = `repo-gc:${REPO}`) {
  const api = new OpenAPIHono<AppEnv>()
  api.use("*", async (c, next) => {
    c.set("db", {} as AppEnv["Variables"]["db"])
    c.set("auth", {
      sub,
      orgId: ORG,
      principal: "service",
    } as AppEnv["Variables"]["auth"])
    await withLogger(createLogger({}), () => next())
  })
  registerRepoRoutes(api)
  return api
}

const deleteKeys = (checkoutKeys: string[], sub?: string) =>
  app(sub).request(`/${REPO}/checkouts/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkoutKeys }),
  })

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  await rm(join(root, "repo-cache"), { recursive: true, force: true })
  await rm(coldDir, { recursive: true, force: true })
  await mkdir(coldDir, { recursive: true })
  for (const key of Object.keys(zoektIds)) await writeCheckout(key)
  getAccessibleRepositoryMock.mockResolvedValue({
    id: REPO,
    orgId: ORG,
    name: "example",
    gitUrl: "https://github.com/example/example.git",
    publishedCheckoutKey: published,
  })
  getIndexableRepositoryMock.mockImplementation(
    async (_db: unknown, _repo: string, _org: string, key: string) =>
      zoektIds[key] ? { zoektRepoId: zoektIds[key] } : null,
  )
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("POST /{repoId}/checkouts/delete", () => {
  it("deletes only the listed keys and keeps the published and default checkouts", async () => {
    const res = await deleteKeys([old, oldWorkspace, published])

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deleted).toEqual([
      { checkoutKey: old, bytes: 1120 },
      { checkoutKey: oldWorkspace, bytes: 1120 },
    ])
    expect(body.skipped).toEqual([
      { checkoutKey: published, reason: "published" },
    ])
    expect((await readdir(checkoutsDir)).sort()).toEqual(
      [
        "default",
        "default.go.scip",
        "default.scip",
        published,
        `${published}.go.scip`,
        `${published}.scip`,
      ].sort(),
    )
    expect((await readdir(coldDir)).sort()).toEqual(
      [shardName("default"), shardName(published)].sort(),
    )
  })

  it("is idempotent: a key without a row is skipped", async () => {
    getIndexableRepositoryMock.mockResolvedValue(null)

    const res = await deleteKeys([old])

    expect(await res.json()).toEqual({
      deleted: [],
      skipped: [{ checkoutKey: old, reason: "not_found" }],
    })
    expect(await exists(join(checkoutsDir, old))).toBe(true)
  })

  it("deletes nothing while an index job holds the repository", async () => {
    let release = () => {}
    const held = withRepositoryIndexOperation(
      REPO,
      () => new Promise<void>((resolve) => (release = resolve)),
    )

    const res = await deleteKeys([old])
    release()
    await held

    expect(res.status).toBe(409)
    expect(await exists(join(checkoutsDir, old))).toBe(true)
    expect(await exists(join(coldDir, shardName(old)))).toBe(true)
  })

  it("refuses the default key and keys that are not checkout keys", async () => {
    for (const key of [
      "default",
      "rev:../../etc",
      `ws:a/b:${"c".repeat(40)}`,
    ]) {
      const res = await deleteKeys([key])
      expect(res.status).toBe(400)
    }
    expect(await exists(join(checkoutsDir, "default"))).toBe(true)
  })

  it("refuses a caller that has no garbage collection token for the repository", async () => {
    const res = await deleteKeys([old], "repo-purge:repo_gcabc")

    expect(res.status).toBe(403)
    expect(await exists(join(checkoutsDir, old))).toBe(true)
  })
})
