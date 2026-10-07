import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  BASE_BUILD_LEASE_MS,
  getSandboxInstance,
} from "../../models/workspaces.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import {
  CHAT_SANDBOX_DELETE_AFTER_MS,
  CHAT_SANDBOX_RETENTION_MS,
} from "./chat-lifecycle.js"
import { sweepConversationSandboxes } from "./conversation-sandbox-lifecycle.js"
import type { WorkspaceRevision } from "./revision.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import {
  builderSnapshotExpiration,
  forgetAgentSnapshot,
  vercelAgentSnapshot,
  vercelConversationProvider,
} from "./vercel-sandbox-provider.js"
import {
  type SandboxAgent,
  sandboxAgentImage,
  type WorkspaceBaseBuilder,
  workspaceBaseBuilder,
} from "./workspace-base-providers.js"
import { WORKSPACE_CHAT_OPENCODE_CLI } from "./workspace-chat-opencode-contract.js"
import {
  baseForNewSandbox,
  reserveWorkspaceBaseBuild,
  runWorkspaceBaseBuild,
} from "./workspace-sandbox-base.js"
import { collectUnusedWorkspaceBases } from "./workspace-sandbox-cleanup.js"

/**
 * Hosted Workspace bases against the Vercel API (msw) and a real database:
 * base choice and its fallbacks, the agent snapshot cache, retention of a
 * superseded base, and the Vercel branch of the build step.
 */

const API = "https://vercel.com/api/v2/sandboxes"
/** The agent snapshot builders' `opencode` tag: runtime and OpenCode version. */
const agentTag = `node26-${WORKSPACE_CHAT_OPENCODE_CLI}`.replace(/[^\w.-]/g, "-")
const credentials = {
  token: "test-token",
  teamId: "team_test",
  projectId: "prj_test",
}
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

const orgId = generateObjectId("org")
const DAY = 24 * 60 * 60_000
const sha = "a".repeat(40)
let agent: SandboxAgent
let repository: string
let agentBin: string

const revision = (workspaceId: string, url: string): WorkspaceRevision => ({
  workspaceId,
  remote: { url, connectionId: null },
  sha,
  generation: 1,
  defaultBranch: "main",
  access: "read",
})

/** A Workspace with a desired revision, and its own sandbox rows. */
async function workspace(repositoryUrl?: string) {
  const id = generateObjectId("ws")
  // One Workspace per repository URL in an org.
  const url = repositoryUrl ?? `https://github.com/acme/${id}.git`
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id,
      orgId,
      slug: id,
      displayName: "Context",
      workspaceRepositoryUrl: url,
      desiredSha: sha,
      desiredDefaultBranch: "main",
    }),
  )
  return { id, revision: revision(id, url) }
}

async function row(values: typeof workspaceSandboxInstances.$inferInsert) {
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaceSandboxInstances).values(values),
  )
}

function snapshotBody(id: string, status: "created" | "deleted" | "failed") {
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

function sandboxBody(name: string) {
  return {
    sandbox: {
      name,
      persistent: true,
      createdAt: 1,
      updatedAt: 1,
      currentSessionId: `sess_${name}`,
      status: "running",
      tags: {},
    },
    session: {
      id: `sess_${name}`,
      memory: 2048,
      vcpus: 1,
      region: "iad1",
      runtime: "node26",
      timeout: 60_000,
      status: "running",
      requestedAt: 1,
      createdAt: 1,
      cwd: "/vercel/sandbox",
      updatedAt: 1,
    },
    routes: [],
  }
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for hosted Workspace bases")
  initDb(process.env.DATABASE_URL)
  vi.stubEnv("VERCEL_TOKEN", credentials.token)
  vi.stubEnv("VERCEL_TEAM_ID", credentials.teamId)
  vi.stubEnv("VERCEL_PROJECT_ID", credentials.projectId)
  vi.stubEnv("SANDBOX_PROVIDER", "vercel")
  agent = { provider: "vercel", image: await sandboxAgentImage("vercel") }
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Hosted base",
    createdAt: new Date(),
  })
  repository = await mkdtemp(join(tmpdir(), "ctxpipe-hosted-base-"))
  // Builder commands run in a local process; the Vercel setup checks for
  // OpenCode, which the agent snapshot provides on Vercel.
  agentBin = await mkdtemp(join(tmpdir(), "ctxpipe-hosted-agent-"))
  await writeFile(join(agentBin, "opencode"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  })
  vi.stubEnv("PATH", `${agentBin}:${process.env.PATH ?? ""}`)
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" })
  git("init", "-b", "main")
  await writeFile(join(repository, "README.md"), "# Hosted base\n")
  git("add", ".")
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Initial",
  )
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
  await rm(repository, { recursive: true, force: true })
  await rm(agentBin, { recursive: true, force: true })
  await closeDb()
})

