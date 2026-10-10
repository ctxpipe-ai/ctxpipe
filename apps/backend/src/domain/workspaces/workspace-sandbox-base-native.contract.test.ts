import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { PassThrough } from "node:stream"
import { finished } from "node:stream/promises"
import { promisify } from "node:util"
import Docker from "dockerode"
import { eq } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
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
import {
  BASE_BUILD_LEASE_MS,
  countRunningSandboxes,
  getSandboxInstance,
} from "../../models/workspaces.js"
import { startTestAgentVaultEnv } from "../../test/agent-vault-fixture.js"
import {
  CHAT_IMAGE,
  dockerChat,
  type Fixture,
  PROXY_SESSION_PREFIX,
} from "../../test/docker-workspace-base.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import {
  CHAT_SANDBOX_RETENTION_MS,
  ORG_RUNNING_SANDBOX_LIMIT,
} from "./chat-lifecycle.js"
import { stopConversationSandboxes } from "./conversation-sandbox-lifecycle.js"
import { pruneDockerSandboxHost } from "./docker-sandbox-host-prune.js"
import { DOCKER_LABELS, sandboxStoreId } from "./workspace-base-providers.js"
import { reserveWorkspaceBaseBuild } from "./workspace-sandbox-base.js"
import {
  destroySandboxesForConversation,
  destroySandboxesForWorkspace,
} from "./workspace-sandbox-cleanup.js"

// Docker sandboxes get credentials only through Agent Vault.
let agentVault: Awaited<ReturnType<typeof startTestAgentVaultEnv>>
beforeAll(async () => {
  agentVault = await startTestAgentVaultEnv()
}, 120_000)
afterAll(() => agentVault?.stop())
const GIT_HOST = "git.ctxpipe.test"

/**
 * Workspace bases on real Docker and Postgres (ADR-048, "Fast start"). The
 * Workspace repository is served over smart HTTP on the default bridge and
 * requires a token, so the stock clone's credential path is exercised and
 * the proof also runs on Docker Desktop.
 */

const exec = promisify(execFile)
const docker = new Docker({ timeout: 60_000 })

afterAll(async () => {
  const { closeOpenWorkflowClient } = await import(
    "../../openworkflow/client.js"
  )
  await closeOpenWorkflowClient()
  await closeDb()
})

/** Timings go to the test log; tickets 02 and 03 record them. */
function report(line: string) {
  process.stderr.write(`${line}\n`)
}

async function containerExec(
  container: Docker.Container,
  command: string[],
  options: { user?: string; env?: string[] } = {},
) {
  const execution = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    ...(options.user ? { User: options.user } : {}),
    ...(options.env ? { Env: options.env } : {}),
  })
  const stream = await execution.start({ hijack: true })
  const output: Buffer[] = []
  const sink = new PassThrough()
  sink.on("data", (chunk: Buffer) => output.push(chunk))
  container.modem.demuxStream(stream, sink, sink)
  await finished(stream)
  const { ExitCode } = await execution.inspect()
  return { exitCode: ExitCode, output: Buffer.concat(output).toString() }
}

/**
 * Smart HTTP over `git http-backend`, without auth: Agent Vault adds tokens
 * only for GitHub hosts (agent-vault-native proves that path).
 */
const gitServerSource = String.raw`
import { spawn } from "node:child_process"
import { createServer } from "node:http"
createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture")
  const child = spawn("git", ["-c", "safe.directory=*", "http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: "/tmp/srv",
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: request.headers["content-length"] ?? "",
      HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
      HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
    },
  })
  request.pipe(child.stdin)
  let pending = Buffer.alloc(0)
  let sent = false
  child.stdout.on("data", (chunk) => {
    if (sent) return void response.write(chunk)
    pending = Buffer.concat([pending, chunk])
    const text = pending.toString("latin1")
    const match = /\r?\n\r?\n/.exec(text)
    if (!match) return
    let status = 200
    const headers = {}
    for (const line of text.slice(0, match.index).split(/\r?\n/)) {
      const at = line.indexOf(":")
      if (at < 0) continue
      const name = line.slice(0, at).trim()
      const value = line.slice(at + 1).trim()
      if (name.toLowerCase() === "status") status = Number(value.slice(0, 3))
      else headers[name] = value
    }
    response.writeHead(status, headers)
    sent = true
    response.write(pending.subarray(match.index + match[0].length))
  })
  child.stdout.on("end", () => {
    if (!sent) response.writeHead(502)
    response.end()
  })
}).listen(8080, "0.0.0.0")
`

