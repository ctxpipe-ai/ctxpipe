import { OpenAPIHono } from "@hono/zod-openapi"
import { Webhooks } from "@octokit/webhooks"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../../app/env.js"
import { withOrgIdContext } from "../../../auth/withAuth.js"
import { parseEnv } from "../../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../../db/client.js"
import { organizations } from "../../../db/schema/auth.js"
import {
  connections,
  connectionDirectory,
} from "../../../db/schema/connections.js"
import { workspaces } from "../../../db/schema/workspaces.js"
import { generateObjectId } from "../../../lib/id.js"
import { getWorkspaceById } from "../../../models/workspaces.js"
import { createLogger } from "../../../observability/logger.js"
import { registerGithubWebhookRoute } from "./github.js"

it("a signed push durably queues the common tip resolver without publishing webhook metadata", async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required")
  initDb(process.env.DATABASE_URL)
  const org = {
    id: generateObjectId("org"),
    slug: generateObjectId("slug"),
    name: "Webhook tip proof",
  }
  const workspaceId = generateObjectId("ws")
  const connectionId = generateObjectId("con")
  const installationId = Date.now()
  const env = parseEnv({
    ...process.env,
    GITHUB_WEBHOOK_SECRET: "synthetic-native-webhook-proof",
  })
  try {
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, createdAt: new Date() })
    await withOrgDbContext(org.id, async (db) => {
      await db.insert(connections).values({
        id: connectionId,
        orgId: org.id,
        type: "github",
        config: {
          installationId,
          ingestAllRepositories: false,
          includeFutureRepos: false,
        },
      })
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId: org.id,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: "https://github.com/fixture/context",
        desiredGeneration: 4,
        desiredSha: "a".repeat(40),
        desiredDefaultBranch: "main",
      })
    })
    await getSystemDb()
      .insert(connectionDirectory)
      .values({
        connectionId,
        orgId: org.id,
        type: "github",
        githubInstallationId: String(installationId),
      })
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("log", createLogger({ proof: "webhook" }))
      await next()
    })
    registerGithubWebhookRoute(app)
    const body = JSON.stringify({
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      repository: { full_name: "fixture/context", default_branch: "main" },
      installation: { id: installationId },
      commits: [],
    })
    const signature = await new Webhooks({
      secret: env.GITHUB_WEBHOOK_SECRET!,
    }).sign(body)
    const response = await app.request("/api/v1/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      body,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("")
    const jobs = await getSystemDb().execute(
      sql`select workflow_name, input from openworkflow.workflow_runs where input->>'orgId' = ${org.id}`,
    )
    expect(jobs.rows).toEqual([
      { workflow_name: "workspace-tip-check", input: { orgId: org.id } },
    ])
    await withOrgIdContext(org, async () =>
      expect(await getWorkspaceById(workspaceId)).toMatchObject({
        desiredGeneration: 4,
        desiredSha: "a".repeat(40),
        desiredDefaultBranch: "main",
      }),
    )
  } finally {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${org.id}`,
    )
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.connectionId, connectionId))
    await withOrgDbContext(org.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      await db.delete(connections).where(eq(connections.id, connectionId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
    await closeDb()
  }
})
