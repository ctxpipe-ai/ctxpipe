import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { finished } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import Docker from "dockerode"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  getWorkspaceById,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { withNativeHttpsGitFixture } from "../../test/native-https-git-fixture.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import {
  WORKSPACE_CHAT_DOCKER_SANDBOX,
  workspaceChatRuntimeConfig,
} from "./chat-runtime.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import {
  streamTanstackWorkspaceChat,
  warmTanstackWorkspaceChat,
} from "./tanstack-workspace-chat.js"
import { resolveWorkspaceChatTurnRuntime } from "./workspace-chat-turn-runtime.js"
import { destroySandboxesForConversation } from "./workspace-sandbox-cleanup.js"

it(
  "rejects locked sbx without allocating a weaker fallback",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      process.env.SANDBOX_PROVIDER = "sbx"
      const result = await warmTanstackWorkspaceChat({
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      })
      expect(result).toEqual({
        ok: false,
        status: 503,
        error:
          "The sbx adapter cannot enforce the required 4 GiB disk and 128 PID limits. Workspace chat is unavailable for this provider.",
      })
      expect(f.modelRequests).toHaveLength(0)
      expect(
        await withOrgDbContext(f.orgId, () =>
          listSandboxInstances({
            conversationId: f.conversationId,
            kind: "chat",
          }),
        ),
      ).toEqual([])
    })
  },
)

it(
  "fails closed for railway without a production provider",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      process.env.SANDBOX_PROVIDER = "railway"
      const result = await warmTanstackWorkspaceChat({
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      })
      expect(result).toEqual({
        ok: false,
        status: 503,
        error: "TanStack sandbox provider railway is not available",
      })
      expect(f.modelRequests).toHaveLength(0)
      expect(
        await withOrgDbContext(f.orgId, () =>
          listSandboxInstances({
            conversationId: f.conversationId,
            kind: "chat",
          }),
        ),
      ).toEqual([])
    })
  },
)

it.each(["railway", "docker"] as const)(
  "fails closed for unavailable locked %s without sandbox allocation",
  { timeout: 30_000 },
  async (provider) => {
    await withNativeChatFixture(async (f) => {
      const previousImage = process.env.SANDBOX_CHAT_IMAGE
      process.env.SANDBOX_PROVIDER = provider
      process.env.SANDBOX_CHAT_IMAGE = `ctxpipe-missing-${f.orgId}:unavailable`
      try {
        const result = await warmTanstackWorkspaceChat({
          conversationId: f.conversationId,
          orgId: f.orgId,
          orgSlug: f.orgSlug,
          workspaceId: f.workspaceId,
          desiredUrl: "https://github.com/ctxpipe-ai/ctxpipe.git",
          desiredSha: f.sha,
          defaultBranch: "main",
          writeStatus: "read_only",
          prompt: "prepare",
        })
        expect(result).toMatchObject({ ok: false, status: 503 })
        expect(f.modelRequests).toHaveLength(0)
        expect(
          await withOrgDbContext(f.orgId, () =>
            listSandboxInstances({
              conversationId: f.conversationId,
              kind: "chat",
            }),
          ),
        ).toEqual([])
      } finally {
        if (previousImage === undefined) delete process.env.SANDBOX_CHAT_IMAGE
        else process.env.SANDBOX_CHAT_IMAGE = previousImage
      }
    })
  },
)

it(
  "prepare preserves the native worktree while refreshing its credentials",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture({}, async (f) => {
      const previous = process.env.SANDBOX_PROVIDER
      process.env.SANDBOX_PROVIDER = "unsandboxed"
      const conversationId = `conv_${f.id}`
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(conversations).values({
          id: conversationId,
          orgId: f.org.id,
          workspaceId: f.workspaceId,
        }),
      )
      const input = {
        conversationId,
        orgId: f.org.id,
        orgSlug: f.org.slug,
        workspaceId: f.workspaceId,
        desiredUrl: f.remote,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }
      try {
        await withOrgIdContext(f.org, () =>
          withTestLogger(async () => {
            const firstResult = await warmTanstackWorkspaceChat({
              ...input,
            })
            if (!firstResult.ok) throw new Error(firstResult.error)
            const first = firstResult.handle
            await first.fs.write("unsaved.txt", "preserve unsaved work")
            const secondResult = await warmTanstackWorkspaceChat({
              ...input,
              cloneToken: "fixture-token-b",
            })
            if (!secondResult.ok) throw new Error(secondResult.error)
            const second = secondResult.handle
            expect(second?.id).toBe(first.id)
            expect(await second?.fs.read("unsaved.txt")).toBe(
              "preserve unsaved work",
            )
            expect(
              (
                await second?.process.exec("printenv CTXPIPE_CLONE_TOKEN")
              )?.stdout.trim(),
            ).toBe("fixture-token-b")
            const changed = await warmTanstackWorkspaceChat({
              ...input,
              desiredGeneration: 2,
              cloneToken: "fixture-token-b",
            })
            if (!changed.ok) throw new Error(changed.error)
            expect(changed.handle.id).not.toBe(first.id)
            expect(await first.fs.read("unsaved.txt")).toBe(
              "preserve unsaved work",
            )
          }),
        )
      } finally {
        await withOrgIdContext(f.org, () =>
          destroySandboxesForConversation(conversationId),
        )
        await withOrgDbContext(f.org.id, (db) =>
          db.delete(conversations).where(eq(conversations.id, conversationId)),
        )
        if (previous === undefined) delete process.env.SANDBOX_PROVIDER
        else process.env.SANDBOX_PROVIDER = previous
      }
    })
  },
)