/**
 * Serve `directory` as `http://<bridge ip>:8080/repo.git`. `stop` takes the
 * remote away, so any clone after it fails.
 */
async function withGitRemote<T>(
  directory: string,
  fn: (remote: {
    url: string
    sync: () => Promise<void>
    stop: () => Promise<void>
  }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ctxpipe-base-remote-"))
  let container: Docker.Container | undefined
  let network: string | undefined
  try {
    const bare = join(root, "srv", "repo.git")
    await exec("git", ["clone", "--bare", directory, bare])
    // Real hosts serve any commit by id; the pre-turn update fetches by id.
    await exec("git", [
      "--git-dir",
      bare,
      "config",
      "uploadpack.allowAnySHA1InWant",
      "true",
    ])
    await writeFile(join(root, "srv", "server.mjs"), gitServerSource)
    const archive = join(root, "srv.tar")
    await exec("tar", ["--no-xattrs", "-C", root, "-cf", archive, "srv"])
    // Agent Vault rules and dials take host names: the remote has one on a
    // network that the test Agent Vault joins.
    network = `ctxpipe-base-git-${randomUUID().slice(0, 8)}`
    await docker.createNetwork({ Name: network })
    container = await docker.createContainer({
      Image: CHAT_IMAGE,
      User: "0:0",
      Entrypoint: ["node"],
      Cmd: ["/tmp/srv/server.mjs"],
      Labels: { "ai.ctxpipe.purpose": "workspace-base-proof" },
      HostConfig: { NetworkMode: network },
      NetworkingConfig: {
        EndpointsConfig: { [network]: { Aliases: [GIT_HOST] } },
      },
    })
    await container.putArchive(await readFile(archive), { path: "/tmp" })
    await container.start()
    await docker.getNetwork(network).connect({ Container: agentVault.name })
    const server = container
    const url = `http://${GIT_HOST}:8080/repo.git`
    const deadline = Date.now() + 15_000
    while (
      (
        await containerExec(server, [
          "git",
          "ls-remote",
          "http://127.0.0.1:8080/repo.git",
        ])
      ).exitCode !== 0
    ) {
      if (Date.now() > deadline) throw new Error("git remote did not start")
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return await fn({
      url,
      sync: async () => {
        const bundle = join(root, `${randomUUID()}.bundle`)
        await exec("git", [
          "-C",
          directory,
          "bundle",
          "create",
          bundle,
          "--all",
        ])
        const bundleArchive = `${bundle}.tar`
        await exec("tar", [
          "--no-xattrs",
          "-C",
          root,
          "-cf",
          bundleArchive,
          basename(bundle),
        ])
        await server.putArchive(await readFile(bundleArchive), {
          path: "/tmp",
        })
        const fetched = await containerExec(server, [
          "git",
          "-c",
          "safe.directory=*",
          "--git-dir=/tmp/srv/repo.git",
          "fetch",
          "--force",
          `/tmp/${basename(bundle)}`,
          "+refs/heads/*:refs/heads/*",
        ])
        if (fetched.exitCode !== 0) throw new Error(fetched.output)
      },
      stop: async () => {
        await server.remove({ force: true, v: true })
        container = undefined
      },
    })
  } finally {
    await container?.remove({ force: true, v: true }).catch(() => undefined)
    if (network) {
      const joined = docker.getNetwork(network)
      await joined
        .disconnect({ Container: agentVault.name, Force: true })
        .catch(() => undefined)
      await joined.remove().catch(() => undefined)
    }
    await rm(root, { recursive: true, force: true })
  }
}

/** Base-build runs queued for one Workspace. */
async function queuedBaseBuilds(workspaceId: string): Promise<number> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
  const backend = await BackendPostgres.connect(url, { runMigrations: false })
  try {
    return (await backend.listWorkflowRuns({ limit: 1000 })).data.filter(
      (run) =>
        run.workflowName === "workspace-sandbox-base" &&
        (run.input as { workspaceId?: string })?.workspaceId === workspaceId,
    ).length
  } finally {
    await backend.stop()
  }
}

async function exists(kind: "image" | "container", id: string) {
  const inspect: () => Promise<unknown> =
    kind === "image"
      ? () => docker.getImage(id).inspect()
      : () => docker.getContainer(id).inspect()
  return inspect().then(
    () => true,
    (error: { statusCode?: number }) => {
      if (error.statusCode === 404) return false
      throw error
    },
  )
}

async function ensureImage(image: string) {
  if (await exists("image", image)) return
  const stream = await docker.pull(image)
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (error) =>
      error ? reject(error) : resolve(),
    ),
  )
}