describe("hosted base choice", () => {
  it("starts without the base and keeps it when Vercel cannot say; uses it when it exists; marks it when it is gone", async () => {
    const ws = await workspace()
    const baseId = `base:${ws.id}:choice`
    await row({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      providerSandboxId: "builder-base",
      latestSnapshotId: "snap_base",
      image: agent.image,
      revision: ws.revision,
      state: "live",
      lastHeartbeatAt: new Date(),
    })
    const choose = () =>
      baseForNewSandbox({
        orgId,
        workspaceId: ws.id,
        agent,
        revision: ws.revision,
      })
    const status = (code: number) =>
      server.use(
        http.get(`${API}/snapshots/snap_base`, () =>
          code === 200
            ? HttpResponse.json(snapshotBody("snap_base", "created"))
            : HttpResponse.json({}, { status: code }),
        ),
      )

    status(503)
    expect(await choose()).toMatchObject({ requestBuild: false })
    expect((await choose()).ref).toBeUndefined()
    expect((await getSandboxInstance(baseId, orgId))?.state).toBe("live")

    status(200)
    expect(await choose()).toMatchObject({
      ref: "snap_base",
      requestBuild: false,
    })

    status(404)
    expect(await choose()).toMatchObject({ requestBuild: true })
    expect((await getSandboxInstance(baseId, orgId))?.state).toBe(
      "destroy_failed",
    )
    // Marked: the next start does not ask Vercel again.
    expect(await choose()).toMatchObject({ requestBuild: true })
  })

  it("a base that cannot start a sandbox is marked failed, and the start goes on from the agent snapshot", async () => {
    const ws = await workspace()
    const baseId = `base:${ws.id}:bad`
    await row({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      providerSandboxId: "builder-bad",
      latestSnapshotId: "snap_bad",
      image: agent.image,
      revision: ws.revision,
      state: "live",
      lastHeartbeatAt: new Date(),
    })
    // The choice reads a good snapshot; the re-check after the failed
    // start finds it gone.
    let reads = 0
    const sources: string[] = []
    const sizes: (number | undefined)[] = []
    server.use(
      http.get(`${API}/snapshots/snap_bad`, () =>
        reads++ === 0
          ? HttpResponse.json(snapshotBody("snap_bad", "created"))
          : HttpResponse.json({}, { status: 404 }),
      ),
      http.post(API, async ({ request }) => {
        const body = (await request.json()) as {
          source?: { snapshotId?: string }
          resources?: { vcpus?: number }
        }
        const source = body.source?.snapshotId ?? ""
        sources.push(source)
        sizes.push(body.resources?.vcpus)
        if (source === "snap_bad")
          return HttpResponse.json(
            { error: { code: "bad_request", message: "snapshot unusable" } },
            { status: 400 },
          )
        return HttpResponse.json(sandboxBody("conversation-1"))
      }),
    )
    const tokens = new Map<string, { token: string; mintedAt: Date }>()
    const provider = vercelConversationProvider({
      credentials,
      agentPassword: "password",
      access: {
        backendHost: "ctxpipe.test",
        mintGitToken: async () => "read-token",
        revokeGitToken: async () => undefined,
        tokens: {
          get: async (id) => tokens.get(id) ?? null,
          put: async (id, token) => {
            tokens.set(id, { token, mintedAt: new Date() })
          },
          take: async () => null,
        },
      },
      tags: { ctxpipe: "workspace-chat", environment: "pr-1" },
      base: () =>
        baseForNewSandbox({
          orgId,
          workspaceId: ws.id,
          agent,
          revision: ws.revision,
        }),
      agentSnapshot: async () => "snap_agent",
    })
    const handle = await provider.create({
      workspace: { source: { type: "none" } },
    } as Parameters<typeof provider.create>[0])
    expect(handle.id).toBe("conversation-1")
    expect(sources).toEqual(["snap_bad", "snap_agent"])
    // Every conversation sandbox gets 1 vCPU (2 GB of memory).
    expect(sizes).toEqual([1, 1])
    expect((await getSandboxInstance(baseId, orgId))?.state).toBe(
      "destroy_failed",
    )
  })

  it.each([
    { answer: 500, snapshot: "created", kept: true },
    { answer: 429, snapshot: "created", kept: true },
    // A client error can be about another option, not the snapshot.
    { answer: 400, snapshot: "created", kept: true },
    { answer: 409, snapshot: "created", kept: true },
    { answer: 500, snapshot: "failed", kept: false },
  ] as const)("a start that fails with $answer keeps the base only while its snapshot is $snapshot", async ({
    answer,
    snapshot,
    kept,
  }) => {
    const ws = await workspace()
    const baseId = `base:${ws.id}:blip`
    await row({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      providerSandboxId: "builder-blip",
      latestSnapshotId: "snap_blip",
      image: agent.image,
      revision: ws.revision,
      state: "live",
      lastHeartbeatAt: new Date(),
    })
    // The choice reads a good snapshot; the re-check after the failed
    // start reads `snapshot`.
    let reads = 0
    const sources: string[] = []
    server.use(
      http.get(`${API}/snapshots/snap_blip`, () =>
        HttpResponse.json(
          snapshotBody("snap_blip", reads++ === 0 ? "created" : snapshot),
        ),
      ),
      http.post(API, async ({ request }) => {
        const body = (await request.json()) as {
          source?: { snapshotId?: string }
        }
        const source = body.source?.snapshotId ?? ""
        sources.push(source)
        if (source === "snap_blip")
          return HttpResponse.json(
            { error: { code: "busy", message: "try again" } },
            { status: answer },
          )
        return HttpResponse.json(sandboxBody("conversation-1"))
      }),
    )
    const provider = vercelConversationProvider({
      credentials,
      agentPassword: "password",
      access: {
        backendHost: "ctxpipe.test",
        mintGitToken: async () => "read-token",
        revokeGitToken: async () => undefined,
        tokens: {
          get: async () => null,
          put: async () => undefined,
          take: async () => null,
        },
      },
      tags: { ctxpipe: "workspace-chat", environment: "pr-1" },
      base: () =>
        baseForNewSandbox({
          orgId,
          workspaceId: ws.id,
          agent,
          revision: ws.revision,
        }),
      agentSnapshot: async () => "snap_agent",
    })
    const handle = await withTestLogger(() =>
      provider.create({
        workspace: { source: { type: "none" } },
      } as Parameters<typeof provider.create>[0]),
    )
    expect(handle.id).toBe("conversation-1")
    // The SDK may retry the failed start before it gives up.
    expect(sources[0]).toBe("snap_blip")
    expect(sources.at(-1)).toBe("snap_agent")
    expect((await getSandboxInstance(baseId, orgId))?.state).toBe(
      kept ? "live" : "destroy_failed",
    )
  })
})