it.each(["conversation", "workspace"] as const)(
  "%s deletion fences a first allocation that has not persisted its handle",
  { timeout: 45_000 },
  async (scope) => {
    await withNativeChatFixture(async (f) => {
      const input = {
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }
      const original = await warmTanstackWorkspaceChat(input)
      if (!original.ok) throw new Error(original.error)
      const rows = await withOrgDbContext(f.orgId, () =>
        listSandboxInstances({ conversationId: f.conversationId }),
      )
      const key = rows[0]?.id
      if (!key) throw new Error("Native sandbox key missing")
      await destroySandboxesForConversation(f.conversationId)
      let release!: () => void
      let ready!: () => void
      const entered = new Promise<void>((resolve) => {
        ready = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const holding = postgresSandboxLocks(f.orgId).withLock(
        `sandbox:${key}`,
        async () => {
          ready()
          await barrier
        },
      )
      await entered
      const preparing = warmTanstackWorkspaceChat(input)
      // The native key barrier prevents provider creation while DELETE races.
      const deleting =
        scope === "conversation"
          ? f.request(`/conversations/${f.conversationId}`, {
              method: "DELETE",
            })
          : f.request("/workspaces/context", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ confirmName: "Context" }),
            })
      try {
        await new Promise((resolve) => setTimeout(resolve, 100))
      } finally {
        release()
      }
      await holding
      const [prepared, deleted] = await Promise.all([preparing, deleting])
      expect(deleted.status).toBe(204)
      expect(
        await withOrgDbContext(f.orgId, () =>
          listSandboxInstances({ conversationId: f.conversationId }),
        ),
      ).toEqual([])
      if (prepared.ok)
        expect(await prepared.handle.fs.exists("README.md")).toBe(false)
      const afterDelete = await warmTanstackWorkspaceChat(input)
      expect(afterDelete.ok).toBe(false)
    })
  },
)

it(
  "prepares the captured SHA when the remote default branch has advanced",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      await writeFile(
        join(f.directory, "README.md"),
        "# Newer unselected revision\n",
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
          "Advance default branch",
        ],
        { cwd: f.directory },
      )
      const prepared = await warmTanstackWorkspaceChat({
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      })
      if (!prepared.ok) throw new Error(prepared.error)
      expect(
        (
          await prepared.handle.process.exec("git rev-parse HEAD")
        ).stdout.trim(),
      ).toBe(f.sha)
      expect(await prepared.handle.fs.read("README.md")).toBe(
        "# Native chat workspace\n",
      )
    })
  },
)

