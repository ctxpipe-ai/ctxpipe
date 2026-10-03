import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenAPIHono } from "@hono/zod-openapi"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { afterAll, beforeAll, expect, it } from "vitest"
import { describeWithDatabase } from "../../../test/db.js"
import { recordSpans } from "../../../test/spans.js"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { generateObjectId } from "../../lib/id.js"
import { DEFAULT_CHECKOUT_KEY } from "../../models/repositories.js"
import { backendOtelMiddleware } from "../../observability/http.js"
import { contextStorage } from "../../test/hono-test-logger.js"
import type { repositoryRoutes as RepositoryRoutes } from "./repositories.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({
  path: resolve(__dirname, "../../../.env.local"),
  override: false,
  quiet: true,
})

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_repo_http_attr_${suffix}`
const orgSlug = `repo-http-attr-${suffix}`
const repositoryId = generateObjectId("repo")

const spans = recordSpans()

describeWithDatabase("repository HTTP attribution (Postgres)", () => {
  const events: Record<string, unknown>[] = []
  let repositoryRoutes: typeof RepositoryRoutes

  beforeAll(async () => {
    if (!connectionString) return
    ;({ repositoryRoutes } = await import("./repositories.js"))
    initLogger({
      enabled: true,
      pretty: false,
      env: { service: "ctxpipe-backend-test" },
      drain: async () => {},
    })
    initDb(connectionString)
    await getSystemDb().insert(organizations).values({
      id: orgId,
      name: "Repository HTTP attribution",
      slug: orgSlug,
      createdAt: new Date(),
    })
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(repositories).values({
        id: repositoryId,
        orgId,
        name: `acme/http-attr-${suffix}`,
        gitUrl: `https://github.com/acme/http-attr-${suffix}.git`,
        indexReady: true,
        indexingStatus: "ready",
      })
      await db.insert(repositoryCheckouts).values({
        id: generateObjectId("co"),
        orgId,
        repositoryId,
        ref: "main",
        checkoutKey: DEFAULT_CHECKOUT_KEY,
      })
    })
  })

  afterAll(async () => {
    if (!connectionString) return
    await withOrgDbContext(orgId, (db) =>
      db.delete(repositories).where(eq(repositories.orgId, orgId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    initLogger({
      enabled: false,
      env: { service: "ctxpipe-backend-test" },
    })
    await closeDb()
  })

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use("*", backendOtelMiddleware())
    app.use(
      evlog({
        drain: async (ctx) => {
          const batch = Array.isArray(ctx) ? ctx : [ctx]
          for (const item of batch) {
            events.push(item.event as Record<string, unknown>)
          }
        },
      }),
    )
    app.use("*", async (c, next) => {
      c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
      return withOrgIdContext({ id: orgId, slug: orgSlug }, () =>
        withOrgDbContext(orgId, () => next()),
      )
    })
    app.route("/:orgSlug/api/v1/repositories", repositoryRoutes)
    return app
  }

  it("puts the resolved repository id on the GET 200 root span and request log", async () => {
    events.length = 0
    const secret = "Bearer repo-http-attr-not-a-secret"
    const app = createApp()
    const res = await app.request(
      `http://backend.test/${orgSlug}/api/v1/repositories/${repositoryId}`,
      {
        headers: {
          authorization: secret,
          baggage: "ctxpipe.repository.id=repo_SPOOFED",
          "x-request-id": "req_repo_get",
        },
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: repositoryId })
    const span = spans.serverSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.repository.id": repositoryId,
      "request.id": "req_repo_get",
      "http.response.status_code": 200,
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      "ctxpipe.repository.id": repositoryId,
      requestId: "req_repo_get",
    })
    const serialized = JSON.stringify({
      span: span?.attributes,
      log: events[0],
    })
    expect(serialized).not.toContain("repo_SPOOFED")
    expect(serialized).not.toContain(secret)
  })

  it("does not copy an unresolved GET path id onto the 404 root span", async () => {
    events.length = 0
    const missingId = "repo_UNRESOLVED_PATH"
    const app = createApp()
    const res = await app.request(
      `http://backend.test/${orgSlug}/api/v1/repositories/${missingId}`,
      {
        headers: {
          baggage: `ctxpipe.repository.id=${missingId}`,
          "x-request-id": "req_repo_get_404",
        },
      },
    )

    expect(res.status).toBe(404)
    const span = spans.serverSpan()
    expect(span?.attributes["ctxpipe.repository.id"]).toBeUndefined()
    expect(span?.attributes["request.id"]).toBe("req_repo_get_404")
    expect(events[0]).not.toHaveProperty("ctxpipe.repository.id")
  })

  it("puts the created repository id on the POST 201 root span and request log", async () => {
    events.length = 0
    const secret = "Bearer repo-http-attr-create-not-a-secret"
    const app = createApp()
    const res = await app.request(
      `http://backend.test/${orgSlug}/api/v1/repositories`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: secret,
          baggage: "ctxpipe.repository.id=repo_SPOOFED",
          "x-request-id": "req_repo_create",
        },
        body: JSON.stringify({
          name: `acme/http-attr-create-${suffix}`,
          gitUrl: `https://github.com/acme/http-attr-create-${suffix}.git`,
        }),
      },
    )

    const text = await res.text()
    expect(res.status, text).toBe(201)
    const body = JSON.parse(text) as { id: string }
    expect(body.id).toMatch(/^repo_/)
    const span = spans.serverSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.repository.id": body.id,
      "request.id": "req_repo_create",
      "http.response.status_code": 201,
    })
    expect(events[0]).toMatchObject({
      "ctxpipe.repository.id": body.id,
      requestId: "req_repo_create",
    })
    const serialized = JSON.stringify({
      span: span?.attributes,
      log: events[0],
    })
    expect(serialized).not.toContain("repo_SPOOFED")
    expect(serialized).not.toContain(secret)
  })
})
