import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process"
import { writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createSecrets, defineSandbox } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import Dockerode from "dockerode"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  listSandboxInstances,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { withNativeGitRemote } from "../../test/native-git-remote.js"
import { WORKSPACE_CHAT_DOCKER_SANDBOX } from "./chat-runtime.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { collectUnusedWorkspaceChatBases } from "./workspace-sandbox-cleanup.js"

it(
  "reuses one native Docker worktree across replicas and process restarts",
  { timeout: 90_000 },
  async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for native replica proof")
    initDb(process.env.DATABASE_URL)
    const orgId = generateObjectId("org")
    const workspaceId = generateObjectId("ws")
    const names: string[] = []
    const clients: ReturnType<typeof start>[] = []
    function start(mode: "ensure" | "write" | "read" | "destroy"): {
      child: ChildProcessWithoutNullStreams
      exited: Promise<number | null>
      output: () => string
      errors: () => string
    } {
      // Different allocation names ensure Docker's name uniqueness cannot mask a broken PG lock.
      const name = `ctxpipe-native-replica-${orgId}-${names.length}`
      names.push(name)
      const child = spawn(
        "bun",
        [
          fileURLToPath(
            new URL(
              "../../test/native-sandbox-owner-client.ts",
              import.meta.url,
            ),
          ),
          orgId,
          workspaceId,
          name,
          mode,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      )
      let output = ""
      let errors = ""
      child.stdout.on("data", (chunk) => {
        output += chunk.toString()
      })
      child.stderr.on("data", (chunk) => {
        errors += chunk.toString()
      })
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      )
      const client = {
        child,
        exited,
        output: () => output,
        errors: () => errors,
      }
      clients.push(client)
      return client
    }
    async function ready(client: ReturnType<typeof start>) {
      await expect
        .poll(() => client.output() || client.errors(), { timeout: 10_000 })
        .toContain("ready")
    }
    async function result(client: ReturnType<typeof start>) {
      expect(await client.exited, client.errors()).toBe(0)
      const line = client
        .output()
        .split("\n")
        .find((line) => line.startsWith("{"))
      if (!line) throw new Error(`Missing native result: ${client.output()}`)
      return JSON.parse(line) as { id: string; contents?: string }
    }
    const provider = dockerSandbox({ image: "node:22" })
    try {
      await getSystemDb().insert(organizations).values({
        id: orgId,
        slug: orgId,
        name: "Native replica proof",
        createdAt: new Date(),
      })
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId,
          slug: "context",
          displayName: "Context",
          workspaceRepositoryUrl: "https://example.test/context.git",
        }),
      )
      const first = start("write")
      const second = start("ensure")
      await Promise.all([ready(first), ready(second)])
      first.child.stdin.end("go\n")
      second.child.stdin.end("go\n")
      const [a, b] = await Promise.all([result(first), result(second)])
      expect(a.id).toBeTruthy()
      expect(b.id).toBe(a.id)
      const restarted = start("read")
      await ready(restarted)
      restarted.child.stdin.end("go\n")
      expect(await result(restarted)).toEqual({
        id: a.id,
        contents: "survives-backend-restart",
      })
      const destroyer = start("destroy")
      await ready(destroyer)
      destroyer.child.stdin.end("go\n")
      expect(await destroyer.exited, destroyer.errors()).toBe(0)
      expect(destroyer.output()).toContain("destroyed")
      expect(await provider.resume({ id: a.id })).toBeNull()
    } finally {
      for (const client of clients) {
        if (client.child.exitCode === null && client.child.signalCode === null)
          client.child.kill("SIGKILL")
        await client.exited
      }
      for (const name of names) await provider.destroy({ id: name })
      await withOrgDbContext(orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
      )
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
      await closeDb()
    }
  },
)

