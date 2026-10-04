import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { getSandboxInstance } from "../../models/workspaces.js"
import { useMswServer } from "../../../test/msw.js"
import type { WorkspaceRevision } from "./revision.js"
import {
  forgetAgentSnapshot,
  vercelAgentSnapshot,
} from "./vercel-sandbox-provider.js"
import { sandboxAgentImage } from "./workspace-base-providers.js"
import { baseForNewSandbox } from "./workspace-sandbox-base.js"

/**
 * Hosted base choice and agent snapshot lookup against the Vercel API (msw)
 * and a real database: a provider outage never fails a conversation start.
 */

const API = "https://vercel.com/api/v2/sandboxes"
const credentials = {
  token: "test-token",
  teamId: "team_test",
  projectId: "prj_test",
}
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

const orgId = generateObjectId("org")
const workspaceId = generateObjectId("ws")
const baseId = `base:${workspaceId}:test`
const revision: WorkspaceRevision = {
  workspaceId,
  remote: {
    url: "https://github.com/acme/context.git",
    connectionId: null,
  },
  sha: "a".repeat(40),
  generation: 1,
  defaultBranch: "main",
  access: "read",
}

function snapshotResponse(id: string, status: "created" | "deleted") {
  return {
    snapshot: {
      id,
      sourceSessionId: "sess_base",
      region: "iad1",
      status,
      sizeBytes: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  }
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for hosted base choice")
  initDb(process.env.DATABASE_URL)
  vi.stubEnv("VERCEL_TOKEN", credentials.token)
  vi.stubEnv("VERCEL_TEAM_ID", credentials.teamId)
  vi.stubEnv("VERCEL_PROJECT_ID", credentials.projectId)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Hosted base",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, async (db) => {
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: revision.remote.url,
    })
    await db.insert(workspaceSandboxInstances).values({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId,
      provider: "vercel",
      providerSandboxId: "builder-base",
      latestSnapshotId: "snap_base",
      image: await sandboxAgentImage("vercel"),
      revision,
      state: "live",
      lastHeartbeatAt: new Date(),
    })
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await withOrgDbContext(orgId, async (db) => {
    await db
      .delete(workspaceSandboxInstances)
      .where(eq(workspaceSandboxInstances.orgId, orgId))
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

describe("hosted base choice", () => {
  const choose = async () =>
    baseForNewSandbox({
      orgId,
      workspaceId,
      agent: { provider: "vercel", image: await sandboxAgentImage("vercel") },
      revision,
    })

  it("starts without the base, and keeps it, when Vercel cannot say whether it exists", async () => {
    server.use(
      http.get(`${API}/snapshots/snap_base`, () =>
        HttpResponse.json(
          { error: { message: "unavailable" } },
          { status: 503 },
        ),
      ),
    )
    expect(await choose()).toEqual({ requestBuild: false })
    expect((await getSandboxInstance(baseId, orgId))?.state).toBe("live")
  })

  it("starts from the base when it exists", async () => {
    server.use(
      http.get(`${API}/snapshots/snap_base`, () =>
        HttpResponse.json(snapshotResponse("snap_base", "created")),
      ),
    )
    expect(await choose()).toEqual({ ref: "snap_base", requestBuild: false })
  })

  it("marks a base Vercel says is gone, starts without it, and asks for a rebuild", async () => {
    server.use(
      http.get(`${API}/snapshots/snap_base`, () =>
        HttpResponse.json({}, { status: 404 }),
      ),
    )
    expect(await choose()).toEqual({ requestBuild: true })
    expect((await getSandboxInstance(baseId, orgId))?.state).toBe(
      "destroy_failed",
    )
    // Marked: the next start does not ask Vercel again.
    expect(await choose()).toEqual({ requestBuild: true })
  })
})

describe("agent snapshot lookup", () => {
  const environment = `pr-${Date.now()}`
  const far = Date.now() + 20 * 24 * 60 * 60_000

  it("is cached in the process, and looked up again after a failed start", async () => {
    let lookups = 0
    let healthy = true
    server.use(
      http.get(API, () => {
        lookups += 1
        if (!healthy)
          return HttpResponse.json(
            { error: { message: "down" } },
            { status: 500 },
          )
        return HttpResponse.json({
          sandboxes: [
            {
              name: "agent-builder",
              persistent: false,
              createdAt: 1,
              updatedAt: 1,
              currentSessionId: "sess_agent",
              status: "stopped",
              tags: {
                ctxpipe: "workspace-agent",
                environment,
                opencode: "opencode-ai-1.18.34",
              },
            },
          ],
          pagination: { count: 1, next: null },
        })
      }),
      http.get(`${API}/snapshots`, () =>
        HttpResponse.json({
          snapshots: [
            {
              ...snapshotResponse("snap_agent", "created").snapshot,
              expiresAt: far,
            },
          ],
          pagination: { count: 1, next: null },
        }),
      ),
    )
    expect(await vercelAgentSnapshot({ credentials, environment })).toBe(
      "snap_agent",
    )
    expect(lookups).toBe(1)
    // Cached: an API outage does not reach a start.
    healthy = false
    expect(await vercelAgentSnapshot({ credentials, environment })).toBe(
      "snap_agent",
    )
    expect(lookups).toBe(1)
    // A start that failed on it forgets it; the next start looks it up again.
    forgetAgentSnapshot("snap_agent")
    await expect(
      vercelAgentSnapshot({ credentials, environment }),
    ).rejects.toThrow()
    // Looked up again (the Vercel client retries a 5xx itself).
    expect(lookups).toBeGreaterThan(1)
  })
})
