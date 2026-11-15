import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { OpenAPIHono } from "@hono/zod-openapi"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { AppEnv } from "../../app/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { applyLogContract } from "../../observability/logContract.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceRoutes } from "./workspaces.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_detached_errors_${suffix}`,
  slug: `detached-errors-${suffix}`,
  name: "Detached errors",
}
// No repository is at this path, so a hydrate queue fails.
const missingRepository = (name: string) =>
  join(tmpdir(), `ctxpipe-missing-${name}-${suffix}`)

async function seedWorkspace(
  slug: string,
  state: { hydrateStatus: "ready" | "failed"; url: string },
) {
  await withOrgDbContext(org.id, (db) =>
    db.insert(workspaces).values({
      id: `ws_${slug}_${suffix}`,
      orgId: org.id,
      slug,
      displayName: slug,
      workspaceRepositoryUrl: state.url,
      formatVersion: 3,
      hydrateStatus: state.hydrateStatus,
      hydrateError: state.hydrateStatus === "failed" ? "clone failed" : null,
    }),
  )
}

// The real evlog middleware emits the request event when the response goes
// out. The queued jobs fail after that.
function request(path: string, init: RequestInit, requestId: string) {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", evlog())
  app.route("/", workspaceHttpApp(org, workspaceRoutes))
  return app.request(path, {
    ...init,
    headers: { ...init.headers, "x-request-id": requestId },
  })
}

describe("Errors of the jobs that a Workspace request queues and does not wait for (Postgres)", () => {
  // The events, as the production drain sees them.
  const events: Record<string, unknown>[] = []
  const errorEvent = (requestId: string, step: string) =>
    events.find(
      (event) =>
        event["request.id"] === requestId &&
        event.step === step &&
        event.level === "error",
    )

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    initLogger({
      env: { service: "ctxpipe-backend-test" },
      pretty: false,
      drain: (ctx) => {
        applyLogContract(ctx.event)
        events.push(ctx.event as Record<string, unknown>)
      },
    })
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${org.id}`,
    )
    await withOrgDbContext(org.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
      await db.delete(repositories).where(eq(repositories.orgId, org.id))
    })
    const { closeOpenWorkflowClient } =
      await import("../../openworkflow/client.js")
    await closeOpenWorkflowClient()
    await closeDb()
    initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  })

  it("retry-prepare logs a failed hydrate queue as an event of its own, with the request id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await seedWorkspace("retry", {
      hydrateStatus: "failed",
      url: missingRepository("retry"),
    })
    const requestId = `req_retry_${suffix}`

    const response = await request(
      "/workspaces/retry/retry-prepare",
      { method: "POST" },
      requestId,
    )

    expect(response.status).toBe(200)
    await expect
      .poll(() => errorEvent(requestId, "workspace.hydrate.enqueue"), {
        timeout: 5_000,
      })
      .toMatchObject({ error: { message: expect.any(String) } })
    expect(warn.mock.calls.flat().join("\n")).not.toContain("[evlog]")
    warn.mockRestore()
  })

  it("a relink logs a failed hydrate queue as an event of its own, with the request id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await seedWorkspace("relink", {
      hydrateStatus: "ready",
      url: `https://github.com/example/relink-${suffix}.git`,
    })
    const requestId = `req_relink_${suffix}`

    const response = await request(
      "/workspaces/relink",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceRepositoryUrl: missingRepository("relink"),
        }),
      },
      requestId,
    )

    expect(response.status).toBe(200)
    await expect
      .poll(() => errorEvent(requestId, "workspace.hydrate.enqueue"), {
        timeout: 5_000,
      })
      .toMatchObject({ error: { message: expect.any(String) } })
    expect(warn.mock.calls.flat().join("\n")).not.toContain("[evlog]")
    warn.mockRestore()
  })
})
