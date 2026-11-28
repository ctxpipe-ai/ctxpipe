import { OpenAPIHono } from "@hono/zod-openapi"
import { Webhooks } from "@octokit/webhooks"
import { eq, sql } from "drizzle-orm"
import { afterEach, expect, it, vi } from "vitest"

import type { AppEnv } from "../../../app/env.js"
import { withOrgIdContext } from "../../../auth/withAuth.js"
import { type Env, parseEnv } from "../../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../../db/client.js"
import { organizations } from "../../../db/schema/auth.js"
import {
  connectionDirectory,
  connections,
} from "../../../db/schema/connections.js"
import { workspaceSources } from "../../../db/schema/workspace_sources.js"
import { workspaces } from "../../../db/schema/workspaces.js"
import { generateObjectId } from "../../../lib/id.js"
import { getWorkspaceById } from "../../../models/workspaces.js"
import {
  contextStorage,
  createTestLogger,
} from "../../../test/hono-test-logger.js"
import { insertLinkedRepositoryRows } from "../../../test/workspace-links-fixture.js"
import { registerGithubWebhookRoute } from "./github.js"

/** One queued run of the org. */
type QueuedRun = {
  workflow_name: string
  input: unknown
  available_at: Date
}

type PushFixture = {
  org: { id: string; slug: string; name: string }
  workspaceId: string
  /** Send one signed push and give the HTTP status. */
  push: (input: { repository: string; ref: string }) => Promise<number>
  /** The queued runs of the org. */
  runs: () => Promise<QueuedRun[]>
}

/**
 * One org with one GitHub installation and the Workspace repository
 * `fixture/context` (default branch `main`). `linked` links repositories to
 * the Workspace.
 */
async function withPushFixture(
  linked: Array<{ gitUrl: string; desiredRef?: string | null }>,
  test: (f: PushFixture) => Promise<void>,
): Promise<void> {
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
  const env: Env = parseEnv({
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
      for (const row of linked)
        await insertLinkedRepositoryRows(db, {
          orgId: org.id,
          workspaceId,
          ...row,
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
    app.use(contextStorage())
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("log", createTestLogger({ proof: "webhook" }))
      await next()
    })
    registerGithubWebhookRoute(app)
    await test({
      org,
      workspaceId,
      push: async ({ repository, ref }) => {
        const body = JSON.stringify({
          ref,
          before: "a".repeat(40),
          after: "b".repeat(40),
          repository: { full_name: repository, default_branch: "main" },
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
        expect(await response.text()).toBe("")
        return response.status
      },
      runs: async () =>
        (
          await getSystemDb().execute<QueuedRun>(
            sql`select workflow_name, input, available_at from openworkflow.workflow_runs where input->>'orgId' = ${org.id} order by available_at`,
          )
        ).rows.map((row) => ({
          ...row,
          available_at: new Date(row.available_at),
        })),
    })
  } finally {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${org.id}`,
    )
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.connectionId, connectionId))
    await withOrgDbContext(org.id, async (db) => {
      await db
        .delete(workspaceSources)
        .where(eq(workspaceSources.workspaceId, workspaceId))
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      await db.delete(connections).where(eq(connections.id, connectionId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
    await closeDb()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

it("a signed push durably queues the common tip resolver without publishing webhook metadata", async () => {
  await withPushFixture([], async (f) => {
    expect(
      await f.push({ repository: "fixture/context", ref: "refs/heads/main" }),
    ).toBe(200)
    expect(
      (await f.runs()).map(({ workflow_name, input }) => ({
        workflow_name,
        input,
      })),
    ).toEqual([
      { workflow_name: "workspace-tip-check", input: { orgId: f.org.id } },
    ])
    await withOrgIdContext(f.org, async () =>
      expect(await getWorkspaceById(f.workspaceId)).toMatchObject({
        desiredGeneration: 4,
        desiredSha: "a".repeat(40),
        desiredDefaultBranch: "main",
      }),
    )
  })
})

it("pushes queue one tip check for each org and minute, and only for a branch that the org reads (CTX-1305)", async () => {
  // Only `Date` is fake: the database client keeps its real timers.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-16T10:00:10.000Z"))
  await withPushFixture(
    [
      { gitUrl: "https://github.com/fixture/library", desiredRef: "release" },
      { gitUrl: "https://github.com/fixture/service" },
    ],
    async (f) => {
      const tipChecks = async () =>
        (await f.runs())
          .filter((run) => run.workflow_name === "workspace-tip-check")
          .map((run) => run.available_at.toISOString())
      // Branches that no tip of the org reads.
      for (const push of [
        { repository: "fixture/context", ref: "refs/heads/feature" },
        { repository: "fixture/context", ref: "refs/tags/v1" },
        { repository: "fixture/library", ref: "refs/heads/main" },
        { repository: "fixture/service", ref: "refs/heads/feature" },
        { repository: "fixture/unrelated", ref: "refs/heads/main" },
      ])
        expect(await f.push(push)).toBe(200)
      expect(await tipChecks()).toEqual([])

      // The Workspace default branch, the ref of a linked repository, and
      // the default branch of a linked repository with no ref: one check at
      // the end of the minute reads all of them.
      for (const push of [
        { repository: "fixture/context", ref: "refs/heads/main" },
        { repository: "Fixture/Context", ref: "refs/heads/main" },
        { repository: "fixture/library", ref: "refs/heads/release" },
      ])
        expect(await f.push(push)).toBe(200)
      vi.setSystemTime(new Date("2026-11-16T10:00:50.000Z"))
      expect(
        await f.push({ repository: "fixture/service", ref: "refs/heads/main" }),
      ).toBe(200)
      expect(await tipChecks()).toEqual(["2026-11-16T10:01:00.000Z"])

      // A push in the next minute queues the next check.
      vi.setSystemTime(new Date("2026-11-16T10:01:05.000Z"))
      expect(
        await f.push({ repository: "fixture/context", ref: "refs/heads/main" }),
      ).toBe(200)
      expect(await tipChecks()).toEqual([
        "2026-11-16T10:01:00.000Z",
        "2026-11-16T10:02:00.000Z",
      ])
    },
  )
})