it(
  "prepare discovers quota Docker and reuses its HTTPS-cloned isolated worktree",
  { timeout: 300_000 },
  async () => {
    const quotaHost = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST?.trim()
    const quotaPort = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!quotaHost || !Number.isInteger(quotaPort) || quotaPort < 1)
      throw new Error(
        "CTXPIPE_TEST_QUOTA_DOCKER_HOST and CTXPIPE_TEST_QUOTA_DOCKER_PORT are required",
      )
    const previous = Object.fromEntries(
      [
        "DOCKER_HOST",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
        "SANDBOX_CHAT_IMAGE",
      ].map((key) => [key, process.env[key]]),
    )
    process.env.DOCKER_HOST = `tcp://${quotaHost}:${quotaPort}`
    delete process.env.DOCKER_TLS_VERIFY
    delete process.env.DOCKER_CERT_PATH
    const docker = new Docker({ timeout: 30_000 })
    try {
      await docker.getImage(WORKSPACE_CHAT_DOCKER_SANDBOX.image).inspect()
      await withNativeHttpsGitFixture(
        {
          baseImage:
            process.env.CTXPIPE_TEST_CHAT_SANDBOX_IMAGE?.trim() ||
            "ctxpipe-chat-sandbox:opencode-1.18.18",
          docker,
        },
        async (gitFixture) => {
          process.env.SANDBOX_CHAT_IMAGE = gitFixture.image
          await withNativeChatFixture(async (f) => {
            delete process.env.SANDBOX_PROVIDER
            await gitFixture.serve(f.directory, async (remote) => {
              let phase = "first prepare"
              try {
                const parsedRemote = new URL(remote.url)
                expect(parsedRemote.protocol).toBe("https:")
                expect(parsedRemote.username).toBe("")
                expect(parsedRemote.password).toBe("")
                expect(parsedRemote.search).toBe("")
                const input = {
                  conversationId: f.conversationId,
                  orgId: f.orgId,
                  orgSlug: f.orgSlug,
                  workspaceId: f.workspaceId,
                  desiredUrl: remote.url,
                  desiredSha: f.sha,
                  defaultBranch: "main",
                  writeStatus: "read_only",
                  prompt: "prepare",
                }
                const first = await warmTanstackWorkspaceChat(input)
                if (!first.ok) throw new Error(first.error)
                expect(
                  (await first.handle.process.exec("uname -s")).stdout.trim(),
                ).toBe("Linux")
                expect(
                  (await first.handle.process.exec("printenv HOME PATH")).stdout
                    .trim()
                    .split("\n"),
                ).toEqual([
                  `/home/node/ctxpipe-opencode/${f.conversationId}`,
                  "/usr/local/bin:/usr/bin:/bin",
                ])
                expect(
                  (
                    await first.handle.process.exec("git remote get-url origin")
                  ).stdout.trim(),
                ).toBe(remote.url)
                const container = await docker
                  .getContainer(first.handle.id)
                  .inspect()
                expect(container.Config.User).toBe("1000:1000")
                expect(container.HostConfig).toMatchObject({
                  NanoCpus: 1_000_000_000,
                  Memory: 1024 ** 3,
                  MemorySwap: 1024 ** 3,
                  PidsLimit: 128,
                  StorageOpt: { size: "4G" },
                  CapDrop: ["ALL"],
                  SecurityOpt: ["no-new-privileges:true"],
                })
                expect(await first.handle.fs.read("/workspace/README.md")).toBe(
                  "# Native chat workspace\n",
                )
                await first.handle.fs.write(
                  "/workspace/unsaved.txt",
                  "Docker worktree survives prepare",
                )
                phase = "reuse prepare"
                const second = await warmTanstackWorkspaceChat(input)
                if (!second.ok) throw new Error(second.error)
                expect(second.handle.id).toBe(first.handle.id)
                expect(
                  await second.handle.fs.read("/workspace/unsaved.txt"),
                ).toBe("Docker worktree survives prepare")
                await writeFile(
                  join(f.directory, "README.md"),
                  "# Docker revision advanced\n",
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
                    "Advance Docker source",
                  ],
                  { cwd: f.directory },
                )
                phase = "HTTPS Git fixture update"
                await remote.sync()
                const sha = execFileSync("git", ["rev-parse", "HEAD"], {
                  cwd: f.directory,
                  encoding: "utf8",
                }).trim()
                await withOrgDbContext(f.orgId, (db) =>
                  db
                    .update(workspaces)
                    .set({ desiredSha: sha })
                    .where(eq(workspaces.id, f.workspaceId)),
                )
                phase = "revision prepare"
                const advanced = await warmTanstackWorkspaceChat({
                  ...input,
                  desiredSha: sha,
                })
                if (!advanced.ok) throw new Error(advanced.error)
                expect(advanced.handle.id).toBe(first.handle.id)
                expect(
                  await advanced.handle.fs.read("/workspace/unsaved.txt"),
                ).toBe("Docker worktree survives prepare")
                // Simulate provider loss while the exact native record survives.
                phase = "provider loss"
                await advanced.handle.destroy()
                phase = "provider recovery"
                const recovered = await warmTanstackWorkspaceChat({
                  ...input,
                  desiredSha: sha,
                })
                if (!recovered.ok) throw new Error(recovered.error)
                expect(recovered.handle.id).not.toBe(first.handle.id)
                expect(
                  await recovered.handle.fs.read("/workspace/README.md"),
                ).toBe("# Docker revision advanced\n")
                expect(
                  await recovered.handle.fs.exists("/workspace/unsaved.txt"),
                ).toBe(false)
                expect(
                  (
                    await recovered.handle.process.exec(
                      "git branch --show-current",
                    )
                  ).stdout.trim(),
                ).toBe("main")
              } catch (error) {
                throw new Error(
                  `Docker prepare fixture ${phase} failed: ${String(error)}`,
                  { cause: error },
                )
              }
            })
          })
        },
      )
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)

