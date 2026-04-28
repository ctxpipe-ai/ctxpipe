/**
 * Integration: POST /api/v1/webhook/github with a real HMAC-signed body and
 * seeded `connections` + `repositories` rows exercises the same path as
 * production (list installation → find repo → enqueue ingestion).
 *
 * OpenWorkflow is stubbed (no LLM / codesearch). Asserts the repository row
 * is marked pending re-index (`indexReady: false`, `indexingReason: "push"`)
 * with a fresh `updated_at` — the signal users expect after a push webhook.
 *
 * Skips when DATABASE_URL is unset or Postgres is unreachable.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { OpenAPIHono } from "@hono/zod-openapi"
import { Webhooks } from "@octokit/webhooks"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"
import { initDb, withSystemDbContext } from "../../../db/client.js"
import {
  CONNECTION_TYPE_GITHUB,
  connections,
} from "../../../db/schema/connections.js"
import { organizations } from "../../../db/schema/auth.js"
import { repositories } from "../../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../../db/schema/repository_checkouts.js"
import { parseEnv } from "../../../config/env.js"
import { generateObjectId } from "../../../lib/id.js"
import { isPostgresReachable } from "../../../test/postgresReachable.js"
import { serialiseGithubConnectionConfigForDb } from "../../../lib/connection-config.js"
import { registerGithubWebhookRoute } from "./github.js"

const runWorkflowMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ workflowRun: { id: "wr_stub" } }),
)

vi.mock("../../../openworkflow/client.js", () => ({
  ow: { runWorkflow: runWorkflowMock },
}))

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../../.env.local") })

const connectionString = process.env.DATABASE_URL
const describeIntegration =
  !connectionString || !(await isPostgresReachable(connectionString))
    ? describe.skip
    : describe

const GH_INSTALL_ID = 424242
const ORG_ID = `org_gh_push_${Date.now()}`
const CON_ID = generateObjectId("con")
const REPO_ID = generateObjectId("repo")
const CO_ID = generateObjectId("co")
const ORG_SLUG = `t-gh-webhook-${Date.now()}`
const REPO_FULL_NAME = "acme/webhook-push-test"
const WEBHOOK_SECRET = "test-secret-github-webhook-integration"
const PAST = new Date("2020-06-01T00:00:00.000Z")

function buildEnv() {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: connectionString,
    AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  } as Record<string, string | undefined>)
}

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  const env = buildEnv()
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("log", {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as unknown as AppEnv["Variables"]["log"])
    await next()
  })
  registerGithubWebhookRoute(app)
  return app
}

beforeAll(() => {
  if (!connectionString) return
  initDb(connectionString)
})

afterAll(async () => {
  if (!connectionString) return
  try {
    const { getSystemDb, closeDb } = await import("../../../db/client.js")
    const db = getSystemDb()
    await db
      .delete(repositoryCheckouts)
      .where(eq(repositoryCheckouts.repositoryId, REPO_ID))
    await db
      .delete(repositories)
      .where(eq(repositories.orgId, ORG_ID))
    await db
      .delete(connections)
      .where(eq(connections.orgId, ORG_ID))
    await db.delete(organizations).where(eq(organizations.id, ORG_ID))
    await closeDb()
  } catch {
    // best-effort
  }
})

describeIntegration("POST /api/v1/webhook/github (integration)", () => {
  beforeAll(async () => {
    if (!connectionString) return
    const { getSystemDb } = await import("../../../db/client.js")
    const db = getSystemDb()
    await db.insert(organizations).values({
      id: ORG_ID,
      name: "Webhook test org",
      slug: ORG_SLUG,
      createdAt: PAST,
    })
    await db.insert(connections).values({
      id: CON_ID,
      orgId: ORG_ID,
      type: CONNECTION_TYPE_GITHUB,
      config: serialiseGithubConnectionConfigForDb({
        installationId: GH_INSTALL_ID,
        ingestAllRepositories: false,
        includeFutureRepos: false,
      }),
    })
    await db.insert(repositories).values({
      id: REPO_ID,
      orgId: ORG_ID,
      name: REPO_FULL_NAME,
      gitUrl: `https://github.com/${REPO_FULL_NAME}.git`,
      indexReady: true,
      indexingReason: null,
      lastIngestedHash: "deadbeef",
      githubConnectionId: CON_ID,
      createdAt: PAST,
      updatedAt: PAST,
    })
    await db.insert(repositoryCheckouts).values({
      id: CO_ID,
      repositoryId: REPO_ID,
      ref: "main",
      checkoutKey: "default",
    })
  })

  it("push to default branch marks repository as pending re-index (real DB, stubbed workflow)", async () => {
    const app = createTestApp()
    const bodyObj = {
      ref: "refs/heads/main",
      repository: {
        full_name: REPO_FULL_NAME,
        default_branch: "main",
      },
      installation: { id: GH_INSTALL_ID },
    }
    const body = JSON.stringify(bodyObj)
    const w = new Webhooks({ secret: WEBHOOK_SECRET })
    const sig = await w.sign(body)

    const res = await app.request("/api/v1/webhook/github", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalled()

    const row = await withSystemDbContext(async () => {
      const { getSystemDb } = await import("../../../db/client.js")
      return getSystemDb().query.repositories.findFirst({
        where: { id: { eq: REPO_ID } },
      })
    })

    expect(row).toBeDefined()
    expect(row?.indexReady).toBe(false)
    expect(row?.indexingReason).toBe("push")
    expect(row?.updatedAt).toBeInstanceOf(Date)
    expect(row?.updatedAt?.getTime()).toBeGreaterThan(PAST.getTime())
  })
})