describe("hosted base retention", () => {
  it.each([
    "live",
    "destroy_failed",
  ] as const)("keeps a superseded %s base while a conversation sandbox created before the next base was published exists", async (oldState) => {
    const ws = await workspace()
    const now = Date.now()
    const base = (id: string, publishedAt: number) => ({
      id,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      providerSandboxId: `builder-${id}`,
      latestSnapshotId: `snap-${id}`,
      image: agent.image,
      revision: ws.revision,
      state: "live",
      lastHeartbeatAt: new Date(publishedAt),
      createdAt: new Date(publishedAt),
    })
    const oldId = `base:${ws.id}:old`
    await row({ ...base(oldId, now - 2 * DAY), state: oldState })
    await row(base(`base:${ws.id}:new`, now - 60_000))
    // Started from the old base while the new one was still building: it
    // was created after the new build was reserved, before it published.
    const conversationRow = `chat-${ws.id}`
    await row({
      id: conversationRow,
      kind: "chat",
      orgId,
      workspaceId: ws.id,
      conversationId: generateObjectId("conv"),
      provider: "vercel",
      providerSandboxId: "conversation-old",
      state: "stopped",
      lastHeartbeatAt: new Date(now - 5 * 60_000),
      createdAt: new Date(now - 5 * 60_000),
    })
    const deleted: string[] = []
    server.use(
      http.get(`${API}/snapshots/:id`, ({ params }) =>
        HttpResponse.json(snapshotBody(String(params.id), "created")),
      ),
      http.delete(`${API}/snapshots/:id`, ({ params }) => {
        deleted.push(String(params.id))
        return HttpResponse.json(snapshotBody(String(params.id), "deleted"))
      }),
      http.get(`${API}/snapshots`, () =>
        HttpResponse.json({
          snapshots: [],
          pagination: { count: 0, next: null },
        }),
      ),
      http.get(`${API}/:name`, () => HttpResponse.json({}, { status: 404 })),
    )
    const collect = () =>
      withTestLogger(() =>
        collectUnusedWorkspaceBases({ orgId, workspaceId: ws.id, agent }),
      )

    expect(await collect()).toBe(0)
    expect(await getSandboxInstance(oldId, orgId)).not.toBeNull()

    // That sandbox is gone (deleted 30 days after last use): the old base goes.
    await withOrgDbContext(orgId, (db) =>
      db
        .delete(workspaceSandboxInstances)
        .where(eq(workspaceSandboxInstances.id, conversationRow)),
    )
    expect(await collect()).toBe(1)
    expect(await getSandboxInstance(oldId, orgId)).toBeNull()
    expect(deleted).toEqual([`snap-${oldId}`])
  })
})