it(
  "quota Docker chat turn reaches the production model broker and Git remote",
  { timeout: 300_000 },
  async () => {
    const quotaHost = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST?.trim()
    const quotaPort = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!quotaHost || !Number.isInteger(quotaPort) || quotaPort < 1)
      throw new Error(
        "CTXPIPE_TEST_QUOTA_DOCKER_HOST and CTXPIPE_TEST_QUOTA_DOCKER_PORT are required",
      )
    const previous = Object.fromEntries(
      [
        "DOCKER_HOST",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
        "SANDBOX_CHAT_IMAGE",
        "SANDBOX_MODEL_PROXY_HOST",
      ].map((key) => [key, process.env[key]]),
    )
    process.env.DOCKER_HOST = `tcp://${quotaHost}:${quotaPort}`
    delete process.env.DOCKER_TLS_VERIFY
    delete process.env.DOCKER_CERT_PATH
    const docker = new Docker({ timeout: 30_000 })
    try {
      await docker.getImage(WORKSPACE_CHAT_DOCKER_SANDBOX.image).inspect()
      await withNativeHttpsGitFixture(
        {
          baseImage:
            process.env.CTXPIPE_TEST_CHAT_SANDBOX_IMAGE?.trim() ||
            "ctxpipe-chat-sandbox:opencode-1.18.18",
          docker,
        },
        async (gitFixture) => {
          process.env.SANDBOX_CHAT_IMAGE = gitFixture.image
          await withNativeChatFixture(
            async (f) => {
              delete process.env.SANDBOX_PROVIDER
              const listenPort = Number(process.env.PORT)
              if (!Number.isInteger(listenPort) || listenPort < 1)
                throw new Error("Native chat fixture PORT missing")
              const destHost = ghaReachableIpv4()
              await nestedBridgeGateway(docker)
              const relay = await startNestedModelRelay({
                docker,
                destHost,
                destPort: listenPort,
                listenPort,
              })
              process.env.SANDBOX_MODEL_PROXY_HOST = "host.docker.internal"
              try {
                await gitFixture.serve(f.directory, async (remote) => {
                  let phase = "first prepare"
                  try {
                    const input = {
                      conversationId: f.conversationId,
                      orgId: f.orgId,
                      orgSlug: f.orgSlug,
                      workspaceId: f.workspaceId,
                      desiredUrl: remote.url,
                      desiredSha: f.sha,
                      defaultBranch: "main",
                      writeStatus: "read_only" as const,
                    }
                    const first = await warmTanstackWorkspaceChat({
                      ...input,
                      prompt: "prepare",
                    })
                    if (!first.ok) throw new Error(first.error)
                    const container = await docker
                      .getContainer(first.handle.id)
                      .inspect()
                    expect(container.HostConfig).toMatchObject({
                      NanoCpus: 1_000_000_000,
                      Memory: 1024 ** 3,
                      MemorySwap: 1024 ** 3,
                      PidsLimit: 128,
                      StorageOpt: { size: "4G" },
                    })
                    await first.handle.fs.write(
                      "/workspace/unsaved.txt",
                      "Docker chat preserves unsaved work",
                    )
                    phase = "first chat"
                    const firstEvents: string[] = []
                    let firstText = ""
                    for await (const chunk of streamTanstackWorkspaceChat({
                      ...input,
                      prompt: "First question",
                      runId: `${f.conversationId}-quota-chat-1`,
                      messages: [
                        {
                          id: "user-quota-chat-1",
                          role: "user",
                          content: "First question",
                        },
                      ],
                    })) {
                      firstEvents.push(chunk.type)
                      if (chunk.type === "TEXT_MESSAGE_CONTENT")
                        firstText += chunk.delta
                    }
                    expect(firstEvents).toContain("RUN_FINISHED")
                    expect(firstEvents).not.toContain("RUN_ERROR")
                    expect(firstText).toBe("Native reply completed.")
                    expect(f.modelRequests.length).toBeGreaterThanOrEqual(1)
                    expect(
                      await first.handle.fs.read("/workspace/unsaved.txt"),
                    ).toBe("Docker chat preserves unsaved work")
                    phase = "git ls-remote"
                    const remoteHeads = await first.handle.process.exec(
                      "git ls-remote --heads origin refs/heads/main",
                    )
                    expect(remoteHeads.exitCode).toBe(0)
                    expect(remoteHeads.stdout).toContain(f.sha)
                    phase = "provider loss"
                    await first.handle.destroy()
                    phase = "recovery prepare"
                    const recovered = await warmTanstackWorkspaceChat({
                      ...input,
                      prompt: "prepare",
                    })
                    if (!recovered.ok) throw new Error(recovered.error)
                    expect(recovered.handle.id).not.toBe(first.handle.id)
                    expect(
                      await recovered.handle.fs.exists(
                        "/workspace/unsaved.txt",
                      ),
                    ).toBe(false)
                    phase = "recovery chat"
                    const recoveredEvents: string[] = []
                    let recoveredText = ""
                    for await (const chunk of streamTanstackWorkspaceChat({
                      ...input,
                      prompt: "Second question",
                      runId: `${f.conversationId}-quota-chat-2`,
                      messages: [
                        {
                          id: "user-quota-chat-2",
                          role: "user",
                          content: "Second question",
                        },
                      ],
                    })) {
                      recoveredEvents.push(chunk.type)
                      if (chunk.type === "TEXT_MESSAGE_CONTENT")
                        recoveredText += chunk.delta
                    }
                    expect(recoveredEvents).toContain("RUN_FINISHED")
                    expect(recoveredEvents).not.toContain("RUN_ERROR")
                    expect(recoveredText).toBe("Native reply completed.")
                    expect(f.modelRequests.length).toBeGreaterThanOrEqual(2)
                  } catch (error) {
                    throw new Error(
                      `Docker chat fixture ${phase} failed: ${String(error)}`,
                      { cause: error },
                    )
                  }
                })
              } finally {
                await relay.stop()
              }
            },
            undefined,
            { listenHost: "0.0.0.0" },
          )
        },
      )
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)

it(
  "warm runtime uses its captured branch and cached repository credential without GitHub requests",
  { timeout: 60_000 },
  async () => {
    const requests: string[] = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        onGithubRequest: (method, url) => requests.push(`${method} ${url}`),
      },
      async (f) => {
        await f.publish()
        await withOrgIdContext(f.org, async () => {
          const workspace = await getWorkspaceById(f.workspaceId)
          if (!workspace) throw new Error("Workspace fixture missing")
          const input = {
            conversation: {
              id: "conv_warm",
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              lastBranch: "ctxpipe/chat/conv_warm/1",
            },
            workspace,
            env: parseEnv(process.env),
          }
          const cold = await resolveWorkspaceChatTurnRuntime(input)
          requests.length = 0
          const warm = await resolveWorkspaceChatTurnRuntime(input)
          expect(warm.defaultBranch).toBe("main")
          expect(warm.lastBranch).toBe("ctxpipe/chat/conv_warm/1")
          expect(warm.cloneRef).toBe(f.sha)
          expect(warm.desiredSha).toBe(f.sha)
          expect(warm.cloneToken).toBe("fixture-only-github-read-token")
          expect(warm).toEqual(cold)
          expect(requests).toEqual([])
        })
      },
    )
  },
)

