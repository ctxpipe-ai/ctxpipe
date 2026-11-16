import { execFile, execFileSync } from "node:child_process"
import { generateKeyPairSync, randomInt } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

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
import {
  connectionDirectory,
  connections,
} from "../../db/schema/connections.js"
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
import { RUNTIME_ARN } from "../../test/agentcore-fake.js"
import { sweepConversationSandboxes } from "./conversation-sandbox-lifecycle.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"

const API = "https://vercel.com/api/v2/sandboxes"
const TOKEN = "test-vercel-token"

/**
 * A Vercel project that holds sandboxes and their snapshots, and applies
 * deletes. `failDelete` answers 503 to the delete of those sandboxes, and
 * `failList` answers 404 to the snapshot list of those sandboxes. With
 * `workdirs`, a command in one of those sandboxes runs with `sh` in its
 * local folder; every other request (for example a command in another
 * sandbox) gets a 503.
 */
function vercelProject(input: {
  sandboxes: string[]
  snapshots: Record<string, string>
  failDelete?: Set<string>
  failList?: Set<string>
  workdirs?: Record<string, string>
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
    // The session id is `sess_<sandbox name>` (sandboxBody).
    http.post(`${API}/sessions/:session/cmd`, async ({ params, request }) => {
      const workdir = input.workdirs?.[String(params.session).slice(5)]
      if (!workdir) return HttpResponse.json({}, { status: 503 })
      const body = (await request.json()) as {
        command: string
        args: string[]
        env: Record<string, string>
      }
      const run = await promisify(execFile)(body.command, body.args, {
        cwd: workdir,
        env: { PATH: process.env.PATH, HOME: workdir, ...body.env },
        encoding: "latin1",
        maxBuffer: 64 * 1024 * 1024,
      }).then(
        (done) => ({ ...done, exitCode: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => ({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.code,
        }),
      )
      const command = {
        id: "cmd_test",
        name: body.command,
        args: body.args,
        cwd: "/vercel/sandbox",
        sessionId: String(params.session),
        startedAt: 1,
      }
      return new HttpResponse(
        [
          { command: { ...command, exitCode: null } },
          { stream: "stdout", data: run.stdout },
          { stream: "stderr", data: run.stderr },
          { command: { ...command, exitCode: run.exitCode } },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        { headers: { "content-type": "application/x-ndjson" } },
      )
    }),
    http.get(`${API}/snapshots`, ({ request }) => {
      const name = new URL(request.url).searchParams.get("name")
      if (name && input.failList?.has(name))
        return HttpResponse.json({}, { status: 404 })
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
      if (input.failDelete?.has(name))
        return HttpResponse.json(
          { error: { message: `unavailable ${name}` } },
          { status: 503 },
        )
      if (!sandboxes.delete(name)) return HttpResponse.json({}, { status: 404 })
      return HttpResponse.json({ sandbox: sandboxBody(name) })
    }),
    http.all(`${API}/*`, () => HttpResponse.json({}, { status: 503 })),
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

/** A GitHub Workspace whose remote is a local bare repository. */
const github = {
  connectionId: generateObjectId("con"),
  workspaceId: generateObjectId("ws"),
  installationId: randomInt(100_000_000, 999_999_999),
  url: "https://github.com/fixture/retired-sandbox.git",
  directory: mkdtempSync(join(tmpdir(), "ctxpipe-retired-sandbox-")),
  sha: "",
}
const remote = join(github.directory, "remote.git")
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const BUCKET = "retired-test-bucket"

/** A GitHub App that grants every token the fixture asks for. */
const githubApp = [
  http.post(
    `https://api.github.com/app/installations/${github.installationId}/access_tokens`,
    async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as {
        permissions?: { contents?: string }
      }
      return HttpResponse.json(
        {
          token: "fixture-only-github-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: {
            contents: body.permissions?.contents ?? "read",
            metadata: "read",
          },
        },
        { status: 201 },
      )
    },
  ),
  http.get("https://api.github.com/repos/fixture/:repo", ({ params }) =>
    HttpResponse.json({
      id: 700_001,
      full_name: `fixture/${String(params.repo)}`,
      default_branch: "main",
      permissions: { push: true },
    }),
  ),
  http.delete(
    "https://api.github.com/installation/token",
    () => new HttpResponse(null, { status: 204 }),
  ),
]

/**
 * S3 that keeps each object it gets by URL, or answers 403 to each write
 * while `refuse` is true.
 */
function s3Bucket() {
  const objects = new Map<string, Buffer>()
  const bucket = { objects, refuse: false }
  const handler = http.put(
    /^https:\/\/[^/]+\.amazonaws\.com\//,
    async ({ request }) => {
      if (bucket.refuse)
        return new HttpResponse(
          "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
          { status: 403, headers: { "content-type": "application/xml" } },
        )
      const url = new URL(request.url)
      objects.set(
        `${url.host}${url.pathname}`,
        Buffer.from(await request.arrayBuffer()),
      )
      return new HttpResponse(null, { status: 200, headers: { ETag: '"1"' } })
    },
  )
  return { bucket, handler }
}

/**
 * A sandbox folder: a clone of the Workspace with a commit on main that
 * adds `generated_by` front matter, which only ctxpipe may write.
 */
function refusedSandbox(): string {
  const workdir = mkdtempSync(join(github.directory, "sandbox-"))
  git(workdir, "clone", "-q", remote, ".")
  writeFileSync(
    join(workdir, "notes.md"),
    "---\ngenerated_by: agent\n---\n# Notes\n",
  )
  git(workdir, "add", "notes.md")
  git(
    workdir,
    "-c",
    "user.name=Agent",
    "-c",
    "user.email=agent@example.test",
    "commit",
    "-q",
    "-m",
    "Add notes",
  )
  return workdir
}

/** A conversation of the GitHub Workspace and its Vercel sandbox row. */
async function refusedChatRow(
  sandbox: string,
  lastHeartbeatAt = new Date(),
): Promise<SandboxInstanceRecord> {
  const conversation = generateObjectId("conv")
  await withOrgDbContext(orgId, (db) =>
    db.insert(conversations).values({
      id: conversation,
      orgId,
      name: "Refused thread",
      workspaceId: github.workspaceId,
    }),
  )
  return row({
    kind: "chat",
    provider: "vercel",
    workspaceId: github.workspaceId,
    conversationId: conversation,
    providerSandboxId: sandbox,
    lastHeartbeatAt,
    revision: {
      workspaceId: github.workspaceId,
      remote: { url: github.url, connectionId: github.connectionId },
      sha: github.sha,
      generation: 1,
      defaultBranch: "main",
      access: "read",
    },
  })
}

/** The retirement's own log events. */
const events: Record<string, unknown>[] = []

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the sandbox sweep")
  initDb(url)
  initLogger({
    env: { service: "ctxpipe-backend-test" },
    pretty: false,
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
  git(github.directory, "init", "-q", "-b", "main", "seed")
  const seed = join(github.directory, "seed")
  writeFileSync(join(seed, "README.md"), "# Context\n")
  git(seed, "add", "README.md")
  git(
    seed,
    "-c",
    "user.name=Person",
    "-c",
    "user.email=person@example.test",
    "commit",
    "-q",
    "-m",
    "Start",
  )
  github.sha = git(seed, "rev-parse", "HEAD")
  git(github.directory, "clone", "-q", "--bare", seed, remote)
  writeFileSync(
    join(github.directory, "gitconfig"),
    `[url "${remote}"]\n\tinsteadOf = ${github.url}\n`,
  )
  await withOrgDbContext(orgId, async (db) => {
    await db.insert(connections).values({
      id: github.connectionId,
      orgId,
      type: "github",
      config: {
        installationId: github.installationId,
        ingestAllRepositories: false,
        includeFutureRepos: false,
      },
    })
    await db.insert(workspaces).values({
      id: github.workspaceId,
      orgId,
      slug: "github-context",
      displayName: "GitHub context",
      workspaceRepositoryUrl: github.url,
      githubConnectionId: github.connectionId,
      desiredSha: github.sha,
      desiredGeneration: 1,
      desiredDefaultBranch: "main",
      indexedSha: github.sha,
      writeStatus: "writable",
    })
  })
})

beforeEach(() => {
  // The AgentCore deployment of production; no AgentCore call is made.
  vi.stubEnv("AGENTCORE_RUNTIME_ARN", RUNTIME_ARN)
  vi.stubEnv("VERCEL_TOKEN", TOKEN)
  vi.stubEnv("VERCEL_TEAM_ID", "team_test")
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_test")
  vi.stubEnv("RETIRED_SANDBOX_STORE", `s3://${BUCKET}/retired-sandboxes`)
  vi.stubEnv("AWS_REGION", "us-west-2")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-only-access-key")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-only-secret-key")
  vi.stubEnv("AWS_PROFILE", undefined)
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(github.directory, "gitconfig"))
  vi.stubEnv("GITHUB_APP_ID", "12345")
  vi.stubEnv("GITHUB_PRIVATE_KEY", GITHUB_PRIVATE_KEY)
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
    await db.delete(connections).where(eq(connections.orgId, orgId))
  })
  await getSystemDb()
    .delete(connectionDirectory)
    .where(eq(connectionDirectory.orgId, orgId))
  rmSync(github.directory, { recursive: true, force: true })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
})

const GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey

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
    // Past its retention and with no conversation: the regular sweep would
    // delete it too, and it must not.
    const failing = row({
      kind: "chat",
      provider: "vercel",
      conversationId: generateObjectId("conv"),
      providerSandboxId: name("chat-fail"),
      lastHeartbeatAt: new Date(Date.now() - 40 * 24 * 60 * 60_000),
    })
    const base = row({
      kind: "base",
      provider: "vercel",
      providerSandboxId: name("base"),
      latestSnapshotId: `snap_base_${orgId}`,
      state: "live",
    })
    // A base whose builder is gone and whose snapshot Vercel no longer has.
    const baseGone = row({
      kind: "base",
      provider: "vercel",
      latestSnapshotId: `snap_gone_${orgId}`,
      state: "live",
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
      base,
      baseGone,
      // Not Vercel: the retirement never touches it.
      docker,
    ])
      await persistSandboxInstance(record)

    const now = new Date()
    const first = await sweepConversationSandboxes(orgId, now)
    // The failed conversation sandbox keeps the base it can have started
    // from, with its builder and snapshots.
    expect([...project.sandboxes].sort()).toEqual(
      [name("base"), name("chat-fail")].sort(),
    )
    expect([...project.snapshots.keys()].sort()).toEqual(
      [`snap_base_${orgId}`, `snap_builder_${orgId}`].sort(),
    )
    // The regular sweep skipped the failed row: it is not `destroy_failed`.
    const states = Object.fromEntries(
      (await vercelRows()).map((item) => [item.id, item.state]),
    )
    expect(states).toEqual({
      [failing.id]: "stopped",
      [base.id]: "live",
      [baseGone.id]: "live",
    })
    // The failed row brings the next sweep to the retry, not to the docker
    // base's retention end.
    expect(first.nextSweepAt?.getTime()).toBeLessThanOrEqual(
      now.getTime() + 5 * 60_000,
    )

    project.sandboxes.delete(name("chat-fail"))
    const second = await sweepConversationSandboxes(orgId, new Date())
    expect(await vercelRows()).toEqual([])
    expect(project.sandboxes.size).toBe(0)
    expect(project.snapshots.size).toBe(0)
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

    // Counts and status codes only.
    expect(events.map((event) => event.message)).toEqual([
      "Retiring a Vercel sandbox failed (kind chat)",
      "Retired 4 Vercel sandboxes (0 saved as Git bundles); 2 kept, 1 failed",
      "Retired 3 Vercel sandboxes (0 saved as Git bundles); 0 kept, 0 failed",
    ])
    expect(events[0]).toMatchObject({ kind: "chat", status: 503 })
  })

  it("keeps a row when the snapshot list of its sandbox fails, also with a 404", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
    const project = vercelProject({
      sandboxes: [name("listed")],
      snapshots: { [`snap_listed_${orgId}`]: name("listed") },
      failList: new Set([name("listed")]),
    })
    server.use(...project.handlers)
    const kept = row({
      kind: "job",
      provider: "vercel",
      providerSandboxId: name("listed"),
    })
    await persistSandboxInstance(kept)
    const result = await sweepConversationSandboxes(orgId, new Date())
    expect((await vercelRows()).map((item) => item.id)).toEqual([kept.id])
    expect(project.snapshots.size).toBe(1)
    expect(result.nextSweepAt).not.toBeNull()
  })

  it("pushes a conversation sandbox first: it stays while the push must retry, until its retention ends", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
    const project = vercelProject({
      sandboxes: [name("recent"), name("old")],
      snapshots: {},
    })
    server.use(...project.handlers)
    const revision = {
      workspaceId,
      remote: { url: "https://example.test/context.git", connectionId: null },
      sha: "a".repeat(40),
      generation: 1,
      defaultBranch: "main",
      access: "read" as const,
    }
    const recent = row({
      kind: "chat",
      provider: "vercel",
      conversationId,
      providerSandboxId: name("recent"),
      revision,
    })
    const old = row({
      kind: "chat",
      provider: "vercel",
      conversationId,
      providerSandboxId: name("old"),
      revision,
      lastHeartbeatAt: new Date(Date.now() - 40 * 24 * 60 * 60_000),
    })
    for (const record of [recent, old]) await persistSandboxInstance(record)
    // The push starts the sandbox and runs Git in it; Vercel fails the
    // command, so the push must retry.
    const result = await sweepConversationSandboxes(orgId, new Date())
    expect((await vercelRows()).map((item) => item.id)).toEqual([recent.id])
    expect([...project.sandboxes]).toEqual([name("recent")])
    expect(result.nextSweepAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + 5 * 60_000,
    )
  })

  it("keeps a conversation sandbox while a turn holds the conversation, and the base it can have started from", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
    const project = vercelProject({
      sandboxes: [name("busy"), name("held-base")],
      snapshots: { [`snap_held_${orgId}`]: name("held-base") },
    })
    server.use(...project.handlers)
    const base = row({
      kind: "base",
      provider: "vercel",
      providerSandboxId: name("held-base"),
      latestSnapshotId: `snap_held_${orgId}`,
      state: "live",
    })
    await persistSandboxInstance(base)
    const busy = row({
      kind: "chat",
      provider: "vercel",
      conversationId,
      providerSandboxId: name("busy"),
    })
    await persistSandboxInstance(busy)
    await postgresSandboxLocks(orgId).withLock(
      `chat-thread:${conversationId}`,
      () => sweepConversationSandboxes(orgId, new Date()),
    )
    expect((await vercelRows()).map((item) => item.id).sort()).toEqual(
      [base.id, busy.id].sort(),
    )
    expect([...project.sandboxes].sort()).toEqual(
      [name("busy"), name("held-base")].sort(),
    )
    expect(project.snapshots.size).toBe(1)
    await sweepConversationSandboxes(orgId, new Date())
    expect(await vercelRows()).toEqual([])
    expect(project.sandboxes.size).toBe(0)
    expect(project.snapshots.size).toBe(0)
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

  it("saves commits that the push refuses as a Git bundle in S3, then deletes the sandbox, its row and then the base", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
    const workdir = refusedSandbox()
    const refusedSha = git(workdir, "rev-parse", "HEAD")
    const project = vercelProject({
      sandboxes: [name("refused"), name("refused-base")],
      snapshots: { [`snap_refused_${orgId}`]: name("refused-base") },
      workdirs: { [name("refused")]: workdir },
    })
    const s3 = s3Bucket()
    server.use(...project.handlers, ...githubApp, s3.handler)
    const chat = await refusedChatRow(name("refused"))
    const base = row({
      kind: "base",
      provider: "vercel",
      workspaceId: github.workspaceId,
      providerSandboxId: name("refused-base"),
      latestSnapshotId: `snap_refused_${orgId}`,
      state: "live",
    })
    for (const record of [chat, base]) await persistSandboxInstance(record)

    await sweepConversationSandboxes(orgId, new Date())

    const key = `retired-sandboxes/${orgId}/${chat.conversationId}/${chat.id}.bundle`
    expect([...s3.bucket.objects.keys()]).toEqual([
      `${BUCKET}.s3.us-west-2.amazonaws.com/${key}`,
    ])
    const bytes = [...s3.bucket.objects.values()][0] ?? Buffer.alloc(0)
    expect(bytes.length).toBeGreaterThan(0)
    // The bundle holds the refused commit, on top of the commit GitHub has.
    const file = join(github.directory, "saved.bundle")
    writeFileSync(file, bytes)
    expect(git(remote, "bundle", "verify", "-q", file)).toBe("")
    expect(git(remote, "bundle", "list-heads", file)).toContain(refusedSha)
    expect(await vercelRows()).toEqual([])
    expect(project.sandboxes.size).toBe(0)
    expect(project.snapshots.size).toBe(0)
    // The refused commit never reached GitHub.
    expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/main",
    )
  })

  it("keeps a refused sandbox and the base after it while its bundle upload fails, also past its retention, and without the setting", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
    const workdir = refusedSandbox()
    const project = vercelProject({
      sandboxes: [name("unsaved"), name("unsaved-base")],
      snapshots: { [`snap_unsaved_${orgId}`]: name("unsaved-base") },
      workdirs: { [name("unsaved")]: workdir },
    })
    const s3 = s3Bucket()
    s3.bucket.refuse = true
    server.use(...project.handlers, ...githubApp, s3.handler)
    const chat = await refusedChatRow(
      name("unsaved"),
      new Date(Date.now() - 40 * 24 * 60 * 60_000),
    )
    const base = row({
      kind: "base",
      provider: "vercel",
      workspaceId: github.workspaceId,
      providerSandboxId: name("unsaved-base"),
      latestSnapshotId: `snap_unsaved_${orgId}`,
      state: "live",
    })
    for (const record of [chat, base]) await persistSandboxInstance(record)

    const result = await sweepConversationSandboxes(orgId, new Date())
    expect((await vercelRows()).map((item) => item.id).sort()).toEqual(
      [base.id, chat.id].sort(),
    )
    expect(project.sandboxes.size).toBe(2)
    expect(s3.bucket.objects.size).toBe(0)
    expect(result.nextSweepAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + 5 * 60_000,
    )
    expect(events.at(-2)).toMatchObject({
      message: "Saving the refused commits of a Vercel sandbox failed",
      status: 403,
    })

    // Without the setting, a recent refused sandbox stays as before.
    vi.stubEnv("RETIRED_SANDBOX_STORE", undefined)
    const recent = {
      ...chat,
      id: generateObjectId("sbx"),
      lastHeartbeatAt: new Date(),
    }
    await withOrgDbContext(orgId, (db) =>
      db
        .delete(workspaceSandboxInstances)
        .where(eq(workspaceSandboxInstances.id, chat.id)),
    )
    await persistSandboxInstance(recent)
    await sweepConversationSandboxes(orgId, new Date())
    expect((await vercelRows()).map((item) => item.id).sort()).toEqual(
      [base.id, recent.id].sort(),
    )

    // The upload works again: the next sweep drains both.
    vi.stubEnv("RETIRED_SANDBOX_STORE", `s3://${BUCKET}/retired-sandboxes`)
    s3.bucket.refuse = false
    await sweepConversationSandboxes(orgId, new Date())
    expect(await vercelRows()).toEqual([])
    expect(s3.bucket.objects.size).toBe(1)
    expect(project.sandboxes.size).toBe(0)
  })

  it("saves no bundle when the push refuses for another reason: the sandbox stays until its retention ends", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
    // Not the default branch and not the conversation's: `other_branch`.
    const workdir = refusedSandbox()
    git(workdir, "checkout", "-q", "-b", "elsewhere")
    const project = vercelProject({
      sandboxes: [name("elsewhere")],
      snapshots: {},
      workdirs: { [name("elsewhere")]: workdir },
    })
    const s3 = s3Bucket()
    server.use(...project.handlers, ...githubApp, s3.handler)
    const chat = await refusedChatRow(name("elsewhere"))
    await persistSandboxInstance(chat)
    await sweepConversationSandboxes(orgId, new Date())
    expect((await vercelRows()).map((item) => item.id)).toEqual([chat.id])
    expect(project.sandboxes.size).toBe(1)
    expect(s3.bucket.objects.size).toBe(0)
  })

  it("logs no org, Workspace, sandbox or snapshot id, no token and no error text in the retirement's lines", () => {
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      const text = JSON.stringify(event)
      for (const secret of [
        orgId,
        workspaceId,
        github.workspaceId,
        "conv_",
        "retired-sandboxes/",
        BUCKET,
        "Access Denied",
        TOKEN,
        name(""),
        "snap_",
        "sbx_",
        "unavailable",
        "Status code",
      ])
        expect(text).not.toContain(secret)
    }
  })
})