describe("Vercel build step", () => {
  /** A builder whose sandbox is a real local process; its capture is a Vercel snapshot id. */
  const localBuilder = (
    capture: () => Promise<string>,
  ): WorkspaceBaseBuilder & { finished: () => number } => {
    let finished = 0
    return {
      cloneToken: "",
      finished: () => finished,
      start: async () => ({
        builderId: "builder-local",
        handle: await localProcessSandbox().create({}),
        capture,
        finish: async () => {
          finished += 1
        },
      }),
    }
  }

  it("reserves one build from a workflow, which has no request org context", async () => {
    const ws = await workspace()
    const reserve = (runId: string) =>
      reserveWorkspaceBaseBuild({ orgId, workspaceId: ws.id, runId, agent })
    const id = await reserve("first")
    expect(id).toBe(`base:${ws.id}:first`)
    // A retry of the same run returns its row; another run waits for the lease.
    expect(await reserve("first")).toBe(id)
    expect(await reserve("second")).toBeNull()
  })

  it("publishes with the builder kept as the snapshot's owner, and a retry returns the published base", async () => {
    const ws = await workspace(repository)
    const baseId = `base:${ws.id}:build`
    await row({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      image: agent.image,
      revision: ws.revision,
      state: "building",
      lastHeartbeatAt: new Date(),
      // Inserted an hour back: the publish must move it.
      createdAt: new Date(Date.now() - 60 * 60_000),
    })
    const builder = localBuilder(async () => "snap_built")
    const reservedAt = Date.now()
    expect(
      await withTestLogger(() =>
        runWorkspaceBaseBuild({ orgId, baseId, builder }),
      ),
    ).toBe("snap_built")
    const published = await getSandboxInstance(baseId, orgId)
    expect(published).toMatchObject({
      state: "live",
      latestSnapshotId: "snap_built",
      providerSandboxId: "builder-local",
    })
    // `created_at` is the publish time.
    expect(published?.createdAt?.getTime()).toBeGreaterThanOrEqual(reservedAt)
    expect(builder.finished()).toBe(1)
    expect(
      await withTestLogger(() =>
        runWorkspaceBaseBuild({ orgId, baseId, builder }),
      ),
    ).toBe("snap_built")
    expect(builder.finished()).toBe(1)
  })

  it("keeps its lease while the clone and setup run past the lease's end", async () => {
    const ws = await workspace(join(repository, ".git"))
    const baseId = `base:${ws.id}:long`
    await row({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      image: agent.image,
      revision: ws.revision,
      state: "building",
      lastHeartbeatAt: new Date(),
    })
    const builder = localBuilder(async () => "snap_long")
    const start = builder.start
    builder.start = async (base) => {
      const build = await start(base)
      const exec = build.handle.process.exec.bind(build.handle.process)
      build.handle.process.exec = async (command, options) => {
        if (command === "git rev-parse HEAD") {
          // The build has run for almost the whole lease; it goes on longer.
          await withOrgDbContext(orgId, (db) =>
            db
              .update(workspaceSandboxInstances)
              .set({
                lastHeartbeatAt: new Date(
                  Date.now() - BASE_BUILD_LEASE_MS + 1_000,
                ),
              })
              .where(eq(workspaceSandboxInstances.id, baseId)),
          )
          await delay(2_500)
        }
        return exec(command, options)
      }
      return build
    }
    expect(
      await withTestLogger(() =>
        runWorkspaceBaseBuild({ orgId, baseId, builder, heartbeatMs: 500 }),
      ),
    ).toBe("snap_long")
    expect(await getSandboxInstance(baseId, orgId)).toMatchObject({
      state: "live",
      latestSnapshotId: "snap_long",
    })
  }, 30_000)

  it("publishes under the Workspace lock, so a sandbox created from the old base meanwhile keeps it", async () => {
    const ws = await workspace(`file://${repository}/.git`)
    const oldId = `base:${ws.id}:before`
    await row({
      id: oldId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      providerSandboxId: "builder-before",
      latestSnapshotId: "snap_before",
      image: agent.image,
      revision: ws.revision,
      state: "live",
      lastHeartbeatAt: new Date(),
      createdAt: new Date(Date.now() - 2 * DAY),
    })
    const baseId = `base:${ws.id}:after`
    await row({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      image: agent.image,
      revision: ws.revision,
      state: "building",
      lastHeartbeatAt: new Date(),
    })
    server.use(
      http.get(`${API}/snapshots/:id`, ({ params }) =>
        HttpResponse.json(snapshotBody(String(params.id), "created")),
      ),
      http.delete(`${API}/snapshots/:id`, ({ params }) =>
        HttpResponse.json(snapshotBody(String(params.id), "deleted")),
      ),
      http.get(`${API}/snapshots`, () =>
        HttpResponse.json({
          snapshots: [],
          pagination: { count: 0, next: null },
        }),
      ),
      http.get(`${API}/:name`, () => HttpResponse.json({}, { status: 404 })),
    )
    let captured: () => void = () => undefined
    const capturing = new Promise<void>((resolve) => {
      captured = resolve
    })
    const builder = localBuilder(async () => {
      captured()
      return "snap_after"
    })
    let build: Promise<string | null> | undefined
    // A create: it picks the old base and records its sandbox under the
    // Workspace lock, while the build reaches its publish.
    await postgresSandboxLocks(orgId).withLock(
      `workspace-sandboxes:${ws.id}`,
      async () => {
        build = withTestLogger(() =>
          runWorkspaceBaseBuild({ orgId, baseId, builder }),
        )
        await capturing
        await delay(1_000)
        await row({
          id: `chat-${ws.id}`,
          kind: "chat",
          orgId,
          workspaceId: ws.id,
          conversationId: generateObjectId("conv"),
          provider: "vercel",
          providerSandboxId: "conversation-meanwhile",
          state: "live",
          lastHeartbeatAt: new Date(),
        })
      },
    )
    expect(await build).toBe("snap_after")
    expect(
      await withTestLogger(() =>
        collectUnusedWorkspaceBases({ orgId, workspaceId: ws.id, agent }),
      ),
    ).toBe(0)
    expect(await getSandboxInstance(oldId, orgId)).not.toBeNull()
  }, 30_000)

  it("a failed build deletes its Vercel builder (not left running), revokes through finish, and ends its lease at once", async () => {
    const ws = await workspace(`file://${repository}`)
    const baseId = `base:${ws.id}:fail`
    await row({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      image: agent.image,
      revision: ws.revision,
      state: "building",
      lastHeartbeatAt: new Date(),
    })
    const requests: string[] = []
    server.use(
      http.get(`${API}/snapshots`, ({ request }) => {
        requests.push(`list ${new URL(request.url).searchParams.get("name")}`)
        return HttpResponse.json({
          snapshots: [],
          pagination: { count: 0, next: null },
        })
      }),
      http.get(`${API}/:name`, ({ params }) => {
        requests.push(`get ${params.name}`)
        return HttpResponse.json(sandboxBody(String(params.name)))
      }),
      http.delete(`${API}/:name`, ({ params }) => {
        requests.push(`delete ${params.name}`)
        return HttpResponse.json(sandboxBody(String(params.name)))
      }),
    )
    const builder = localBuilder(() =>
      Promise.reject(new Error("snapshot failed")),
    )
    await expect(
      withTestLogger(() => runWorkspaceBaseBuild({ orgId, baseId, builder })),
    ).rejects.toThrow("snapshot failed")
    expect(requests).toContain("delete builder-local")
    expect(builder.finished()).toBe(1)
    // No lease and no slot: a new build reserves at once, and this one does
    // not run again.
    expect((await getSandboxInstance(baseId, orgId))?.state).toBe(
      "destroy_failed",
    )
    expect(
      await reserveWorkspaceBaseBuild({
        orgId,
        workspaceId: ws.id,
        runId: "next",
        agent,
      }),
    ).toBe(`base:${ws.id}:next`)
  })

  it("runs with the production Vercel builder: GitHub-only egress, the builder kept as the snapshot's owner, preview expiry, the token revoked", async () => {
    // The production builder, wired through hostedSandboxAccess; Vercel and
    // GitHub are msw. Only the builder's commands run in a local process,
    // because Vercel streams command output over its own protocol. The
    // hosted lane (vercel-sandbox.contract.test.ts) runs the same clone and
    // setup, and the no-token scan, in a real Vercel builder.
    const environment = `pr-${Date.now()}`
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", environment)
    vi.stubEnv("AUTH_BASE_URL", "https://backend.ctxpipe.test")
    vi.stubEnv("GITHUB_APP_ID", "12345")
    vi.stubEnv(
      "GITHUB_PRIVATE_KEY",
      generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
    )
    const remote = `https://github.com/acme/hosted-base-${Date.now()}.git`
    // The clone of the GitHub URL reads the local fixture repository.
    vi.stubEnv("GIT_CONFIG_COUNT", "1")
    vi.stubEnv("GIT_CONFIG_KEY_0", `url.file://${repository}.insteadOf`)
    vi.stubEnv("GIT_CONFIG_VALUE_0", remote)
    const connectionId = generateObjectId("con")
    await withOrgDbContext(orgId, (db) =>
      db.insert(connections).values({
        id: connectionId,
        orgId,
        type: "github",
        config: {
          installationId: 4242,
          accountSlug: "acme",
          ingestAllRepositories: false,
          includeFutureRepos: false,
        },
      }),
    )
    const ws = await workspace(remote)
    const baseId = `base:${ws.id}:vercel`
    await row({
      id: baseId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      image: agent.image,
      revision: {
        ...ws.revision,
        remote: { url: remote, connectionId },
      },
      state: "building",
      lastHeartbeatAt: new Date(),
    })
    const minted: string[] = []
    const revoked: string[] = []
    const created: Array<Record<string, unknown>> = []
    const snapshots: Array<Record<string, unknown>> = []
    server.use(
      http.post(
        "https://api.github.com/app/installations/4242/access_tokens",
        () => {
          minted.push(`ghs_base_${minted.length + 1}`)
          return HttpResponse.json(
            {
              token: minted.at(-1),
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              permissions: { contents: "read", metadata: "read" },
            },
            { status: 201 },
          )
        },
      ),
      http.delete(
        "https://api.github.com/installation/token",
        ({ request }) => {
          revoked.push(
            (request.headers.get("authorization") ?? "").replace(/^\S+ /, ""),
          )
          return new HttpResponse(null, { status: 204 })
        },
      ),
      // The agent snapshot, found through its tagged builder.
      http.get(API, () =>
        HttpResponse.json({
          sandboxes: [
            {
              ...sandboxBody("agent-builder").sandbox,
              status: "stopped",
              tags: {
                ctxpipe: "workspace-agent",
                environment,
                opencode: agentTag,
              },
            },
          ],
          pagination: { count: 1, next: null },
        }),
      ),
      http.get(`${API}/snapshots`, () =>
        HttpResponse.json({
          snapshots: [snapshotBody("snap_agent", "created").snapshot],
          pagination: { count: 1, next: null },
        }),
      ),
      http.post(API, async ({ request }) => {
        created.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(sandboxBody("base-builder"))
      }),
      http.post(`${API}/sessions/:session/snapshot`, async ({ request }) => {
        snapshots.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({
          snapshot: snapshotBody("snap_vercel_base", "created").snapshot,
          session: sandboxBody("base-builder").session,
        })
      }),
    )
    const production = await workspaceBaseBuilder({
      provider: "vercel",
      orgId,
      revision: { ...ws.revision, remote: { url: remote, connectionId } },
    })
    const builder: WorkspaceBaseBuilder = {
      ...production,
      start: async (base) => ({
        ...(await production.start(base)),
        handle: await localProcessSandbox().create({}),
      }),
    }
    // No org context: the build step runs in a workflow.
    expect(
      await withTestLogger(() =>
        runWorkspaceBaseBuild({ orgId, baseId, builder }),
      ),
    ).toBe("snap_vercel_base")
    expect(await getSandboxInstance(baseId, orgId)).toMatchObject({
      state: "live",
      latestSnapshotId: "snap_vercel_base",
      providerSandboxId: "base-builder",
    })
    expect(created).toHaveLength(1)
    const [create] = created
    expect(create?.source).toEqual({
      type: "snapshot",
      snapshotId: "snap_agent",
    })
    expect(create?.tags).toMatchObject({
      ctxpipe: "workspace-base",
      environment,
    })
    expect(create?.resources).toMatchObject({ vcpus: 1 })
    // GitHub only: the backend is not reachable from a builder.
    const egress = JSON.stringify(create?.networkPolicy)
    expect(egress).toContain("api.github.com")
    expect(egress).not.toContain("backend.ctxpipe.test")
    expect(snapshots).toEqual([{ expiration: 30 * DAY }])
    expect(minted).toHaveLength(1)
    expect(revoked).toEqual(minted)
    await withOrgDbContext(orgId, (db) =>
      db.delete(connections).where(eq(connections.id, connectionId)),
    )
  })

  it("a preview's builder snapshots expire after 30 days; production ones never do", () => {
    expect(builderSnapshotExpiration("pr-12")).toBe(30 * DAY)
    expect(builderSnapshotExpiration("production")).toBe(0)
  })
})