it(
  "cold prepare restores a published branch and falls back when it was deleted",
  { timeout: 60_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const branch = `ctxpipe/chat/${f.conversationId}/1`
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: f.directory, encoding: "utf8" }).trim()
      const prepare = async () => {
        const response = await f.request(
          `/conversations/${f.conversationId}/prepare`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId: f.workspaceId }),
          },
        )
        expect(response.status).toBe(204)
        const result = await warmTanstackWorkspaceChat(
          {
            conversationId: f.conversationId,
            orgId: f.orgId,
            workspaceId: f.workspaceId,
            desiredUrl: f.directory,
            desiredSha: f.sha,
            defaultBranch: "main",
            writeStatus: "writable",
            prompt: "prepare",
          },
          { existingOnly: true },
        )
        if (!result.ok) throw new Error(result.error)
        return result.handle
      }
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "writable" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const initial = await prepare()
      expect(
        (await initial.process.exec("git branch --show-current")).stdout.trim(),
      ).toBe("main")
      git("checkout", "-b", branch)
      await writeFile(
        join(f.directory, "README.md"),
        "Published conversation content\n",
      )
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-am",
        "Published change",
      )
      git("checkout", "main")
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(conversations)
          .set({ lastBranch: branch })
          .where(eq(conversations.id, f.conversationId)),
      )
      await destroySandboxesForConversation(f.conversationId)
      const restored = await prepare()
      expect(
        (
          await restored.process.exec("git branch --show-current")
        ).stdout.trim(),
      ).toBe(branch)
      expect(await restored.fs.read("README.md")).toBe(
        "Published conversation content\n",
      )
      const restoredStatus = await f.request(
        `/conversations/${f.conversationId}/files/status`,
      )
      expect(restoredStatus.status).toBe(200)
      expect(await restoredStatus.json()).toMatchObject({
        branch,
        published: true,
      })
      await restored.fs.write("unsaved.txt", "warm changes survive")
      git("branch", "-D", branch)
      expect(await (await prepare()).fs.read("unsaved.txt")).toBe(
        "warm changes survive",
      )
      await destroySandboxesForConversation(f.conversationId)
      const fallback = await prepare()
      expect(
        (
          await fallback.process.exec("git branch --show-current")
        ).stdout.trim(),
      ).toBe("main")
      expect(await fallback.fs.read("README.md")).toBe(
        "# Native chat workspace\n",
      )
      expect(
        (
          await fallback.process.exec(
            `git show-ref --verify refs/heads/${branch}`,
          )
        ).exitCode,
      ).not.toBe(0)
      expect(git("branch", "--list", branch)).toBe("")
      const status = await f.request(
        `/conversations/${f.conversationId}/files/status`,
      )
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({ branch: "main" })
      const permissionInput = {
        writeStatus: "writable",
        currentBranch: branch,
        defaultBranch: "main",
        getCurrentBranch: async () =>
          (
            await fallback.process.exec("git branch --show-current")
          ).stdout.trim(),
      }
      const runtime = workspaceChatRuntimeConfig(permissionInput)
      expect(
        await runtime.onPermissionRequest({
          id: "default-commit",
          sessionID: "native",
          type: "bash",
          title: "git commit -am save",
        }),
      ).toBe("reject")
    })
  },
)

it(
  "advances a live default branch in place and preserves compatible uncommitted work",
  { timeout: 45_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const input = {
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }
      const first = await warmTanstackWorkspaceChat(input)
      if (!first.ok) throw new Error(first.error)
      await first.handle.fs.write("notes.txt", "Keep my uncommitted notes\n")
      await writeFile(join(f.directory, "README.md"), "# Updated workspace\n")
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-am",
          "Advance main",
        ],
        { cwd: f.directory },
      )
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: f.directory,
        encoding: "utf8",
      }).trim()
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: sha })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const second = await warmTanstackWorkspaceChat({
        ...input,
        desiredSha: sha,
      })
      if (!second.ok) throw new Error(second.error)
      expect(second.handle.id).toBe(first.handle.id)
      expect(
        (
          await second.handle.process.exec("git branch --show-current")
        ).stdout.trim(),
      ).toBe("main")
      expect(await second.handle.fs.read("README.md")).toBe(
        "# Updated workspace\n",
      )
      expect(await second.handle.fs.read("notes.txt")).toBe(
        "Keep my uncommitted notes\n",
      )
      expect(
        (
          await second.handle.process.exec("git status --porcelain")
        ).stdout.trim(),
      ).toBe("?? notes.txt")
      // A rewind is a real transition even though the target is already an
      // ancestor. Afterwards a queued request for the superseded tip cannot
      // move either the branch or native owner back to that tip.
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: f.sha })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const rewound = await warmTanstackWorkspaceChat(input)
      if (!rewound.ok) throw new Error(rewound.error)
      expect(rewound.handle.id).toBe(first.handle.id)
      expect(
        (await rewound.handle.process.exec("git rev-parse HEAD")).stdout.trim(),
      ).toBe(f.sha)
      expect(await rewound.handle.fs.read("notes.txt")).toBe(
        "Keep my uncommitted notes\n",
      )
      const superseded = await warmTanstackWorkspaceChat({
        ...input,
        desiredSha: sha,
      })
      expect(superseded).toMatchObject({
        ok: true,
        effectiveRevision: { sha: f.sha },
      })
      expect(
        (await first.handle.process.exec("git rev-parse HEAD")).stdout.trim(),
      ).toBe(f.sha)
      const events: string[] = []
      for await (const chunk of streamTanstackWorkspaceChat({
        ...input,
        desiredSha: sha,
        runId: `${f.conversationId}-queued-stale`,
        prompt: "Continue after the workspace rewind",
      }))
        events.push(chunk.type)
      expect(events).toContain("RUN_FINISHED")
      expect(events).not.toContain("RUN_ERROR")
      expect(JSON.stringify(f.modelRequests)).not.toContain(
        "workspace_revision_conflict",
      )
    })
  },
)

