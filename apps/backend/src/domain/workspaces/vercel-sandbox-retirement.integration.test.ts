import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { useMswServer } from "../../../test/msw.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  listSandboxInstances,
  persistSandboxInstance,
  type SandboxInstanceRecord,
} from "../../models/workspace-sandboxes.js"
import { sweepConversationSandboxes } from "./conversation-sandbox-lifecycle.js"

const API = "https://vercel.com/api/v2/sandboxes"
const TOKEN = "test-vercel-token"

/**
 * A Vercel project that holds sandboxes and their snapshots, and applies
 * deletes. `failDelete` answers 503 to the delete of those sandboxes.
 */
function vercelProject(input: {
  sandboxes: string[]
  snapshots: Record<string, string>
  failDelete: Set<string>
}) {
  const sandboxes = new Set(input.sandboxes)
  // Snapshot id -> the sandbox it was taken from.
  const snapshots = new Map(Object.entries(input.snapshots))
  const snapshotBody = (id: string, status = "created") => ({
    id,
    sourceSessionId: "sess_x",
    region: "iad1",
    status,
    sizeBytes: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  const sandboxBody = (name: string) => ({
    name,
    persistent: true,
    createdAt: 1,
    updatedAt: 1,
    currentSessionId: `sess_${name}`,
    status: "stopped",
    tags: {},
  })
  const handlers = [
    http.get(`${API}/snapshots`, ({ request }) => {
      const name = new URL(request.url).searchParams.get("name")
      return HttpResponse.json({
        snapshots: [...snapshots]
          .filter(([, owner]) => owner === name)
          .map(([id]) => snapshotBody(id)),
        pagination: { count: 0, next: null },
      })
    }),
    http.get(`${API}/snapshots/:id`, ({ params }) =>
      snapshots.has(String(params.id))
        ? HttpResponse.json({ snapshot: snapshotBody(String(params.id)) })
        : HttpResponse.json({}, { status: 404 }),
    ),
    http.delete(`${API}/snapshots/:id`, ({ params }) => {
      const id = String(params.id)
      if (!snapshots.delete(id)) return HttpResponse.json({}, { status: 404 })
      return HttpResponse.json({ snapshot: snapshotBody(id, "deleted") })
    }),
    http.get(`${API}/:name`, ({ params }) => {
      const name = String(params.name)
      if (!sandboxes.has(name)) return HttpResponse.json({}, { status: 404 })
      return HttpResponse.json({
        sandbox: sandboxBody(name),
        session: {
          id: `sess_${name}`,
          memory: 2048,
          vcpus: 1,
          region: "iad1",
          runtime: "node24",
          timeout: 60_000,
          status: "stopped",
          requestedAt: 1,
          createdAt: 1,
          cwd: "/vercel/sandbox",
          updatedAt: 1,
        },
        routes: [],
      })
    }),
    http.delete(`${API}/:name`, ({ params }) => {
      const name = String(params.name)
      if (input.failDelete.has(name))
        return HttpResponse.json(
          { error: { message: `unavailable ${name}` } },
          { status: 503 },
        )
      if (!sandboxes.delete(name)) return HttpResponse.json({}, { status: 404 })
      return HttpResponse.json({ sandbox: sandboxBody(name) })
    }),
  ]
  return { handlers, sandboxes, snapshots }
}

const server = useMswServer()
let requests = 0
server.events.on("request:start", () => {
  requests += 1
})

const orgId = generateObjectId("org")
const workspaceId = generateObjectId("ws")
// A conversation that exists, so the sweep keeps its recent stopped sandbox.
const conversationId = generateObjectId("conv")

function row(
  input: Pick<SandboxInstanceRecord, "kind" | "provider"> &
    Partial<SandboxInstanceRecord>,
): SandboxInstanceRecord {
  return {
    id: generateObjectId("sbx"),
    orgId,
    workspaceId,
    state: "stopped",
    lastHeartbeatAt: new Date(),
    ...input,
  }
}

const name = (label: string) => `${label}-${orgId}`

/** Every event that the retirement logs. */
const events: Record<string, unknown>[] = []

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the sandbox sweep")
  initDb(url)
  initLogger({
    env: { service: "ctxpipe-backend-test" },
    pretty: false,
    silent: true,
    drain: (ctx) => {
      const event = ctx.event as Record<string, unknown>
      if (event.step === "vercel-sandbox-retirement") events.push(event)
    },
  })
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Vercel retirement proof",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, async (db) => {
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: "https://example.test/context.git",
    })
    await db.insert(conversations).values({
      id: conversationId,
      orgId,
      name: "Vercel thread",
      workspaceId,
    })
  })
})

beforeEach(() => {
  vi.stubEnv("VERCEL_TOKEN", TOKEN)
  vi.stubEnv("VERCEL_TEAM_ID", "team_test")
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_test")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await withOrgDbContext(orgId, (db) =>
    db
      .delete(workspaceSandboxInstances)
      .where(eq(workspaceSandboxInstances.orgId, orgId)),
  )
})