describe("hosted failed build", () => {
  it("deletes a failed build that has no snapshot, though a conversation sandbox exists", async () => {
    const ws = await workspace()
    const now = Date.now()
    const failedId = `base:${ws.id}:unbuilt`
    await row({
      id: failedId,
      kind: "base",
      orgId,
      workspaceId: ws.id,
      provider: "vercel",
      providerSandboxId: null,
      latestSnapshotId: null,
      image: agent.image,
      revision: ws.revision,
      state: "destroy_failed",
      lastHeartbeatAt: new Date(now - 60_000),
      createdAt: new Date(now - 60_000),
    })
    await row({
      id: `chat-${ws.id}`,
      kind: "chat",
      orgId,
      workspaceId: ws.id,
      conversationId: generateObjectId("conv"),
      provider: "vercel",
      providerSandboxId: "conversation-unbuilt",
      state: "stopped",
      lastHeartbeatAt: new Date(now - 5 * 60_000),
      createdAt: new Date(now - 5 * 60_000),
    })
    server.use(
      http.get(`${API}/snapshots`, () =>
        HttpResponse.json({
          snapshots: [],
          pagination: { count: 0, next: null },
        }),
      ),
      http.get(`${API}/:name`, () => HttpResponse.json({}, { status: 404 })),
    )
    expect(
      await withTestLogger(() =>
        collectUnusedWorkspaceBases({ orgId, workspaceId: ws.id, agent }),
      ),
    ).toBe(1)
    expect(await getSandboxInstance(failedId, orgId)).toBeNull()
  })
})