it(
  "forks clean native base state across threads and replicas without sharing credentials",
  { timeout: 90_000 },
  async () => {
    const observedBootstrapCredentials: unknown[] = []
    const images = new Set<string>()
    const docker = new Dockerode()
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      observedBootstrapCredentials.push(
        JSON.parse(Buffer.concat(chunks).toString()),
      )
      res.end("ok")
    })
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Fixture port unavailable")
    const report = `fetch('http://host.docker.internal:${address.port}', {method:'POST',body:JSON.stringify(process.env.FIXTURE_TOKEN ?? null)}).then(r=>{if(!r.ok)process.exit(1)})`
    const setup = [
      `node -e '${report.replace(/'/g, "'\\''")}'`,
      "printf '%s' 'clean base bytes' > marker.txt",
    ]
    try {
      await withNativeChatFixture(async (f) => {
        await writeFile(
          join(f.directory, "README.md"),
          "Unselected newer remote revision\n",
        )
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-am",
            "Advance beyond captured revision",
          ],
          { cwd: f.directory },
        )
        await withNativeGitRemote(f.directory, async (remote) => {
          const store = postgresSandboxInstanceStore({
            orgId: f.orgId,
            workspaceId: f.workspaceId,
          })
          const config = {
            id: "native-shared-base",
            provider: dockerSandbox(WORKSPACE_CHAT_DOCKER_SANDBOX),
            lifecycle: {
              reuse: "thread" as const,
              snapshot: "after-setup" as const,
              baseSnapshot: true,
            },
          }
          const definition = defineSandbox(config)
          const common = {
            runId: "base-proof",
            store,
            locks: postgresSandboxLocks(
              f.orgId,
              undefined,
              `workspace-sandboxes:${f.workspaceId}`,
            ),
            tenant: { orgId: f.orgId },
          }
          const workspace = {
            identity: "captured-revision-and-image",
            source: {
              type: "git" as const,
              url: remote,
              ref: "main",
              commit: f.sha,
            },
            setup,
            threadSetup: ["printf '%s' \"$FIXTURE_TOKEN\" > /tmp/thread-token"],
            secrets: createSecrets({ FIXTURE_TOKEN: "credential-a" }),
          }
          try {
            const first = await definition.ensure({
              ...common,
              threadId: "thread-a",
              workspace,
            })
            expect(await first.fs.read("/workspace/README.md")).toBe(
              "# Native chat workspace\n",
            )
            expect(await first.fs.read("/tmp/thread-token")).toBe(
              "credential-a",
            )
            await first.fs.write("/workspace/marker.txt", "thread a edit")
            const second = await definition.ensure({
              ...common,
              threadId: "thread-b",
              workspace: {
                ...workspace,
                secrets: createSecrets({ FIXTURE_TOKEN: "credential-b" }),
              },
            })
            expect(await second.fs.read("/tmp/thread-token")).toBe(
              "credential-b",
            )
            expect(first.id).not.toBe(second.id)
            expect(await second.fs.read("/workspace/marker.txt")).toBe(
              "clean base bytes",
            )
            expect(
              (
                await first.process.exec("printenv FIXTURE_TOKEN")
              ).stdout.trim(),
            ).toBe("credential-a")
            expect(
              (
                await second.process.exec("printenv FIXTURE_TOKEN")
              ).stdout.trim(),
            ).toBe("credential-b")
            const replica = defineSandbox({
              ...config,
              provider: dockerSandbox(WORKSPACE_CHAT_DOCKER_SANDBOX),
            })
            const third = await replica.ensure({
              ...common,
              threadId: "thread-c",
              workspace,
            })
            expect(await third.fs.read("/workspace/marker.txt")).toBe(
              "clean base bytes",
            )
            expect(observedBootstrapCredentials).toEqual([null])
          } finally {
            for (const row of await listSandboxInstances({
              workspaceId: f.workspaceId,
            })) {
              if (row.latestSnapshotId) images.add(row.latestSnapshotId)
            }
          }
        })
      })
      for (const id of images) {
        await expect(docker.getImage(id).inspect()).rejects.toMatchObject({
          statusCode: 404,
        })
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      for (const id of images) {
        await docker
          .getImage(id)
          .remove()
          .catch((error: unknown) => {
            if (
              !(
                typeof error === "object" &&
                error !== null &&
                "statusCode" in error &&
                error.statusCode === 404
              )
            )
              throw error
          })
      }
    }
  },
)

it(
  "collects an obsolete base only after its last thread releases the image",
  { timeout: 60_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const definition = defineSandbox({
        id: "native-base-gc",
        provider: dockerSandbox({ image: WORKSPACE_CHAT_DOCKER_SANDBOX.image }),
        lifecycle: {
          reuse: "thread",
          snapshot: "after-setup",
          baseSnapshot: true,
        },
      })
      const context = {
        tenant: { orgId: f.orgId },
        store: postgresSandboxInstanceStore({
          orgId: f.orgId,
          workspaceId: f.workspaceId,
        }),
        locks: postgresSandboxLocks(
          f.orgId,
          undefined,
          `workspace-sandboxes:${f.workspaceId}`,
        ),
      }
      const firstContext = {
        ...context,
        threadId: `${f.conversationId}-one`,
        runId: "base-one",
        workspace: {
          identity: "base-one",
          source: { type: "none" as const },
          setup: ["printf first > marker.txt"],
        },
      }
      const first = await definition.ensure(firstContext)
      const second = await definition.ensure({
        ...context,
        threadId: `${f.conversationId}-two`,
        runId: "base-two",
        workspace: {
          identity: "base-two",
          source: { type: "none" as const },
          setup: ["printf second > marker.txt"],
        },
      })
      expect(
        await collectUnusedWorkspaceChatBases(f.orgId, f.workspaceId),
      ).toBe(0)
      expect(await first.fs.read("marker.txt")).toBe("first")
      await definition.destroy(firstContext)
      expect(
        await collectUnusedWorkspaceChatBases(f.orgId, f.workspaceId),
      ).toBe(1)
      expect(await second.fs.read("marker.txt")).toBe("second")
    })
  },
)