afterAll(async () => {
  await withOrgDbContext(orgId, async (db) => {
    await db.delete(conversations).where(eq(conversations.orgId, orgId))
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
})

const vercelRows = async () =>
  (await withOrgDbContext(orgId, () => listSandboxInstances({}))).filter(
    (item) => item.provider === "vercel",
  )

describe("the sweep retires Vercel sandboxes (Postgres)", () => {
  it("deletes each Vercel resource and its row, keeps a row whose delete fails, and drains it on a later sweep", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
    const project = vercelProject({
      sandboxes: [
        name("chat"),
        name("chat-fail"),
        name("ingest"),
        name("job"),
        name("base"),
      ],
      snapshots: {
        [`snap_chat_${orgId}`]: name("chat"),
        [`snap_base_${orgId}`]: name("base"),
        [`snap_builder_${orgId}`]: name("base"),
      },
      failDelete: new Set([name("chat-fail")]),
    })
    server.use(...project.handlers)
    const failing = row({
      kind: "chat",
      provider: "vercel",
      conversationId,
      providerSandboxId: name("chat-fail"),
    })
    const docker = row({
      kind: "base",
      provider: "docker",
      providerSandboxId: name("docker-builder"),
      latestSnapshotId: `sha256:${orgId}`,
      state: "live",
    })
    for (const record of [
      row({
        kind: "chat",
        provider: "vercel",
        conversationId: generateObjectId("conv"),
        providerSandboxId: name("chat"),
      }),
      // Vercel no longer has it.
      row({
        kind: "chat",
        provider: "vercel",
        conversationId: generateObjectId("conv"),
        providerSandboxId: name("chat-gone"),
      }),
      failing,
      row({
        kind: "ingest",
        provider: "vercel",
        conversationId: `ingest:run_${orgId}:0`,
        providerSandboxId: name("ingest"),
        state: "live",
      }),
      row({ kind: "job", provider: "vercel", providerSandboxId: name("job") }),
      row({
        kind: "base",
        provider: "vercel",
        providerSandboxId: name("base"),
        latestSnapshotId: `snap_base_${orgId}`,
        state: "live",
      }),
      // A base whose builder is gone and whose snapshot Vercel no longer has.
      row({
        kind: "base",
        provider: "vercel",
        latestSnapshotId: `snap_gone_${orgId}`,
        state: "live",
      }),
      // Not Vercel: the retirement never touches it.
      docker,
    ])
      await persistSandboxInstance(record)

    const now = new Date()
    const first = await sweepConversationSandboxes(orgId, now)
    expect([...project.sandboxes]).toEqual([name("chat-fail")])
    expect(project.snapshots.size).toBe(0)
    expect((await vercelRows()).map((item) => item.id)).toEqual([failing.id])
    // The failed row brings the next sweep to the retry, not to the docker
    // base's retention end.
    expect(first.nextSweepAt?.getTime()).toBeLessThanOrEqual(
      now.getTime() + 5 * 60_000,
    )

    project.sandboxes.delete(name("chat-fail"))
    const second = await sweepConversationSandboxes(orgId, new Date())
    expect(await vercelRows()).toEqual([])
    expect(second.nextSweepAt?.getTime()).toBeGreaterThan(
      Date.now() + 24 * 60 * 60_000,
    )
    expect(
      (await withOrgDbContext(orgId, () => listSandboxInstances({}))).map(
        (item) => item.id,
      ),
    ).toEqual([docker.id])

    const before = requests
    await sweepConversationSandboxes(orgId, new Date())
    expect(requests).toBe(before)

    // Counts and status codes only: no org, Workspace, sandbox or snapshot
    // id, no token, and no error text.
    expect(events.map((event) => event.message)).toEqual([
      "Retiring a Vercel sandbox failed (kind chat)",
      "Retired 6 Vercel sandboxes, 1 failed",
      "Retired 1 Vercel sandboxes, 0 failed",
    ])
    expect(events[0]).toMatchObject({ kind: "chat", status: 503 })
    for (const event of events) {
      const text = JSON.stringify(event)
      for (const secret of [orgId, workspaceId, TOKEN, "unavailable", "snap_"])
        expect(text).not.toContain(secret)
    }
  })

  it("does nothing while the deployment runs Vercel sandboxes (a rollback)", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "vercel")
    const kept = row({
      kind: "chat",
      provider: "vercel",
      conversationId,
      providerSandboxId: name("rollback"),
    })
    await persistSandboxInstance(kept)
    const before = requests
    await sweepConversationSandboxes(orgId, new Date())
    expect(requests).toBe(before)
    expect((await vercelRows()).map((item) => item.id)).toEqual([kept.id])
  })
})