describe("base sweep schedule", () => {
  /** An org of its own: the sweep reads every sandbox row of the org. */
  async function withSweptOrg(
    test: (org: {
      workspaceId: string
      row: (
        id: string,
        values: Partial<typeof workspaceSandboxInstances.$inferInsert>,
      ) => Promise<unknown>
      sweep: (now: Date) => Promise<number | undefined>
      conversation: () => Promise<string>
    }) => Promise<void>,
  ) {
    const sweptOrg = generateObjectId("org")
    await getSystemDb().insert(organizations).values({
      id: sweptOrg,
      slug: sweptOrg,
      name: "Base sweep schedule",
      createdAt: new Date(),
    })
    const workspaceId = generateObjectId("ws")
    const url = `https://github.com/acme/${workspaceId}.git`
    try {
      await withOrgDbContext(sweptOrg, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId: sweptOrg,
          slug: workspaceId,
          displayName: "Context",
          workspaceRepositoryUrl: url,
          desiredSha: sha,
          desiredDefaultBranch: "main",
        }),
      )
      await test({
        workspaceId,
        row: (id, values) =>
          withOrgDbContext(sweptOrg, (db) =>
            db.insert(workspaceSandboxInstances).values({
              id,
              kind: "base",
              orgId: sweptOrg,
              workspaceId,
              provider: "vercel",
              image: agent.image,
              revision: revision(workspaceId, url),
              state: "live",
              lastHeartbeatAt: new Date(),
              ...values,
            }),
          ),
        sweep: async (now) =>
          (
            await withTestLogger(() =>
              sweepConversationSandboxes(sweptOrg, now),
            )
          ).nextSweepAt?.getTime(),
        conversation: async () => {
          const id = generateObjectId("conv")
          await withOrgDbContext(sweptOrg, (db) =>
            db
              .insert(conversations)
              .values({ id, orgId: sweptOrg, workspaceId }),
          )
          return id
        },
      })
    } finally {
      await withOrgDbContext(sweptOrg, async (db) => {
        await db
          .delete(workspaceSandboxInstances)
          .where(eq(workspaceSandboxInstances.orgId, sweptOrg))
        await db.delete(conversations).where(eq(conversations.orgId, sweptOrg))
        await db.delete(workspaces).where(eq(workspaces.orgId, sweptOrg))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, sweptOrg))
    }
  }

  it("schedules the org's next sweep for its bases: a current base at its retention end, a build at its lease end, a failed delete at the next retry", async () => {
    server.use(
      http.get(`${API}/snapshots/:id`, ({ params }) =>
        HttpResponse.json(snapshotBody(String(params.id), "created")),
      ),
      http.all(`${API}*`, () => HttpResponse.json({}, { status: 500 })),
    )
    await withSweptOrg(async ({ workspaceId, row, sweep }) => {
      const now = new Date()
      const lastStart = now.getTime() - DAY
      await row(`base:${workspaceId}:current`, {
        providerSandboxId: "builder-current",
        latestSnapshotId: "snap_current",
        lastHeartbeatAt: new Date(lastStart),
      })
      expect(await sweep(now)).toBe(lastStart + CHAT_SANDBOX_RETENTION_MS)

      const renewed = now.getTime() - 10 * 60_000
      await row(`base:${workspaceId}:building`, {
        state: "building",
        lastHeartbeatAt: new Date(renewed),
      })
      expect(await sweep(now)).toBe(renewed + BASE_BUILD_LEASE_MS)

      // Its delete fails (Vercel answers 500): the sweep tries again.
      await row(`base:${workspaceId}:failed`, {
        state: "destroy_failed",
        providerSandboxId: "builder-failed",
      })
      const retry = (await sweep(now)) ?? 0
      expect(retry).toBeGreaterThan(now.getTime())
      expect(retry).toBeLessThanOrEqual(now.getTime() + 5 * 60_000)
    })
  })

  it("schedules a kept base at its conversation sandbox's expiry, and never in the past", async () => {
    server.use(
      http.get(`${API}/snapshots/:id`, ({ params }) =>
        HttpResponse.json(snapshotBody(String(params.id), "created")),
      ),
    )
    await withSweptOrg(async ({ workspaceId, row, sweep, conversation }) => {
      const now = new Date()
      const used = now.getTime() - 2 * DAY
      // A conversation sandbox that started from the old bases before the
      // current base was published: Vercel keeps those bases for it.
      await row(`chat-${workspaceId}`, {
        kind: "chat",
        conversationId: await conversation(),
        image: null,
        revision: null,
        providerSandboxId: "conversation-held",
        state: "stopped",
        lastHeartbeatAt: new Date(used),
        createdAt: new Date(now.getTime() - 40 * DAY),
      })
      await row(`base:${workspaceId}:current`, {
        providerSandboxId: "builder-current",
        latestSnapshotId: "snap_current",
        createdAt: new Date(now.getTime() - DAY),
      })
      await row(`base:${workspaceId}:failed`, {
        state: "destroy_failed",
        providerSandboxId: "builder-failed",
        latestSnapshotId: "snap_failed",
        lastHeartbeatAt: new Date(now.getTime() - 3 * DAY),
        createdAt: new Date(now.getTime() - 45 * DAY),
      })
      // The failed base waits for that sandbox's expiry, not the next retry.
      // The sandbox's own deletion (a day before its expiry) comes first, so
      // the next sweep is due then.
      expect(await sweep(now)).toBe(used + CHAT_SANDBOX_DELETE_AFTER_MS)

      // A superseded base past its retention end, still in use, also waits
      // for that sandbox's expiry.
      await row(`base:${workspaceId}:old`, {
        providerSandboxId: "builder-old",
        latestSnapshotId: "snap_old",
        lastHeartbeatAt: new Date(now.getTime() - 31 * DAY),
        createdAt: new Date(now.getTime() - 50 * DAY),
      })
      expect(await sweep(now)).toBe(used + CHAT_SANDBOX_DELETE_AFTER_MS)

      // A build whose lease lapsed, while cleanup is skipped (the agent
      // image is unreadable), is due in the past: the sweep schedules the
      // next retry instead.
      await row(`base:${workspaceId}:lapsed`, {
        state: "building",
        latestSnapshotId: null,
        lastHeartbeatAt: new Date(now.getTime() - 2 * BASE_BUILD_LEASE_MS),
      })
      const dockerHost = process.env.DOCKER_HOST
      vi.stubEnv("SANDBOX_PROVIDER", "docker")
      vi.stubEnv("DOCKER_HOST", "tcp://127.0.0.1:1")
      const next = await sweep(now).finally(() => {
        vi.stubEnv("SANDBOX_PROVIDER", "vercel")
        vi.stubEnv("DOCKER_HOST", dockerHost)
      })
      expect(next ?? 0).toBeGreaterThan(now.getTime())
      expect(next).toBeLessThanOrEqual(now.getTime() + 5 * 60_000)
    })
  })
})

