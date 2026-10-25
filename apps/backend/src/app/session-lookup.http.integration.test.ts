import { initLogger } from "evlog"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { recordSpans } from "../../test/spans.js"
import { withTestLogger } from "../test/with-test-logger.js"

const spans = recordSpans()

// The app loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

describe("one Better Auth session lookup per request (Postgres)", () => {
  let seed: SeededOrg | undefined
  let app: Awaited<ReturnType<(typeof import("./app.js"))["createApp"]>>

  function requireSeed(): SeededOrg {
    if (!seed) throw new Error("seedOrg did not run")
    return seed
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    // setup-evlog turns logging off, and then evlog() sets no `c.var.log` and
    // the identify middleware does not run. Turn it on as in production.
    initLogger({
      enabled: true,
      silent: true,
      env: { service: "ctxpipe-backend-test" },
    })
    seed = await seedOrg()
    const { createApp } = await import("./app.js")
    app = createApp()
  })

  afterAll(async () => {
    initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
    if (seed) await cleanupSeededOrg(seed)
  })

  /** Count the SELECTs on `table`, from the per-query Postgres spans. */
  async function countSessionReads(
    path: string,
    headers: Record<string, string>,
    table = "sessions",
  ) {
    spans.reset()
    const response = await withTestLogger(async () =>
      app.request(`http://localhost${path}`, {
        headers: {
          origin: process.env.AUTH_BASE_URL ?? "http://localhost:3000",
          ...headers,
        },
      }),
    )
    const reads = spans
      .finishedSpans()
      .filter(
        (span) =>
          span.attributes["db.operation.name"] === "SELECT" &&
          span.attributes["db.collection.name"] === table,
      ).length
    return { status: response.status, reads }
  }

  it("reads the session one time for a cookie request to an org route", async () => {
    const { orgSlug, cookie } = requireSeed()
    const result = await countSessionReads(`/${orgSlug}/api/v1/workspaces`, {
      cookie,
    })
    expect(result).toEqual({ status: 200, reads: 1 })
  })

  it("verifies a personal API key one time", async () => {
    const { orgSlug, personalApiKey } = requireSeed()
    // Better Auth makes the key session from the `apikeys` row.
    const result = await countSessionReads(
      `/${orgSlug}/api/v1/workspaces`,
      { "x-api-key": personalApiKey },
      "apikeys",
    )
    expect(result).toEqual({ status: 200, reads: 1 })
  })

  it("still refuses a cookie on an org that the user is not a member of", async () => {
    const result = await countSessionReads(
      "/org-that-does-not-exist/api/v1/workspaces",
      { cookie: requireSeed().cookie },
    )
    expect(result.status).toBeGreaterThanOrEqual(403)
    expect(result.reads).toBe(1)
  })

  it("does not read the session on an excluded path", async () => {
    const result = await countSessionReads("/.status", {
      cookie: requireSeed().cookie,
    })
    expect(result.reads).toBe(0)
  })
})
