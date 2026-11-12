import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { useMswServer } from "../../test/msw.js"
import { closeDb, initDb, withOrgDbContext } from "../db/client.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  getSandboxInstance,
  persistSandboxInstance,
  type SandboxInstanceRecord,
} from "../models/workspace-sandboxes.js"
import {
  countVercelSandboxes,
  retireVercelSandboxes,
} from "./retireVercelSandboxes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

const API = "https://vercel.com/api/v2/sandboxes"
const credentials = {
  token: "test-vercel-token",
  teamId: "team_test",
  projectId: "prj_test",
}

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgA = `org_test_retire_a_${suffix}`
const orgB = `org_test_retire_b_${suffix}`
const orgIds = [orgA, orgB]
const workspaceA = `ws_test_retire_a_${suffix}`
const workspaceB = `ws_test_retire_b_${suffix}`

/**
 * A Vercel project holding sandboxes and their snapshots. Deletes are
 * applied. `failDelete` answers 403 to the delete of those sandboxes.
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
          { error: { message: "forbidden" } },
          { status: 403 },
        )
      if (!sandboxes.delete(name)) return HttpResponse.json({}, { status: 404 })
      return HttpResponse.json({ sandbox: sandboxBody(name) })
    }),
  ]
  return { handlers, sandboxes, snapshots }
}

function row(
  input: Pick<
    SandboxInstanceRecord,
    "id" | "kind" | "orgId" | "workspaceId" | "provider"
  > &
    Partial<SandboxInstanceRecord>,
): SandboxInstanceRecord {
  return { state: "stopped", lastHeartbeatAt: new Date(), ...input }
}

const names = {
  chat: `chat-${suffix}`,
  chatGone: `chat-gone-${suffix}`,
  chatFail: `chat-fail-${suffix}`,
  ingest: `ingest-${suffix}`,
  base: `base-${suffix}`,
  baseSnapshot: `snap_base_${suffix}`,
  chatSnapshot: `snap_chat_${suffix}`,
  goneSnapshot: `snap_gone_${suffix}`,
}

const rows = [
  row({
    id: `sbx_chat_${suffix}`,
    kind: "chat",
    orgId: orgA,
    workspaceId: workspaceA,
    conversationId: `conv_a_${suffix}`,
    provider: "vercel",
    providerSandboxId: names.chat,
  }),
  // Vercel no longer has it.
  row({
    id: `sbx_chat_gone_${suffix}`,
    kind: "chat",
    orgId: orgA,
    workspaceId: workspaceA,
    conversationId: `conv_b_${suffix}`,
    provider: "vercel",
    providerSandboxId: names.chatGone,
  }),
  row({
    id: `sbx_chat_fail_${suffix}`,
    kind: "chat",
    orgId: orgA,
    workspaceId: workspaceA,
    conversationId: `conv_c_${suffix}`,
    provider: "vercel",
    providerSandboxId: names.chatFail,
  }),
  row({
    id: `sbx_ingest_${suffix}`,
    kind: "ingest",
    orgId: orgA,
    workspaceId: workspaceA,
    conversationId: `ingest:run_${suffix}:0`,
    provider: "vercel",
    providerSandboxId: names.ingest,
    state: "live",
  }),
  row({
    id: `sbx_base_${suffix}`,
    kind: "base",
    orgId: orgA,
    workspaceId: workspaceA,
    provider: "vercel",
    providerSandboxId: names.base,
    latestSnapshotId: names.baseSnapshot,
    state: "live",
  }),
  // A base whose builder is gone and whose snapshot Vercel no longer has.
  row({
    id: `sbx_base_gone_${suffix}`,
    kind: "base",
    orgId: orgB,
    workspaceId: workspaceB,
    provider: "vercel",
    latestSnapshotId: names.goneSnapshot,
    state: "live",
  }),
  // Not Vercel: never touched.
  row({
    id: `sbx_docker_${suffix}`,
    kind: "chat",
    orgId: orgB,
    workspaceId: workspaceB,
    conversationId: `conv_d_${suffix}`,
    provider: "docker",
    providerSandboxId: `container-${suffix}`,
  }),
]

const server = useMswServer()

describe("retireVercelSandboxes (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    for (const [orgId, workspaceId] of [
      [orgA, workspaceA],
      [orgB, workspaceB],
    ] as const)
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId,
          slug: `retire-${workspaceId}`,
          displayName: "Retire",
          workspaceRepositoryUrl: `/tmp/retire-${suffix}`,
          desiredDefaultBranch: "main",
          writeStatus: "read_only",
        }),
      )
    for (const record of rows) await persistSandboxInstance(record)
  })

  afterAll(async () => {
    for (const orgId of orgIds)
      await withOrgDbContext(orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, orgId)),
      )
    await closeDb()
    initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  })

  it("retires the Vercel rows, keeps a row whose delete fails, and is idempotent", async () => {
    const project = vercelProject({
      sandboxes: [names.chat, names.chatFail, names.ingest, names.base],
      snapshots: {
        [names.chatSnapshot]: names.chat,
        [names.baseSnapshot]: names.base,
      },
      failDelete: new Set([names.chatFail]),
    })
    let requests = 0
    server.events.on("request:start", () => {
      requests += 1
    })
    server.use(...project.handlers)
    const events: unknown[] = []
    initLogger({
      env: { service: "ctxpipe-backend-test" },
      pretty: false,
      silent: true,
      drain: (ctx) => {
        events.push(ctx.event)
      },
    })

    const dryRun = await retireVercelSandboxes({ dryRun: true, orgIds })
    expect(dryRun.found).toEqual({ chat: 3, job: 0, base: 2, ingest: 1 })
    expect(requests).toBe(0)
    expect(await countVercelSandboxes(orgIds)).toEqual(dryRun.found)

    const first = await retireVercelSandboxes({ credentials, orgIds })
    expect(first).toEqual({
      found: { chat: 3, job: 0, base: 2, ingest: 1 },
      retired: { chat: 2, job: 0, base: 2, ingest: 1 },
      failed: { chat: 1, job: 0, base: 0, ingest: 0 },
    })
    expect([...project.sandboxes]).toEqual([names.chatFail])
    expect(project.snapshots.size).toBe(0)
    // The failed row is not retired; the Docker row is not Vercel's.
    expect(await getSandboxInstance(`sbx_chat_fail_${suffix}`, orgA)).toEqual(
      expect.objectContaining({ provider: "vercel", state: "stopped" }),
    )
    expect(await getSandboxInstance(`sbx_docker_${suffix}`, orgB)).toEqual(
      expect.objectContaining({ provider: "docker" }),
    )
    expect(await countVercelSandboxes(orgIds)).toEqual({
      chat: 1,
      job: 0,
      base: 0,
      ingest: 0,
    })

    project.sandboxes.clear()
    const second = await retireVercelSandboxes({ credentials, orgIds })
    expect(second.retired.chat).toBe(1)
    const requestsBefore = requests
    const third = await retireVercelSandboxes({ credentials, orgIds })
    expect(third.found).toEqual({ chat: 0, job: 0, base: 0, ingest: 0 })
    expect(requests).toBe(requestsBefore)

    // The logs hold counts and status codes only.
    const logged = JSON.stringify(events)
    expect(events.length).toBeGreaterThan(0)
    for (const secret of [
      orgA,
      orgB,
      workspaceA,
      ...Object.values(names),
      credentials.token,
      suffix,
    ])
      expect(logged).not.toContain(secret)
  })
})