describe("agent snapshot lookup", () => {
  const environment = `pr-${Date.now()}`

  it("builds on node26 at 1 vCPU, and does not reuse an agent snapshot built on another runtime", async () => {
    const created: Record<string, unknown>[] = []
    server.use(
      http.get(API, () =>
        HttpResponse.json({
          sandboxes: [
            {
              ...sandboxBody("node24-agent-builder").sandbox,
              status: "stopped",
              // The identity before the runtime was part of it.
              tags: {
                ctxpipe: "workspace-agent",
                environment: `${environment}-runtime`,
                opencode: WORKSPACE_CHAT_OPENCODE_CLI.replace(/[^\w.-]/g, "-"),
              },
            },
          ],
          pagination: { count: 1, next: null },
        }),
      ),
      http.get(`${API}/snapshots`, () =>
        HttpResponse.json({
          snapshots: [snapshotBody("snap_node24_agent", "created").snapshot],
          pagination: { count: 1, next: null },
        }),
      ),
      http.post(API, async ({ request }) => {
        created.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(
          { error: { code: "bad_request", message: "stop here" } },
          { status: 400 },
        )
      }),
    )
    await expect(
      vercelAgentSnapshot({
        credentials,
        environment: `${environment}-runtime`,
      }),
    ).rejects.toThrow()
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      runtime: "node26",
      resources: { vcpus: 1 },
      tags: { opencode: agentTag },
    })
    // Workspace bases are keyed by the same runtime, so they rebuild once.
    expect(agent.image).toBe(`vercel-agent/node26/${WORKSPACE_CHAT_OPENCODE_CLI}`)
  })

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
              ...sandboxBody("agent-builder").sandbox,
              status: "stopped",
              tags: {
                ctxpipe: "workspace-agent",
                environment,
                opencode: agentTag,
              },
            },
          ],
          pagination: { count: 1, next: null },
        })
      }),
      http.get(`${API}/snapshots`, () =>
        HttpResponse.json({
          snapshots: [snapshotBody("snap_agent", "created").snapshot],
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
