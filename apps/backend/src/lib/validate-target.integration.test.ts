import { Hono } from "hono"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { useMswServer } from "../../test/msw.js"
import type { AppEnv } from "../app/env.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../test/hono-test-logger.js"
import { validateTarget } from "./validate-target.js"

/*
 * The checks against the real backend app, with a seeded organization and
 * its personal API key in the test database. MSW gives each request for the
 * target origins to the app, and serves the UI that the app proxies to.
 */

const target = "https://target.test"
// The same app on another origin: AUTH_BASE_URL does not match it.
const otherOrigin = "https://other.test"
let app: { fetch: (request: Request) => Response | Promise<Response> }
let seed: SeededOrg

useMswServer(
  http.all(`${target}/*`, ({ request }) => app.fetch(request)),
  http.all(`${otherOrigin}/*`, ({ request }) => app.fetch(request)),
  http.all("http://ui.test/*", () =>
    HttpResponse.html(
      '<!doctype html><script type="module" crossorigin src="/assets/index-Ab12.js"></script>',
    ),
  ),
)

describe("validateTarget (real backend app)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    vi.stubEnv("AUTH_BASE_URL", target)
    vi.stubEnv("UI_PROXY_URL", "http://ui.test")
    seed = await seedOrg()
    const { createApp } = await import("../app/app.js")
    // The test setup turns evlog off, so its middleware makes no request
    // logger. This one gives each request a logger, as in the route tests.
    const outer = new Hono<AppEnv>()
    outer.use(contextStorage())
    outer.use(withTestRequestLogger)
    outer.route("/", createApp())
    app = outer
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
    vi.unstubAllEnvs()
  })

  it("passes each check on the origin of AUTH_BASE_URL", async () => {
    const results = await validateTarget({
      baseUrl: target,
      apiKey: seed.personalApiKey,
    })

    expect(results.filter((result) => !result.ok)).toEqual([])
    expect(results.map((result) => result.name)).toEqual([
      "status",
      "ui",
      "oauth metadata",
      "mcp challenge",
      "openapi",
      "mcp read",
    ])
  })

  it("fails the OAuth checks when AUTH_BASE_URL names another origin", async () => {
    const results = await validateTarget({ baseUrl: otherOrigin })

    const failed = Object.fromEntries(
      results
        .filter((result) => !result.ok)
        .map((result) => [result.name, result.detail]),
    )
    expect(Object.keys(failed)).toEqual(["oauth metadata", "mcp challenge"])
    expect(failed["oauth metadata"]).toBe(
      `the resource is ${target}/mcp, not ${otherOrigin}/mcp. Set AUTH_BASE_URL to ${otherOrigin}.`,
    )
  })

  it("fails the MCP read with a key that does not exist", async () => {
    const results = await validateTarget({
      baseUrl: target,
      apiKey: "not-a-real-key",
    })

    expect(results.find((result) => result.name === "mcp read")?.ok).toBe(false)
  })
})