it(
  "retains the current immutable image base and collects a stale image base",
  { timeout: 60_000 },
  async () => {
    const docker = new Dockerode()
    const previousImage = process.env.SANDBOX_CHAT_IMAGE
    try {
      const image = (
        await docker.getImage(WORKSPACE_CHAT_DOCKER_SANDBOX.image).inspect()
      ).Id
      process.env.SANDBOX_CHAT_IMAGE = image
      await withNativeChatFixture(async (f) => {
        const oldStore = postgresSandboxInstanceStore({
          orgId: f.orgId,
          workspaceId: f.workspaceId,
          image,
        })
        const oldDefinition = defineSandbox({
          id: "native-old-image-base",
          provider: dockerSandbox(WORKSPACE_CHAT_DOCKER_SANDBOX),
          lifecycle: {
            reuse: "thread",
            snapshot: "after-setup",
            baseSnapshot: true,
          },
        })
        const oldContext = {
          tenant: { orgId: f.orgId },
          store: oldStore,
          locks: postgresSandboxLocks(
            f.orgId,
            undefined,
            `workspace-sandboxes:${f.workspaceId}`,
          ),
          threadId: `${f.conversationId}-old-image`,
          runId: "old-image-base",
          workspace: {
            identity: "old-image-base",
            source: { type: "none" as const },
            setup: ["printf old > marker.txt"],
          },
        }
        const oldFork = await oldDefinition.ensure(oldContext)
        const oldBase = (
          await listSandboxInstances({
            workspaceId: f.workspaceId,
            kind: "chat",
          })
        ).find((row) => row.id.startsWith("base:") && !row.conversationId)
        if (!oldBase?.latestSnapshotId)
          throw new Error("Native image GC base snapshot was not persisted")
        await oldDefinition.destroy(oldContext)
        expect(
          await collectUnusedWorkspaceChatBases(f.orgId, f.workspaceId),
        ).toBe(0)
        await persistSandboxInstance({ ...oldBase, image: "old-base-image" })

        const currentDefinition = defineSandbox({
          id: "native-current-image-worktree",
          provider: dockerSandbox(WORKSPACE_CHAT_DOCKER_SANDBOX),
          lifecycle: { reuse: "thread", snapshot: "after-setup" },
        })
        const current = await currentDefinition.ensure({
          tenant: { orgId: f.orgId },
          store: postgresSandboxInstanceStore({
            orgId: f.orgId,
            workspaceId: f.workspaceId,
            image,
          }),
          locks: postgresSandboxLocks(
            f.orgId,
            undefined,
            `workspace-sandboxes:${f.workspaceId}`,
          ),
          threadId: `${f.conversationId}-current-image`,
          runId: "current-image-worktree",
          workspace: {
            identity: "current-image-worktree",
            source: { type: "none" as const },
            setup: ["printf current > marker.txt"],
          },
        })
        expect(await current.fs.read("marker.txt")).toBe("current")

        expect(
          await collectUnusedWorkspaceChatBases(f.orgId, f.workspaceId),
        ).toBe(1)
        expect(
          (await listSandboxInstances({ workspaceId: f.workspaceId })).some(
            (row) => row.id === oldBase.id,
          ),
        ).toBe(false)
        expect(
          (await listSandboxInstances({ workspaceId: f.workspaceId })).some(
            (row) => row.providerSandboxId === current.id,
          ),
        ).toBe(true)
        expect(await current.fs.read("marker.txt")).toBe("current")
        await expect(
          docker.getImage(oldBase.latestSnapshotId).inspect(),
        ).rejects.toMatchObject({ statusCode: 404 })

        // Keep the handle live until the fixture's native cleanup observes it.
        expect(oldFork.id).toBeTruthy()
      })
    } finally {
      if (previousImage === undefined) delete process.env.SANDBOX_CHAT_IMAGE
      else process.env.SANDBOX_CHAT_IMAGE = previousImage
    }
  },
)