it.each(["main", "published"] as const)(
  "retains recoverable edits when %s conflicts with a new workspace tip",
  { timeout: 45_000 },
  async (branchKind) => {
    await withNativeChatFixture(async (f) => {
      const input = {
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }
      const first = await warmTanstackWorkspaceChat(input)
      if (!first.ok) throw new Error(first.error)
      const branch =
        branchKind === "published"
          ? `ctxpipe/chat/${f.conversationId}/1`
          : "main"
      if (branchKind === "published") {
        await first.handle.process.exec(`git checkout -b '${branch}'`)
      }
      await first.handle.fs.write("README.md", "# My conversation edit\n")
      if (branchKind === "published") {
        const committed = await first.handle.process.exec(
          "git add README.md && git -c user.name=Fixture -c user.email=fixture@example.test commit -m 'Conversation change'",
        )
        expect(committed.exitCode).toBe(0)
        const published = await first.handle.process.exec(
          `git push origin '${branch}'`,
        )
        expect(published.exitCode).toBe(0)
      }
      await first.handle.fs.write("notes.txt", "Keep these notes too\n")
      const original = (
        await first.handle.process.exec("git rev-parse HEAD")
      ).stdout.trim()
      await writeFile(
        join(f.directory, "README.md"),
        "# Conflicting new workspace\n",
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
          "Advance main",
        ],
        { cwd: f.directory },
      )
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: f.directory,
        encoding: "utf8",
      }).trim()
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: sha })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const second = await warmTanstackWorkspaceChat({
        ...input,
        desiredSha: sha,
      })
      expect(
        (
          await first.handle.process.exec("git branch --show-current")
        ).stdout.trim(),
      ).toBe(branch)
      if (branchKind === "published") {
        expect(second).toMatchObject({
          ok: true,
          effectiveRevision: { sha: f.sha },
        })
        expect(
          (await first.handle.process.exec("git rev-parse HEAD")).stdout.trim(),
        ).toBe(original)
        expect(await first.handle.fs.read("README.md")).toBe(
          "# My conversation edit\n",
        )
        expect(await first.handle.fs.read("notes.txt")).toBe(
          "Keep these notes too\n",
        )
        await withOrgDbContext(f.orgId, (db) =>
          db
            .update(workspaces)
            .set({ desiredSha: sha })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        const status = await f.request(
          `/conversations/${f.conversationId}/files/status`,
        )
        expect(status.status).toBe(200)
        expect(await status.json()).toMatchObject({
          branch,
          sha: f.sha,
          desiredSha: sha,
          stale: true,
        })
        const events: string[] = []
        for await (const chunk of streamTanstackWorkspaceChat({
          ...input,
          desiredSha: sha,
          prompt: "Help repair this branch",
          runId: `${f.conversationId}-repair`,
          messages: [
            {
              id: "repair-message",
              role: "user",
              content: "Help repair this branch",
            },
          ],
        }))
          events.push(chunk.type)
        expect(events.filter((type) => type === "RUN_FINISHED")).toHaveLength(1)
        expect(events).not.toContain("RUN_ERROR")
        expect(JSON.stringify(f.modelRequests)).toContain(
          "workspace_revision_conflict",
        )
        expect(JSON.stringify(f.modelRequests)).toContain(sha)

        expect(
          (await first.handle.process.exec("git rev-parse HEAD")).stdout.trim(),
        ).toBe(original)
      } else {
        expect(second.ok).toBe(true)
        expect(
          (await first.handle.process.exec("git rev-parse HEAD")).stdout.trim(),
        ).toBe(sha)
        expect(await first.handle.fs.read("README.md")).toBe(
          "# Conflicting new workspace\n",
        )
        expect(
          (await first.handle.process.exec("git show stash@{0}:README.md"))
            .stdout,
        ).toBe("# My conversation edit\n")
        expect(
          (await first.handle.process.exec("git show stash@{0}^3:notes.txt"))
            .stdout,
        ).toBe("Keep these notes too\n")
      }
    })
  },
)

