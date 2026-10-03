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
import { afterAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
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
  getSandboxInstance,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { CHAT_SANDBOX_RETENTION_MS } from "./chat-lifecycle.js"
import { pruneDockerSandboxHost } from "./docker-sandbox-host-prune.js"
import { warmTanstackWorkspaceChat } from "./tanstack-workspace-chat.js"
import {
  DOCKER_BASE_LABEL,
  DOCKER_BASE_LABEL_VALUE,
  DOCKER_BASE_ROW_LABEL,
  DOCKER_BASE_STORE_LABEL,
  sandboxStoreId,
} from "./workspace-base-providers.js"
import {
  BASE_START_GRACE_MS,
  BASE_UNUSED_MS,
  baseRefOfIdentity,
  buildWorkspaceSandboxBase,
} from "./workspace-sandbox-base.js"
import {
  collectUnusedWorkspaceChatBases,
  destroySandboxesForConversation,
  destroySandboxesForWorkspace,
} from "./workspace-sandbox-cleanup.js"

/**
 * Workspace bases on real Docker and Postgres (ADR-048, "Fast start"). The
 * Workspace repository is served by `git daemon` on the default bridge, so
 * the proof also runs on Docker Desktop.
 */

const exec = promisify(execFile)
const CHAT_IMAGE =
  process.env.CTXPIPE_TEST_CHAT_SANDBOX_IMAGE?.trim() ||
  "ctxpipe-chat-sandbox:opencode-1.18.34"
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
  user?: string,
) {
  const execution = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    ...(user ? { User: user } : {}),
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
 * Serve `directory` as `git://<bridge ip>/repo.git`. `stop` takes the remote
 * away, so any clone after it fails.
 */
async function withGitDaemon<T>(
  directory: string,
  fn: (remote: {
    url: string
    sync: () => Promise<void>
    stop: () => Promise<void>
  }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ctxpipe-base-remote-"))
  let container: Docker.Container | undefined
  try {
    await exec("git", [
      "clone",
      "--bare",
      directory,
      join(root, "srv", "repo.git"),
    ])
    // Real hosts serve any commit by id; the pre-turn update fetches by id.
    await exec("git", [
      "--git-dir",
      join(root, "srv", "repo.git"),
      "config",
      "uploadpack.allowAnySHA1InWant",
      "true",
    ])
    const archive = join(root, "srv.tar")
    await exec("tar", ["--no-xattrs", "-C", root, "-cf", archive, "srv"])
    container = await docker.createContainer({
      Image: CHAT_IMAGE,
      Entrypoint: ["git"],
      Cmd: [
        "daemon",
        "--export-all",
        "--reuseaddr",
        "--base-path=/tmp/srv",
        "--listen=0.0.0.0",
        "--port=9418",
        "/tmp/srv",
      ],
      // The archive keeps the host's file owner.
      Env: [
        "GIT_CONFIG_COUNT=1",
        "GIT_CONFIG_KEY_0=safe.directory",
        "GIT_CONFIG_VALUE_0=*",
      ],
      Labels: { "ai.ctxpipe.purpose": "workspace-base-proof" },
    })
    await container.putArchive(await readFile(archive), { path: "/tmp" })
    await container.start()
    const server = container
    const deadline = Date.now() + 15_000
    while (
      (
        await containerExec(server, [
          "git",
          "ls-remote",
          "git://127.0.0.1/repo.git",
        ])
      ).exitCode !== 0
    ) {
      if (Date.now() > deadline) throw new Error("git daemon did not start")
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const ip = (await server.inspect()).NetworkSettings.Networks.bridge
      ?.IPAddress
    if (!ip) throw new Error("git daemon has no bridge address")
    return await fn({
      url: `git://${ip}/repo.git`,
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
        // The repository files belong to the host user: update them as root.
        const fetched = await containerExec(
          server,
          [
            "git",
            "--git-dir=/tmp/srv/repo.git",
            "fetch",
            "--force",
            `/tmp/${basename(bundle)}`,
            "+refs/heads/*:refs/heads/*",
          ],
          "0:0",
        )
        if (fetched.exitCode !== 0) throw new Error(fetched.output)
      },
      stop: async () => {
        await server.remove({ force: true, v: true })
        container = undefined
      },
    })
  } finally {
    await container?.remove({ force: true, v: true }).catch(() => undefined)
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

async function imageExists(id: string): Promise<boolean> {
  return docker
    .getImage(id)
    .inspect()
    .then(
      () => true,
      (error: { statusCode?: number }) => {
        if (error.statusCode === 404) return false
        throw error
      },
    )
}

/** Docker sandboxes against `remote`, for one fixture org and Workspace. */
function dockerChat(
  f: Parameters<Parameters<typeof withNativeChatFixture>[0]>[0],
  remoteUrl: string,
) {
  const conversation = async () => {
    const id = generateObjectId("conv")
    await withOrgDbContext(f.orgId, (db) =>
      db
        .insert(conversations)
        .values({ id, orgId: f.orgId, workspaceId: f.workspaceId }),
    )
    return id
  }
  const warm = async (conversationId: string, sha: string) => {
    const started = Date.now()
    const warmed = await warmTanstackWorkspaceChat({
      conversationId,
      orgId: f.orgId,
      orgSlug: f.orgSlug,
      workspaceId: f.workspaceId,
      desiredUrl: remoteUrl,
      desiredSha: sha,
      defaultBranch: "main",
      writeStatus: "read_only",
      prompt: "prepare",
    })
    if (!warmed.ok) throw new Error(`prepare failed: ${warmed.error}`)
    return { handle: warmed.handle, ms: Date.now() - started }
  }
  const rows = (conversationId?: string) =>
    withOrgDbContext(f.orgId, () =>
      listSandboxInstances({
        workspaceId: f.workspaceId,
        ...(conversationId ? { conversationId } : {}),
      }),
    )
  const bases = async () => (await rows()).filter((row) => row.kind === "base")
  const build = (
    options?: Pick<
      Parameters<typeof buildWorkspaceSandboxBase>[0],
      "commitsBehind"
    >,
  ) =>
    withOrgIdContext({ id: f.orgId, slug: f.orgSlug }, () =>
      buildWorkspaceSandboxBase({
        orgId: f.orgId,
        workspaceId: f.workspaceId,
        ...options,
      }),
    )
  const collect = (now: Date) =>
    collectUnusedWorkspaceChatBases(f.orgId, f.workspaceId, now)
  const head = async (handle: {
    process: { exec: (c: string) => Promise<{ stdout: string }> }
  }) => (await handle.process.exec("git rev-parse HEAD")).stdout.trim()
  return { conversation, warm, rows, bases, build, collect, head }
}

/** Docker provider and chat image for the fixture; restored afterwards. */
async function withDockerChat<T>(
  fn: (
    f: Parameters<Parameters<typeof withNativeChatFixture>[0]>[0],
  ) => Promise<T>,
): Promise<T> {
  const previous = process.env.SANDBOX_CHAT_IMAGE
  try {
    return await withNativeChatFixture(async (f) => {
      process.env.SANDBOX_PROVIDER = "docker"
      process.env.SANDBOX_CHAT_IMAGE = CHAT_IMAGE
      return fn(f)
    })
  } finally {
    if (previous === undefined) delete process.env.SANDBOX_CHAT_IMAGE
    else process.env.SANDBOX_CHAT_IMAGE = previous
  }
}

it(
  "a new conversation starts from the Workspace base with no clone, and concurrent starts build it once",
  { timeout: 300_000 },
  async () => {
    await withDockerChat(async (f) => {
      await withGitDaemon(f.directory, async (remote) => {
        await withOrgDbContext(f.orgId, (db) =>
          db
            .update(workspaces)
            .set({ workspaceRepositoryUrl: remote.url })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        const chat = dockerChat(f, remote.url)

        // No base yet: three new conversations start at once, as before
        // (cloning), and ask for a single build in the background.
        const first = await Promise.all(
          [1, 2, 3].map(async () =>
            chat.warm(await chat.conversation(), f.sha),
          ),
        )
        for (const started of first)
          expect(await chat.head(started.handle)).toBe(f.sha)
        await expect.poll(() => queuedBaseBuilds(f.workspaceId)).toBe(1)
        expect(await chat.bases()).toEqual([])

        // Concurrent builds: one builds, the others find it busy.
        const outcomes = await Promise.all([
          chat.build(),
          chat.build(),
          chat.build(),
        ])
        expect(outcomes.sort()).toEqual(["built", "busy", "busy"])
        const [base] = await chat.bases()
        expect(await chat.bases()).toHaveLength(1)
        expect(base).toMatchObject({ state: "live", provider: "docker" })
        expect(base?.revision?.sha).toBe(f.sha)
        const image = base?.latestSnapshotId ?? ""
        const labels = (await docker.getImage(image).inspect()).Config.Labels
        expect(labels).toMatchObject({
          [DOCKER_BASE_LABEL]: DOCKER_BASE_LABEL_VALUE,
          [DOCKER_BASE_STORE_LABEL]: sandboxStoreId(),
          [DOCKER_BASE_ROW_LABEL]: base?.id,
          "ai.ctxpipe.org": f.orgId,
          "ai.ctxpipe.workspace": f.workspaceId,
        })
        // A current base is not rebuilt.
        expect(await chat.build()).toBe("fresh")

        // With the remote gone, only a start that needs no clone succeeds.
        await remote.stop()
        const conversationId = await chat.conversation()
        const fromBase = await chat.warm(conversationId, f.sha)
        expect(await fromBase.handle.fs.read("/workspace/README.md")).toBe(
          "# Native chat workspace\n",
        )
        expect(await chat.head(fromBase.handle)).toBe(f.sha)
        expect(
          (await docker.getContainer(fromBase.handle.id).inspect()).Image,
        ).toBe(image)
        const [row] = await chat.rows(conversationId)
        expect(baseRefOfIdentity(row?.image)).toBe(image)
        report(
          `[workspace-base] docker sandbox ready: without base ${first.map((s) => s.ms).join("/")}ms (3 concurrent), from base ${fromBase.ms}ms`,
        )

        // Deleting the Workspace's sandboxes (deletion, relink) deletes the base.
        await withOrgIdContext({ id: f.orgId, slug: f.orgSlug }, () =>
          destroySandboxesForWorkspace(f.workspaceId),
        )
        expect(await chat.rows()).toEqual([])
        expect(await imageExists(image)).toBe(false)
      })
    })
  },
)

it(
  "rebuilds a stale base; existing conversations keep theirs; unused bases are deleted",
  { timeout: 300_000 },
  async () => {
    await withDockerChat(async (f) => {
      await withGitDaemon(f.directory, async (remote) => {
        await withOrgDbContext(f.orgId, (db) =>
          db
            .update(workspaces)
            .set({ workspaceRepositoryUrl: remote.url })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        const chat = dockerChat(f, remote.url)
        expect(await chat.build()).toBe("built")
        const [first] = await chat.bases()
        const firstImage = first?.latestSnapshotId ?? ""
        const kept = await chat.conversation()
        const keptStart = await chat.warm(kept, f.sha)

        // The default branch moves on.
        await writeFile(join(f.directory, "README.md"), "# Advanced\n")
        await exec("git", [
          "-C",
          f.directory,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-am",
          "Advance",
        ])
        const { stdout } = await exec("git", [
          "-C",
          f.directory,
          "rev-parse",
          "HEAD",
        ])
        const sha = stdout.trim()
        await remote.sync()
        await withOrgDbContext(f.orgId, (db) =>
          db
            .update(workspaces)
            .set({ desiredSha: sha })
            .where(eq(workspaces.id, f.workspaceId)),
        )

        // One commit behind and built just now: kept.
        expect(await chat.build()).toBe("fresh")
        // More than 50 commits behind: rebuilt.
        expect(await chat.build({ commitsBehind: async () => 51 })).toBe(
          "built",
        )
        const second = (await chat.bases()).find((row) => row.id !== first?.id)
        expect(second?.revision?.sha).toBe(sha)
        const secondImage = second?.latestSnapshotId ?? ""

        // A day old and behind: rebuilt too.
        for (const id of [first?.id, second?.id])
          await withOrgDbContext(f.orgId, (db) =>
            db
              .update(workspaceSandboxInstances)
              .set({
                createdAt: new Date(
                  Date.now() - (id === first?.id ? 26 : 25) * 60 * 60_000,
                ),
              })
              .where(eq(workspaceSandboxInstances.id, id ?? "")),
          )
        await writeFile(join(f.directory, "README.md"), "# Advanced again\n")
        await exec("git", [
          "-C",
          f.directory,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-am",
          "Advance again",
        ])
        const latest = (
          await exec("git", ["-C", f.directory, "rev-parse", "HEAD"])
        ).stdout.trim()
        await remote.sync()
        await withOrgDbContext(f.orgId, (db) =>
          db
            .update(workspaces)
            .set({ desiredSha: latest })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        expect(await chat.build()).toBe("built")
        const current = (await chat.bases()).find(
          (row) => row.revision?.sha === latest,
        )
        const currentImage = current?.latestSnapshotId ?? ""

        // The existing conversation keeps its sandbox and moves to the tip.
        const again = await chat.warm(kept, latest)
        expect(again.handle.id).toBe(keptStart.handle.id)
        expect(await chat.head(again.handle)).toBe(latest)
        // A new one starts from the newest base.
        const fresh = await chat.conversation()
        const freshStart = await chat.warm(fresh, latest)
        expect(
          (await docker.getContainer(freshStart.handle.id).inspect()).Image,
        ).toBe(currentImage)
        expect(await freshStart.handle.fs.read("/workspace/README.md")).toBe(
          "# Advanced again\n",
        )

        // The middle base was never used: deleted once past the start grace.
        const later = new Date(Date.now() + BASE_START_GRACE_MS + 1_000)
        expect(await chat.collect(later)).toBe(1)
        expect(await imageExists(secondImage)).toBe(false)
        // The first is kept while a conversation started from it.
        expect(await imageExists(firstImage)).toBe(true)
        await destroySandboxesForConversation(kept)
        expect(await chat.collect(later)).toBe(1)
        expect(await imageExists(firstImage)).toBe(false)
        // The current base is kept until unused for a week.
        await destroySandboxesForConversation(fresh)
        expect(await chat.collect(later)).toBe(0)
        expect(
          await chat.collect(new Date(Date.now() + BASE_UNUSED_MS + 1_000)),
        ).toBe(1)
        expect(await imageExists(currentImage)).toBe(false)
        expect(await chat.bases()).toEqual([])
      })
    })
  },
)

it(
  "the host prune removes a dormant org's 30-day-old stopped container and an unused base image, and nothing else",
  { timeout: 180_000 },
  async () => {
    initDb(process.env.DATABASE_URL ?? "")
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for the host prune proof")
    const now = new Date()
    const orgs: string[] = []
    const containers: string[] = []
    const images: string[] = []
    const org = async () => {
      const orgId = generateObjectId("org")
      const workspaceId = generateObjectId("ws")
      await getSystemDb().insert(organizations).values({
        id: orgId,
        slug: orgId,
        name: "Host prune proof",
        createdAt: now,
      })
      orgs.push(orgId)
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId,
          slug: "context",
          displayName: "Context",
          workspaceRepositoryUrl: "https://example.test/context.git",
        }),
      )
      return { orgId, workspaceId }
    }
    /** A stopped container, recorded as an org's conversation sandbox. */
    const stoppedSandbox = async (
      owner: { orgId: string; workspaceId: string },
      lastUse: Date,
    ) => {
      const container = await docker.createContainer({
        Image: "alpine:3.22",
        Cmd: ["sleep", "600"],
        Labels: { "ai.ctxpipe.purpose": "workspace-base-proof" },
      })
      containers.push(container.id)
      await container.start()
      await container.stop({ t: 0 })
      const conversationId = generateObjectId("conv")
      await withOrgDbContext(owner.orgId, async (db) => {
        await db.insert(conversations).values({
          id: conversationId,
          orgId: owner.orgId,
          workspaceId: owner.workspaceId,
        })
        await db.insert(workspaceSandboxInstances).values({
          id: `prune-proof-${container.id}`,
          kind: "chat",
          orgId: owner.orgId,
          workspaceId: owner.workspaceId,
          conversationId,
          provider: "docker",
          providerSandboxId: container.id,
          state: "stopped",
          lastHeartbeatAt: lastUse,
        })
      })
      return container.id
    }
    /** An image committed from a scratch container with these labels. */
    const labelledImage = async (labels: Record<string, string>) => {
      const container = await docker.createContainer({
        Image: "alpine:3.22",
        Cmd: ["true"],
      })
      try {
        const committed = (await container.commit({
          repo: "ctxpipe-workspace-base-proof",
          tag: randomUUID(),
          changes: Object.entries(labels).map(
            ([key, value]) => `LABEL ${key}=${JSON.stringify(value)}`,
          ),
        })) as { Id: string }
        images.push(committed.Id)
        return committed.Id
      } finally {
        await container.remove({ force: true })
      }
    }
    const ours = (baseId: string, orgId: string) => ({
      [DOCKER_BASE_LABEL]: DOCKER_BASE_LABEL_VALUE,
      [DOCKER_BASE_STORE_LABEL]: sandboxStoreId(),
      [DOCKER_BASE_ROW_LABEL]: baseId,
      "ai.ctxpipe.org": orgId,
    })
    const exists = async (id: string) =>
      docker
        .getContainer(id)
        .inspect()
        .then(
          () => true,
          () => false,
        )
    try {
      const dormant = await org()
      const active = await org()
      const old = await stoppedSandbox(
        dormant,
        new Date(now.getTime() - CHAT_SANDBOX_RETENTION_MS - 60_000),
      )
      const recent = await stoppedSandbox(
        active,
        new Date(now.getTime() - 24 * 60 * 60_000),
      )
      const keptBaseId = `base:${active.workspaceId}:${randomUUID()}`
      const unused = await labelledImage(
        ours(`base:${dormant.workspaceId}:gone`, dormant.orgId),
      )
      const inUse = await labelledImage(ours(keptBaseId, active.orgId))
      await withOrgDbContext(active.orgId, (db) =>
        db.insert(workspaceSandboxInstances).values({
          id: keptBaseId,
          kind: "base",
          orgId: active.orgId,
          workspaceId: active.workspaceId,
          provider: "docker",
          providerSandboxId: inUse,
          latestSnapshotId: inUse,
          state: "live",
          lastHeartbeatAt: now,
        }),
      )
      const otherDeployment = await labelledImage({
        ...ours(`base:${dormant.workspaceId}:other`, dormant.orgId),
        [DOCKER_BASE_STORE_LABEL]: "another-deployment",
      })
      const unlabelled = await labelledImage({})

      const pruned = await pruneDockerSandboxHost({ now })
      expect(pruned.removedImages).toBe(1)
      expect(await exists(old)).toBe(false)
      expect(
        await getSandboxInstance(`prune-proof-${old}`, dormant.orgId),
      ).toBeNull()
      expect(await exists(recent)).toBe(true)
      expect(await imageExists(unused)).toBe(false)
      for (const image of [inUse, otherDeployment, unlabelled])
        expect(await imageExists(image)).toBe(true)
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
      for (const orgId of orgs) {
        await withOrgDbContext(orgId, async (db) => {
          await db
            .delete(workspaceSandboxInstances)
            .where(eq(workspaceSandboxInstances.orgId, orgId))
          await db.delete(conversations).where(eq(conversations.orgId, orgId))
          await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
        })
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, orgId))
      }
    }
  },
)