/** Docker provider and chat image; the remote becomes the Workspace URL. */
async function withDockerBases<T>(
  fn: (
    f: Fixture,
    remote: Parameters<Parameters<typeof withGitRemote>[1]>[0],
    chat: ReturnType<typeof dockerChat>,
  ) => Promise<T>,
): Promise<T> {
  return withNativeChatFixture(async (f) => {
    // Stubbed after the fixture sets its own provider, and restored before
    // the fixture restores its environment.
    vi.stubEnv("SANDBOX_PROVIDER", "docker")
    vi.stubEnv("SANDBOX_CHAT_IMAGE", CHAT_IMAGE)
    try {
      return await withGitRemote(f.directory, async (remote) => {
        await withOrgDbContext(f.orgId, (db) =>
          db
            .update(workspaces)
            .set({ workspaceRepositoryUrl: remote.url })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        return withOrgIdContext({ id: f.orgId, slug: f.orgSlug }, () =>
          fn(f, remote, dockerChat(f, remote.url)),
        )
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
}

it(
  "a new conversation starts from the base with no clone; concurrent starts queue one build; one build at a time; no token in the base",
  { timeout: 300_000 },
  async () => {
    await withDockerBases(async (f, remote, chat) => {
      // Build requests share a run per 10-minute window: start well inside
      // one, so the three starts below cannot cross a boundary.
      const window = 10 * 60_000
      const left = window - (Date.now() % window)
      if (left < 60_000)
        await new Promise((resolve) => setTimeout(resolve, left + 1_000))
      // No base yet: three new conversations start at once, as before
      // (cloning), and ask for one build in the background.
      const first = await Promise.all(
        [1, 2, 3].map(async () => chat.warm(await chat.conversation(), f.sha)),
      )
      for (const started of first)
        expect(await chat.head(started.handle)).toBe(f.sha)
      await expect.poll(() => queuedBaseBuilds(f.workspaceId)).toBe(1)
      expect(await chat.bases()).toEqual([])

      // One build at a time: concurrent reservations give one lease.
      const runs = [randomUUID(), randomUUID(), randomUUID()]
      const leases = await Promise.all(runs.map((runId) => chat.reserve(runId)))
      const [lease, ...others] = leases.filter(Boolean)
      expect(others).toEqual([])
      if (!lease) throw new Error("no lease")
      // A retried reserve finds its own row, not someone else's lease.
      const winner = runs[leases.indexOf(lease)]
      expect(await chat.reserve(winner)).toBe(lease)
      expect(await chat.bases()).toHaveLength(1)
      // The builder runs a sandbox: it holds one of the org's slots.
      expect(await countRunningSandboxes(f.orgId, "")).toBe(4)
      const image = await chat.run(lease)
      if (!image) throw new Error("build lost its lease")
      // A finished base runs nothing; the Docker builder is gone.
      expect(await countRunningSandboxes(f.orgId, "")).toBe(3)
      expect(await getSandboxInstance(lease, f.orgId)).toMatchObject({
        state: "live",
        latestSnapshotId: image,
        providerSandboxId: null,
      })
      // A retried build after publishing returns the same base, untouched.
      expect(await chat.run(lease)).toBe(image)
      expect(await exists("image", image)).toBe(true)
      expect((await chat.bases()).map((row) => row.state)).toEqual(["live"])
      expect(
        (await docker.getImage(image).inspect()).Config.Labels,
      ).toMatchObject({
        [DOCKER_LABELS.kind]: "workspace-base",
        [DOCKER_LABELS.store]: sandboxStoreId(),
        [DOCKER_LABELS.base]: lease,
        [DOCKER_LABELS.org]: f.orgId,
      })
      expect(await chat.build()).toBeNull()

      // The clone went through the build's proxy session; the base holds it
      // nowhere.
      expect(
        JSON.stringify(await docker.getImage(image).inspect()),
      ).not.toContain(PROXY_SESSION_PREFIX)
      const probe = await docker.createContainer({
        Image: image,
        User: "0:0",
        Cmd: ["sleep", "120"],
        Labels: { "ai.ctxpipe.purpose": "workspace-base-proof" },
      })
      try {
        await probe.start()
        const scan = await containerExec(
          probe,
          [
            "sh",
            "-c",
            'git -C /workspace config --list --show-origin; grep -rIlF -- "$NEEDLE" /workspace /home /root /etc /tmp /var/tmp 2>/dev/null; true',
          ],
          { env: [`NEEDLE=${PROXY_SESSION_PREFIX}`] },
        )
        expect(scan.output).not.toContain(PROXY_SESSION_PREFIX)
        expect(scan.output).not.toMatch(/^\/(workspace|home|root|etc|tmp|var)/m)
      } finally {
        await probe.remove({ force: true, v: true })
      }

      // With the remote gone, only a start that needs no clone succeeds.
      await remote.stop()
      const fromBase = await chat.warm(await chat.conversation(), f.sha)
      expect(await fromBase.handle.fs.read("/workspace/README.md")).toBe(
        "# Native chat workspace\n",
      )
      expect(await chat.head(fromBase.handle)).toBe(f.sha)
      expect(await chat.imageOf(fromBase.handle.id)).toBe(image)
      report(
        `[workspace-base] docker sandbox ready: without base ${first.map((s) => s.ms).join("/")}ms (3 concurrent, serialized by the Workspace lock), from base ${fromBase.ms}ms`,
      )

      // Deleting the Workspace's sandboxes (deletion, relink) deletes the base.
      await destroySandboxesForWorkspace(f.workspaceId)
      expect(await chat.bases()).toEqual([])
      expect(await exists("image", image)).toBe(false)
    })
  },
)

it(
  "rebuilds a stale base; existing conversations keep their sandbox; superseded bases go, except while a running sandbox uses them",
  { timeout: 400_000 },
  async () => {
    await withDockerBases(async (f, remote, chat) => {
      const firstImage = await chat.build()
      if (!firstImage) throw new Error("no base")
      const kept = await chat.conversation()
      const keptStart = await chat.warm(kept, f.sha)
      expect(await chat.imageOf(keptStart.handle.id)).toBe(firstImage)

      const sha = await chat.commit("# Advanced\n")
      await remote.sync()
      await chat.setDesired(sha)
      // Behind, but built less than a day ago: kept.
      expect(await chat.build()).toBeNull()
      await chat.backdateBases()
      const secondImage = await chat.build()
      if (!secondImage) throw new Error("stale base not rebuilt")

      // The existing conversation keeps its container and moves to the tip.
      const again = await chat.warm(kept, sha)
      expect(again.handle.id).toBe(keptStart.handle.id)
      expect(await chat.head(again.handle)).toBe(sha)
      // A new one starts from the newest base, already at the tip.
      const fresh = await chat.conversation()
      const freshStart = await chat.warm(fresh, sha)
      expect(await chat.imageOf(freshStart.handle.id)).toBe(secondImage)
      expect(await freshStart.handle.fs.read("/workspace/README.md")).toBe(
        "# Advanced\n",
      )

      // Superseded: the daemon refuses while `kept` runs, so the row stays.
      expect(await chat.collect()).toBe(0)
      expect(await exists("image", firstImage)).toBe(true)
      // Once it is stopped the base goes, and the stopped sandbox still
      // resumes with its files (measured: Docker keeps its layers).
      await again.handle.fs.write("/workspace/kept.txt", "kept")
      await stopConversationSandboxes({ orgId: f.orgId, conversationId: kept })
      expect(await chat.collect()).toBe(1)
      expect(await exists("image", firstImage)).toBe(false)
      const resumed = await chat.warm(kept, sha)
      expect(resumed.handle.id).toBe(keptStart.handle.id)
      expect(await resumed.handle.fs.read("/workspace/kept.txt")).toBe("kept")

      // The current base stays until nothing started from it for 30 days.
      await destroySandboxesForConversation(fresh)
      expect(await chat.collect()).toBe(0)
      expect(
        await chat.collect(new Date(Date.now() + CHAT_SANDBOX_RETENTION_MS)),
      ).toBe(1)
      expect(await exists("image", secondImage)).toBe(false)
      expect(await chat.bases()).toEqual([])
    })
  },
)

it(
  "a start whose base is gone falls back to the chat image, once, and asks for a rebuild",
  { timeout: 300_000 },
  async () => {
    await withDockerBases(async (f, _remote, chat) => {
      const image = await chat.build()
      if (!image) throw new Error("no base")
      await docker.getImage(image).remove({ force: true })
      const started = await chat.warm(await chat.conversation(), f.sha)
      expect(await chat.imageOf(started.handle.id)).toBe(
        (await chat.agent()).image,
      )
      expect(await chat.head(started.handle)).toBe(f.sha)
      const [base] = await chat.bases()
      // Marked failed: no later start tries it again; cleanup removes it.
      expect(base?.state).toBe("destroy_failed")
      await expect.poll(() => queuedBaseBuilds(f.workspaceId)).toBe(1)
      expect(await chat.collect()).toBe(1)
      expect(await chat.bases()).toEqual([])
      // And the next build makes a new base.
      expect(await chat.build()).not.toBeNull()
    })
  },
)

it(
  "a build that loses its lease stops and leaves nothing behind; at capacity there is no build",
  { timeout: 300_000 },
  async () => {
    await withDockerBases(async (f, _remote, chat) => {
      const leftovers = async () => [
        ...(await docker.listContainers({
          all: true,
          filters: JSON.stringify({
            label: [`${DOCKER_LABELS.org}=${f.orgId}`],
          }),
        })),
        ...(await docker.listImages({
          filters: JSON.stringify({
            label: [`${DOCKER_LABELS.org}=${f.orgId}`],
          }),
        })),
      ]
      // Relink or delete removes the row while the builder clones.
      const lost = await chat.build((builder) => ({
        ...builder,
        start: async (base) => {
          const build = await builder.start(base)
          await withOrgDbContext(f.orgId, (db) =>
            db
              .delete(workspaceSandboxInstances)
              .where(eq(workspaceSandboxInstances.id, base.id)),
          )
          return build
        },
      }))
      expect(lost).toBeNull()
      expect(await leftovers()).toEqual([])

      // A builder that cannot start ends its lease at once: the slot is
      // free, and the next build is not blocked for the lease's hour.
      await expect(
        chat.build((builder) => ({
          ...builder,
          start: async () => {
            throw new Error("no capacity")
          },
        })),
      ).rejects.toThrow("no capacity")
      const [unstarted] = await chat.bases()
      expect(unstarted?.state).toBe("destroy_failed")
      expect(await countRunningSandboxes(f.orgId, "")).toBe(0)
      expect(await chat.collect()).toBe(1)

      // A held lease takes a slot; a lapsed one does not, is not resumed,
      // and cleanup removes its row.
      const agent = await chat.agent()
      const expired = await chat.reserve()
      if (!expired) throw new Error("no lease")
      expect(await countRunningSandboxes(f.orgId, "")).toBe(1)
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaceSandboxInstances)
          .set({
            lastHeartbeatAt: new Date(Date.now() - BASE_BUILD_LEASE_MS - 1_000),
          })
          .where(eq(workspaceSandboxInstances.id, expired)),
      )
      expect(await countRunningSandboxes(f.orgId, "")).toBe(0)
      expect(await chat.run(expired)).toBeNull()
      expect(await chat.collect()).toBe(1)
      expect(await chat.bases()).toEqual([])

      // At the org's sandbox limit a builder does not start.
      const ids = Array.from(
        { length: ORG_RUNNING_SANDBOX_LIMIT },
        (_, index) => `full-${f.orgId}-${index}`,
      )
      await withOrgDbContext(f.orgId, (db) =>
        db.insert(workspaceSandboxInstances).values(
          ids.map((id) => ({
            id,
            kind: "chat",
            orgId: f.orgId,
            workspaceId: f.workspaceId,
            conversationId: `conv_elsewhere_${id}`,
            provider: "docker",
            providerSandboxId: `container-${id}`,
            state: "live",
            lastHeartbeatAt: new Date(),
          })),
        ),
      )
      try {
        expect(
          await reserveWorkspaceBaseBuild({
            orgId: f.orgId,
            workspaceId: f.workspaceId,
            runId: randomUUID(),
            agent,
          }),
        ).toBeNull()
      } finally {
        await withOrgDbContext(f.orgId, async (db) => {
          for (const id of ids)
            await db
              .delete(workspaceSandboxInstances)
              .where(eq(workspaceSandboxInstances.id, id))
        })
      }
    })
  },
)

it(
  "disk stays flat: repeated build, start, stop and delete cycles leave no containers or images",
  { timeout: 600_000 },
  async () => {
    await withDockerBases(async (f, remote, chat) => {
      const ours = async () => [
        ...(
          await docker.listContainers({
            all: true,
            filters: JSON.stringify({
              label: [`${DOCKER_LABELS.org}=${f.orgId}`],
            }),
          })
        ).map((container) => container.Id),
        ...(
          await docker.listImages({
            filters: JSON.stringify({
              label: [`${DOCKER_LABELS.org}=${f.orgId}`],
            }),
          })
        ).map((image) => image.Id),
      ]
      const started: string[] = []
      for (const cycle of [1, 2, 3]) {
        const sha = await chat.commit(`# Cycle ${cycle}\n`)
        await remote.sync()
        await chat.setDesired(sha)
        await chat.backdateBases()
        expect(await chat.build()).not.toBeNull()
        const conversationId = await chat.conversation()
        const start = await chat.warm(conversationId, sha)
        started.push(start.handle.id)
        await stopConversationSandboxes({ orgId: f.orgId, conversationId })
        await destroySandboxesForConversation(conversationId)
        await chat.collect()
        // Only the current base remains.
        expect(await ours()).toHaveLength(1)
      }
      await destroySandboxesForWorkspace(f.workspaceId)
      expect(await ours()).toEqual([])
      for (const id of started)
        expect(await exists("container", id)).toBe(false)
    })
  },
)

it(
  "the host prune removes orphaned labeled objects of its own store, including a captured image whose build never published, and nothing else",
  { timeout: 180_000 },
  async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for the host prune proof")
    initDb(process.env.DATABASE_URL)
    const now = new Date()
    // This test's own store: the prune sees only the objects made here, so
    // the zero orphan age cannot touch other runs' objects.
    const store = `prune-proof-${randomUUID()}`
    const containers: string[] = []
    const images: string[] = []
    const orgId = generateObjectId("org")
    const workspaceId = generateObjectId("ws")
    await getSystemDb().insert(organizations).values({
      id: orgId,
      slug: orgId,
      name: "Host prune proof",
      createdAt: now,
    })
    const container = async (labels: Record<string, string> = {}) => {
      const created = await docker.createContainer({
        Image: "alpine:3.22",
        Cmd: ["sleep", "600"],
        Labels: { "ai.ctxpipe.purpose": "workspace-base-proof", ...labels },
      })
      containers.push(created.id)
      await created.start()
      await created.stop({ t: 0 })
      return created.id
    }
    const labeledImage = async (labels: Record<string, string>) => {
      const source = await docker.createContainer({
        Image: "alpine:3.22",
        Cmd: ["true"],
      })
      try {
        const committed = (await source.commit({
          repo: "ctxpipe-workspace-base-proof",
          tag: randomUUID(),
          changes: Object.entries(labels).map(
            ([key, value]) => `LABEL ${key}=${JSON.stringify(value)}`,
          ),
        })) as { Id: string }
        images.push(committed.Id)
        return committed.Id
      } finally {
        await source.remove({ force: true })
      }
    }
    const ours = (baseId: string) => ({
      [DOCKER_LABELS.kind]: "workspace-base",
      [DOCKER_LABELS.store]: store,
      [DOCKER_LABELS.base]: baseId,
      [DOCKER_LABELS.org]: orgId,
    })
    /** A base row; `image` is the image it published, if any. */
    const base = async (
      state: "live" | "building",
      lastHeartbeatAt: Date,
      image: string | null,
    ) => {
      const id = `base:${workspaceId}:${randomUUID()}`
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaceSandboxInstances).values({
          id,
          kind: "base",
          orgId,
          workspaceId,
          provider: "docker",
          latestSnapshotId: image,
          state,
          lastHeartbeatAt,
        }),
      )
      return id
    }
    try {
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId,
          slug: "context",
          displayName: "Context",
          workspaceRepositoryUrl: "https://example.test/context.git",
          desiredSha: "a".repeat(40),
          desiredDefaultBranch: "main",
        }),
      )
      await ensureImage("alpine:3.22")
      const recordedContainer = await container(ours("base:recorded"))
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaceSandboxInstances).values({
          id: `prune-proof-${recordedContainer}`,
          kind: "chat",
          orgId,
          workspaceId,
          provider: "docker",
          providerSandboxId: recordedContainer,
          state: "stopped",
          lastHeartbeatAt: now,
        }),
      )
      // A builder or base-started container whose row is gone.
      const orphan = await container(ours("base:gone"))
      const unlabeledContainer = await container()

      const rowGone = await labeledImage(ours("base:gone"))
      // Published: the row names the image.
      const publishedId = await base("live", now, null)
      const published = await labeledImage(ours(publishedId))
      await withOrgDbContext(orgId, (db) =>
        db
          .update(workspaceSandboxInstances)
          .set({ latestSnapshotId: published })
          .where(eq(workspaceSandboxInstances.id, publishedId)),
      )
      // Captured, and the publish is still to come: the lease holds.
      const publishing = await labeledImage(
        ours(await base("building", now, null)),
      )
      // Captured, then the build crashed before it published.
      const crashed = await labeledImage(
        ours(
          await base(
            "building",
            new Date(now.getTime() - BASE_BUILD_LEASE_MS - 60_000),
            null,
          ),
        ),
      )
      // A later attempt of the same row published another image.
      const replaced = await labeledImage(ours(publishedId))
      const foreignImage = await labeledImage({
        ...ours("base:gone"),
        [DOCKER_LABELS.store]: "another-deployment",
      })
      const unlabeledImage = await labeledImage({})

      const pruned = await withTestLogger(() =>
        pruneDockerSandboxHost({ orphanAgeMs: 0, store }),
      )
      expect(new Set(pruned.removedImages)).toEqual(
        new Set([rowGone, crashed, replaced]),
      )
      expect(pruned.removedContainers).toEqual([orphan])
      for (const id of [rowGone, crashed, replaced])
        expect(await exists("image", id)).toBe(false)
      for (const id of [published, publishing, foreignImage, unlabeledImage])
        expect(await exists("image", id)).toBe(true)
      expect(await exists("container", orphan)).toBe(false)
      for (const id of [recordedContainer, unlabeledContainer])
        expect(await exists("container", id)).toBe(true)
    } finally {
      for (const id of containers)
        await docker
          .getContainer(id)
          .remove({ force: true, v: true })
          .catch(() => undefined)
      for (const id of images)
        await docker
          .getImage(id)
          .remove({ force: true })
          .catch(() => undefined)
      await withOrgDbContext(orgId, async (db) => {
        await db
          .delete(workspaceSandboxInstances)
          .where(eq(workspaceSandboxInstances.orgId, orgId))
        await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
    }
  },
)