it(
  "recovers a process lost after Git advanced but before its native record moved",
  { timeout: 90_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const input = {
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }
      const first = await warmTanstackWorkspaceChat(input)
      if (!first.ok) throw new Error(first.error)
      await first.handle.fs.write(
        "notes.txt",
        "Survives the interrupted transition\n",
      )
      await writeFile(
        join(f.directory, "README.md"),
        "# Revision after process loss\n",
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
          "Advance main",
        ],
        { cwd: f.directory },
      )
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: f.directory,
        encoding: "utf8",
      }).trim()
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: sha })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      let release!: () => void
      let entered!: () => void
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      // A real row lock blocks only the final native ownership move. Provider
      // IO runs in the separate process, with no held application transaction.
      const holding = withOrgDbContext(f.orgId, (db) =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM workspace_sandbox_instances WHERE conversation_id = ${f.conversationId} FOR UPDATE`,
          )
          entered()
          await barrier
        }),
      )
      await ready
      const child = spawn(
        "bun",
        [
          fileURLToPath(
            new URL(
              "../../test/native-chat-revision-client.ts",
              import.meta.url,
            ),
          ),
          f.orgId,
          f.workspaceId,
          f.conversationId,
          f.directory,
          sha,
        ],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      )
      let errors = ""
      child.stderr.on("data", (data) => {
        errors += String(data)
      })
      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", () => resolve())
      })
      try {
        const deadline = Date.now() + 20_000
        let completed = false
        while (Date.now() < deadline) {
          if (child.exitCode !== null)
            throw new Error(`Revision client exited before its move: ${errors}`)
          if (
            await first.handle.fs.exists(".git/ctxpipe-revision-transition")
          ) {
            const state = await first.handle.fs.read(
              ".git/ctxpipe-revision-transition",
            )
            if (
              typeof state === "string" &&
              state.split("\n")[4] === "complete"
            ) {
              completed = true
              break
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(completed).toBe(true)
      } finally {
        if (child.pid && child.exitCode === null)
          process.kill(-child.pid, "SIGKILL")
        await exited
        release()
        await holding
      }
      // The crashed owner's native lease expires; the next process/caller
      // resumes the completed Git phase and performs only the atomic move.
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: sha })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const second = await warmTanstackWorkspaceChat({
        ...input,
        desiredSha: sha,
      })
      if (!second.ok) throw new Error(second.error)
      expect(second.handle.id).toBe(first.handle.id)
      expect(await second.handle.fs.read("README.md")).toBe(
        "# Revision after process loss\n",
      )
      expect(await second.handle.fs.read("notes.txt")).toBe(
        "Survives the interrupted transition\n",
      )
      expect(
        (
          await second.handle.process.exec("git branch --show-current")
        ).stdout.trim(),
      ).toBe("main")
      expect(
        (await second.handle.process.exec("git stash list --format=%s")).stdout
          .trim()
          .split("\n"),
      ).toHaveLength(1)
    })
  },
)

it(
  "identifies a legacy live worktree instead of silently allocating over saved edits",
  { timeout: 45_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const input = {
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }
      const first = await warmTanstackWorkspaceChat(input)
      if (!first.ok) throw new Error(first.error)
      await first.handle.fs.write("notes.txt", "Pre-upgrade saved edits\n")
      const legacyId = `legacy-${f.conversationId}`
      // Fixture represents a pre-upgrade identity whose setup/image cannot
      // safely be inferred from the newly introduced transition metadata.
      await withOrgDbContext(f.orgId, (db) =>
        db.execute(sql`
        UPDATE workspace_sandbox_instances SET id = ${legacyId}, transition_key = NULL
        WHERE conversation_id = ${f.conversationId}
      `),
      )
      const resumed = await warmTanstackWorkspaceChat(input)
      expect(resumed.ok).toBe(false)
      if (resumed.ok) throw new Error("Legacy worktree was silently replaced")
      expect(resumed.status).toBe(409)
      expect(resumed.error).toContain(legacyId)
      expect(resumed.error).toContain(first.handle.id)
      expect(await first.handle.fs.read("notes.txt")).toBe(
        "Pre-upgrade saved edits\n",
      )
      const owners = await withOrgDbContext(f.orgId, () =>
        listSandboxInstances({
          conversationId: f.conversationId,
          kind: "chat",
          state: "live",
        }),
      )
      expect(owners).toHaveLength(1)
      expect(owners[0]?.id).toBe(legacyId)
    })
  },
)

it(
  "reconciles a newer workspace tip when Git completes before the ownership compare-and-swap",
  { timeout: 60_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const input = {
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }
      const first = await warmTanstackWorkspaceChat(input)
      if (!first.ok) throw new Error(first.error)
      await first.handle.fs.write(
        "notes.txt",
        "Retain across a superseded move\n",
      )
      const advance = async (body: string) => {
        await writeFile(join(f.directory, "README.md"), body)
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-am",
            "Advance main",
          ],
          { cwd: f.directory },
        )
        return execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: f.directory,
          encoding: "utf8",
        }).trim()
      }
      const middleSha = await advance("# Intermediate target\n")
      const newestSha = await advance("# Newest target\n")
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: middleSha })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      let release!: () => void
      let entered!: () => void
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      // MVCC readers see the middle target; only the final ownership CAS waits.
      const holding = withOrgDbContext(f.orgId, (db) =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM workspaces WHERE id = ${f.workspaceId} FOR UPDATE`,
          )
          entered()
          await barrier
          await tx
            .update(workspaces)
            .set({ desiredSha: newestSha })
            .where(eq(workspaces.id, f.workspaceId))
        }),
      )
      await ready
      const pending = warmTanstackWorkspaceChat({
        ...input,
        desiredSha: middleSha,
      })
      try {
        const deadline = Date.now() + 20_000
        let completed = false
        while (Date.now() < deadline) {
          if (
            await first.handle.fs.exists(".git/ctxpipe-revision-transition")
          ) {
            const state = await first.handle.fs.read(
              ".git/ctxpipe-revision-transition",
            )
            if (
              typeof state === "string" &&
              state.split("\n")[4] === "complete"
            ) {
              completed = true
              break
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(completed).toBe(true)
      } finally {
        release()
        await holding
      }
      expect(await pending).toMatchObject({ ok: false, status: 503 })
      const retained = await withOrgDbContext(f.orgId, () =>
        listSandboxInstances({
          conversationId: f.conversationId,
          kind: "chat",
          state: "live",
        }),
      )
      expect(retained).toHaveLength(1)
      expect(retained[0]?.revision?.sha).toBe(f.sha)
      const current = await warmTanstackWorkspaceChat({
        ...input,
        desiredSha: newestSha,
      })
      if (!current.ok) throw new Error(current.error)
      expect(current.handle.id).toBe(first.handle.id)
      expect(
        (await current.handle.process.exec("git rev-parse HEAD")).stdout.trim(),
      ).toBe(newestSha)
      expect(await current.handle.fs.read("README.md")).toBe(
        "# Newest target\n",
      )
      expect(await current.handle.fs.read("notes.txt")).toBe(
        "Retain across a superseded move\n",
      )
    })
  },
)

function ghaReachableIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== "IPv4" && entry.family !== 4) continue
      if (entry.address.startsWith("172.17.")) continue
      return entry.address
    }
  }
  throw new Error(
    "GHA has no non-docker0 IPv4 for the nested model relay destination",
  )
}

async function nestedBridgeGateway(docker: Docker): Promise<string> {
  const bridge = await docker.getNetwork("bridge").inspect()
  const gateway = bridge.IPAM?.Config?.[0]?.Gateway
  if (!gateway || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway))
    throw new Error("Nested Docker bridge gateway missing")
  return gateway
}

async function startNestedModelRelay(input: {
  docker: Docker
  destHost: string
  destPort: number
  listenPort: number
}): Promise<{ stop: () => Promise<void> }> {
  const container = await input.docker.createContainer({
    name: `ctxpipe-model-relay-${randomUUID()}`,
    Image: WORKSPACE_CHAT_DOCKER_SANDBOX.image,
    User: "1000:1000",
    Entrypoint: ["node"],
    Cmd: [
      "-e",
      `const net=require("node:net");net.createServer((client)=>{const dest=net.connect(${input.destPort},${JSON.stringify(input.destHost)});client.pipe(dest);dest.pipe(client);const close=()=>{client.destroy();dest.destroy()};dest.on("error",close);client.on("error",close)}).listen(${input.listenPort},"0.0.0.0")`,
    ],
    HostConfig: { NetworkMode: "host" },
    Labels: { "ai.ctxpipe.purpose": "native-model-relay" },
  })
  try {
    await container.start()
    await waitForNestedTcp(container, "127.0.0.1", input.listenPort)
    await waitForNestedTcp(container, input.destHost, input.destPort)
  } catch (error) {
    const logs = (await container.logs({ stdout: true, stderr: true }))
      .toString()
      .trim()
    await container.remove({ force: true, v: true }).catch(() => undefined)
    throw new Error(
      `Nested model relay failed: ${String(error)}; logs: ${logs || "<empty>"}`,
      { cause: error },
    )
  }
  return {
    async stop() {
      await container.remove({ force: true, v: true })
    },
  }
}

async function waitForNestedTcp(
  container: Docker.Container,
  host: string,
  port: number,
): Promise<void> {
  const deadline = Date.now() + 15_000
  while (true) {
    const execution = await container.exec({
      Cmd: [
        "node",
        "-e",
        `const socket=require("node:net").connect({host:${JSON.stringify(host)},port:${port}});socket.setTimeout(250);socket.once("connect",()=>{socket.destroy();process.exit(0)});socket.once("error",()=>process.exit(1));socket.once("timeout",()=>process.exit(1))`,
      ],
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await execution.start({ hijack: true })
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    container.modem.demuxStream(stream, stdout, stderr)
    await finished(stream)
    if ((await execution.inspect()).ExitCode === 0) return
    const info = await container.inspect()
    if (!info.State.Running)
      throw new Error(
        `Nested model relay exited before ${host}:${port} was reachable`,
      )
    if (Date.now() >= deadline)
      throw new Error(`Nested model relay did not reach ${host}:${port}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
