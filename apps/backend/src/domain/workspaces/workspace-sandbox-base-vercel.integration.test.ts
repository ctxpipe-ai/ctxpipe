import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
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
import type { WorkspaceRevision } from "./revision.js"
import { CHAT_SANDBOX_RETENTION_MS } from "./chat-lifecycle.js"
import { sweepConversationSandboxes } from "./conversation-sandbox-lifecycle.js"
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

function snapshotBody(id: string, status: "created" | "deleted") {
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
      runtime: "node24",
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
    const sources: string[] = []
    server.use(
      http.get(`${API}/snapshots/snap_bad`, () =>
        HttpResponse.json(snapshotBody("snap_bad", "created")),
      ),
      http.post(API, async ({ request }) => {
        const body = (await request.json()) as {
          source?: { snapshotId?: string }
        }
        const source = body.source?.snapshotId ?? ""
        sources.push(source)
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
    expect((await getSandboxInstance(baseId, orgId))?.state).toBe(
      "destroy_failed",
    )
  })
})

describe("hosted base retention", () => {
  it("keeps a superseded base while a conversation sandbox created before the next base was published exists", async () => {
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
    await row(base(oldId, now - 2 * DAY))
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

  it("a failed attempt deletes its Vercel builder (not left running) and revokes through finish", async () => {
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
  })

  it("runs with the production Vercel builder: GitHub-only egress, the builder kept as the snapshot's owner, preview expiry, the token revoked", async () => {
    // The production builder, wired through hostedSandboxAccess; Vercel and
    // GitHub are msw. Only the builder's commands run in a local process,
    // because Vercel streams command output over its own protocol.
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
                opencode: WORKSPACE_CHAT_OPENCODE_CLI.replace(/[^\w.-]/g, "-"),
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

  it("a workflow whose every build attempt fails releases its lease, so the next build may start", async () => {
    const ws = await workspace()
    // Vercel refuses everything, so each attempt of the build step fails.
    server.use(
      http.all(`${API}*`, () => HttpResponse.json({}, { status: 500 })),
    )
    const { workspaceSandboxBase } = await import(
      "../../openworkflow/workflows/workspace-sandbox-base.js"
    )
    const { closeOpenWorkflowClient } = await import(
      "../../openworkflow/client.js"
    )
    const namespaceId = `base-release-${ws.id}`
    const backend = await BackendPostgres.connect(
      process.env.DATABASE_URL ?? "",
      { runMigrations: false, namespaceId },
    )
    const runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(workspaceSandboxBase.spec, workspaceSandboxBase.fn)
    const worker = runner.newWorker({ concurrency: 1 })
    try {
      await worker.start()
      const handle = await runner.runWorkflow(workspaceSandboxBase.spec, {
        orgId,
        workspaceId: ws.id,
      })
      await expect(
        withTestLogger(() => handle.result({ timeoutMs: 60_000 })),
      ).rejects.toThrow()
      const baseId = `base:${ws.id}:${handle.workflowRun.id}`
      expect((await getSandboxInstance(baseId, orgId))?.state).toBe(
        "destroy_failed",
      )
      // The released row holds no lease: a new build reserves at once.
      expect(
        await reserveWorkspaceBaseBuild({
          orgId,
          workspaceId: ws.id,
          runId: "next",
          agent,
        }),
      ).toBe(`base:${ws.id}:next`)
    } finally {
      await worker.stop()
      await backend.stop()
      await closeOpenWorkflowClient()
      await getSystemDb().execute(
        sql`delete from openworkflow.workflow_runs where namespace_id = ${namespaceId}`,
      )
    }
  }, 90_000)
})

describe("base sweep schedule", () => {
  it("schedules the org's next sweep for its bases: a current base at its retention end, a build at its lease end, a failed delete at the next retry", async () => {
    // An org of its own: the sweep reads every base of the org.
    const sweptOrg = generateObjectId("org")
    await getSystemDb().insert(organizations).values({
      id: sweptOrg,
      slug: sweptOrg,
      name: "Base sweep schedule",
      createdAt: new Date(),
    })
    const workspaceId = generateObjectId("ws")
    const url = `https://github.com/acme/${workspaceId}.git`
    const base = (
      id: string,
      values: Partial<typeof workspaceSandboxInstances.$inferInsert>,
    ) =>
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
      )
    server.use(
      http.get(`${API}/snapshots/:id`, ({ params }) =>
        HttpResponse.json(snapshotBody(String(params.id), "created")),
      ),
      http.all(`${API}*`, () => HttpResponse.json({}, { status: 500 })),
    )
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
      const now = new Date()
      const lastStart = now.getTime() - DAY
      await base(`base:${workspaceId}:current`, {
        providerSandboxId: "builder-current",
        latestSnapshotId: "snap_current",
        lastHeartbeatAt: new Date(lastStart),
      })
      const sweep = () =>
        withTestLogger(() => sweepConversationSandboxes(sweptOrg, now))
      expect((await sweep()).nextSweepAt?.getTime()).toBe(
        lastStart + CHAT_SANDBOX_RETENTION_MS,
      )

      const renewed = now.getTime() - 10 * 60_000
      await base(`base:${workspaceId}:building`, {
        state: "building",
        lastHeartbeatAt: new Date(renewed),
      })
      expect((await sweep()).nextSweepAt?.getTime()).toBe(
        renewed + BASE_BUILD_LEASE_MS,
      )

      // Its delete fails (Vercel answers 500): the sweep tries again.
      await base(`base:${workspaceId}:failed`, {
        state: "destroy_failed",
        providerSandboxId: "builder-failed",
      })
      const retry = (await sweep()).nextSweepAt?.getTime() ?? 0
      expect(retry).toBeGreaterThan(now.getTime())
      expect(retry).toBeLessThanOrEqual(now.getTime() + 5 * 60_000)
    } finally {
      await withOrgDbContext(sweptOrg, async (db) => {
        await db
          .delete(workspaceSandboxInstances)
          .where(eq(workspaceSandboxInstances.orgId, sweptOrg))
        await db.delete(workspaces).where(eq(workspaces.orgId, sweptOrg))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, sweptOrg))
    }
  })
})

describe("agent snapshot lookup", () => {
  const environment = `pr-${Date.now()}`

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
                opencode: WORKSPACE_CHAT_OPENCODE_CLI.replace(/[^\w.-]/g, "-"),
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
