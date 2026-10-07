import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import Docker from "dockerode"
import { eq } from "drizzle-orm"
import { expect, it, vi } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
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
import { CHAT_SANDBOX_IDLE_STOP_MS } from "./chat-lifecycle.js"
import { SANDBOX_READ_GIT, workspaceChatRuntimeConfig } from "./chat-runtime.js"
import {
  stoppingSandboxWhenDone,
  sweepConversationSandboxes,
} from "./conversation-sandbox-lifecycle.js"
import { workspaceChatInstanceAccess } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import {
  streamTanstackWorkspaceChat,
  warmTanstackWorkspaceChat,
} from "./tanstack-workspace-chat.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import { advanceConversationWorktree } from "./workspace-chat-revision-transition.js"
import { resolveWorkspaceChatTurnRuntime } from "./workspace-chat-turn-runtime.js"
import { destroySandboxesForConversation } from "./workspace-sandbox-cleanup.js"

it(
  "rejects a retired provider lock without allocating a weaker fallback",
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
        error: 'Unknown SANDBOX_PROVIDER "sbx"',
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
  "fails closed for hosted Vercel without credentials",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      process.env.SANDBOX_PROVIDER = "vercel"
      delete process.env.VERCEL_TOKEN
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
        error: "Hosted chat sandboxes are not configured",
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
  "fails closed on Railway when the environment name is missing",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      process.env.SANDBOX_PROVIDER = "vercel"
      // Ids, so the credentials resolve without a Vercel call.
      vi.stubEnv("VERCEL_TOKEN", "test-token")
      vi.stubEnv("VERCEL_TEAM_ID", "team_test")
      vi.stubEnv("VERCEL_PROJECT_ID", "prj_test")
      vi.stubEnv("RAILWAY_PROJECT_ID", "railway-project")
      vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", undefined)
      try {
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
          error: "Hosted chat needs the Railway environment name",
        })
        expect(
          await withOrgDbContext(f.orgId, () =>
            listSandboxInstances({
              conversationId: f.conversationId,
              kind: "chat",
            }),
          ),
        ).toEqual([])
      } finally {
        vi.unstubAllEnvs()
      }
    })
  },
)

it.each(["vercel", "docker"] as const)(
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
  "retries Docker image inspection after a missing image",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      process.env.SANDBOX_PROVIDER = "docker"
      process.env.SANDBOX_CHAT_IMAGE = `ctxpipe-missing-${f.orgId}:unavailable`
      const input = {
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: "https://github.com/ctxpipe-ai/ctxpipe.git",
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only" as const,
        prompt: "prepare",
      }
      const first = await warmTanstackWorkspaceChat(input)
      expect(first).toMatchObject({ ok: false, status: 503 })
      const second = await warmTanstackWorkspaceChat(input)
      expect(second).toMatchObject({ ok: false, status: 503 })
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
  "prepare discovers Docker and keeps its HTTPS-cloned worktree while the default branch moves",
  { timeout: 300_000 },
  async () => {
    const previous = Object.fromEntries(
      ["SANDBOX_CHAT_IMAGE"].map((key) => [key, process.env[key]]),
    )
    const docker = new Docker({ timeout: 30_000 })
    try {
      await withNativeHttpsGitFixture(
        {
          baseImage:
            process.env.CTXPIPE_TEST_CHAT_SANDBOX_IMAGE?.trim() ||
            "ctxpipe-chat-sandbox:opencode-1.18.34",
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
                  (
                    await first.handle.process.exec("printenv HOME")
                  ).stdout.trim(),
                ).toBe(`/home/node/ctxpipe-opencode/${f.conversationId}`)
                expect(
                  (
                    await first.handle.process.exec("git remote get-url origin")
                  ).stdout.trim(),
                ).toBe(remote.url)
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
  "Docker chat turn reaches the production model broker and Git remote",
  { timeout: 300_000 },
  async () => {
    const previous = Object.fromEntries(
      ["SANDBOX_CHAT_IMAGE"].map((key) => [key, process.env[key]]),
    )
    const docker = new Docker({ timeout: 30_000 })
    try {
      await withNativeHttpsGitFixture(
        {
          baseImage:
            process.env.CTXPIPE_TEST_CHAT_SANDBOX_IMAGE?.trim() ||
            "ctxpipe-chat-sandbox:opencode-1.18.34",
          docker,
        },
        async (gitFixture) => {
          process.env.SANDBOX_CHAT_IMAGE = gitFixture.image
          await withNativeChatFixture(
            async (f) => {
              delete process.env.SANDBOX_PROVIDER
              await gitFixture.serve(f.directory, async (remote) => {
                let phase = "first prepare"
                try {
                  await withOrgDbContext(f.orgId, (db) =>
                    db
                      .update(workspaces)
                      .set({ workspaceRepositoryUrl: remote.url })
                      .where(eq(workspaces.id, f.workspaceId)),
                  )
                  const input = {
                    conversationId: f.conversationId,
                    orgId: f.orgId,
                    orgSlug: f.orgSlug,
                    workspaceId: f.workspaceId,
                    desiredUrl: remote.url,
                    desiredSha: f.sha,
                    defaultBranch: "main",
                    writeStatus: "read_only" as const,
                    // The turn runtime mints this read token for a GitHub
                    // repository. The fixture remote accepts any token.
                    cloneToken: "fixture-docker-read-token",
                  }
                  workspaceChatInstanceAccess.reset()
                  const first = await warmTanstackWorkspaceChat({
                    ...input,
                    prompt: "prepare",
                  })
                  if (!first.ok) throw new Error(first.error)
                  await first.handle.fs.write(
                    "/workspace/unsaved.txt",
                    "Docker chat preserves unsaved work",
                  )
                  phase = "first chat"
                  const persistence = workspaceChatPersistence()
                  const firstEvents: string[] = []
                  let firstText = ""
                  for await (const chunk of streamTanstackWorkspaceChat({
                    ...input,
                    prompt: "First question",
                    runId: `${f.conversationId}-docker-chat-1`,
                    messages: [
                      ...(await persistence.stores.messages.loadThread(
                        f.conversationId,
                      )),
                      {
                        id: "user-docker-chat-1",
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
                  // The agent's shell holds the read token, and the fetch the
                  // session_moved hint gives reads with it alone.
                  phase = "read credential"
                  const token = await first.handle.process.exec(
                    "printenv CTXPIPE_CLONE_TOKEN",
                  )
                  expect(token.stdout.trim()).toBe("fixture-docker-read-token")
                  const read = await first.handle.process.exec(
                    `GIT_TERMINAL_PROMPT=0 ${SANDBOX_READ_GIT} ls-remote --heads origin refs/heads/main`,
                  )
                  expect(read.stdout).toContain(f.sha)
                  phase = "warm chat"
                  const instanceCreatesBeforeWarm =
                    workspaceChatInstanceAccess.creates
                  const hitsBeforeWarm = workspaceChatInstanceAccess.hits
                  const modelRequestsBeforeWarm = f.modelRequests.length
                  const warmEvents: string[] = []
                  let warmText = ""
                  const warmStarted = Date.now()
                  for await (const chunk of streamTanstackWorkspaceChat({
                    ...input,
                    prompt: "Warm question",
                    runId: `${f.conversationId}-docker-chat-warm`,
                    messages: [
                      ...(await persistence.stores.messages.loadThread(
                        f.conversationId,
                      )),
                      {
                        id: "user-docker-chat-warm",
                        role: "user",
                        content: "Warm question",
                      },
                    ],
                  })) {
                    warmEvents.push(chunk.type)
                    if (chunk.type === "TEXT_MESSAGE_CONTENT")
                      warmText += chunk.delta
                  }
                  expect(Date.now() - warmStarted).toBeLessThan(30_000)
                  expect(warmEvents).toContain("RUN_FINISHED")
                  expect(warmEvents).not.toContain("RUN_ERROR")
                  expect(warmText).toBe("Native reply completed.")
                  expect(f.modelRequests.length).toBeGreaterThan(
                    modelRequestsBeforeWarm,
                  )
                  expect(workspaceChatInstanceAccess.creates).toBe(
                    instanceCreatesBeforeWarm,
                  )
                  expect(
                    workspaceChatInstanceAccess.hits - hitsBeforeWarm,
                  ).toBeGreaterThanOrEqual(1)
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
                    await recovered.handle.fs.exists("/workspace/unsaved.txt"),
                  ).toBe(false)
                  phase = "recovery chat"
                  const recoveredEvents: string[] = []
                  let recoveredText = ""
                  for await (const chunk of streamTanstackWorkspaceChat({
                    ...input,
                    prompt: "Second question",
                    runId: `${f.conversationId}-docker-chat-2`,
                    messages: [
                      ...(await persistence.stores.messages.loadThread(
                        f.conversationId,
                      )),
                      {
                        id: "user-docker-chat-2",
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
                  const containerRunning = async () =>
                    (await docker.getContainer(recovered.handle.id).inspect())
                      .State.Running
                  const chatTurn = async (name: string, unattended = false) => {
                    const events: string[] = []
                    let text = ""
                    const stream = streamTanstackWorkspaceChat({
                      ...input,
                      prompt: name,
                      runId: `${f.conversationId}-${name}`,
                      messages: [
                        ...(await persistence.stores.messages.loadThread(
                          f.conversationId,
                        )),
                        { id: `user-${name}`, role: "user", content: name },
                      ],
                    })
                    for await (const chunk of unattended
                      ? stoppingSandboxWhenDone(
                          { orgId: f.orgId, conversationId: f.conversationId },
                          stream,
                        )
                      : stream) {
                      events.push(chunk.type)
                      if (chunk.type === "TEXT_MESSAGE_CONTENT")
                        text += chunk.delta
                    }
                    expect(events).toContain("RUN_FINISHED")
                    expect(events).not.toContain("RUN_ERROR")
                    expect(text).toBe("Native reply completed.")
                  }
                  phase = "idle stop"
                  await recovered.handle.fs.write(
                    "/workspace/idle.txt",
                    "kept through the idle stop",
                  )
                  const swept = await sweepConversationSandboxes(
                    f.orgId,
                    new Date(Date.now() + CHAT_SANDBOX_IDLE_STOP_MS),
                  )
                  expect(swept.stopped).toBe(1)
                  expect(await containerRunning()).toBe(false)
                  phase = "chat after idle stop"
                  await chatTurn("after-idle")
                  expect(await containerRunning()).toBe(true)
                  const resumed = await warmTanstackWorkspaceChat({
                    ...input,
                    prompt: "prepare",
                  })
                  if (!resumed.ok) throw new Error(resumed.error)
                  expect(resumed.handle.id).toBe(recovered.handle.id)
                  expect(
                    await resumed.handle.fs.read("/workspace/idle.txt"),
                  ).toBe("kept through the idle stop")
                  phase = "unattended chat"
                  await chatTurn("unattended", true)
                  expect(await containerRunning()).toBe(false)
                  expect(
                    (
                      await withOrgDbContext(f.orgId, () =>
                        listSandboxInstances({
                          conversationId: f.conversationId,
                          kind: "chat",
                        }),
                      )
                    ).map((row) => row.state),
                  ).toEqual(["stopped"])
                } catch (error) {
                  throw new Error(
                    `Docker chat fixture ${phase} failed: ${String(error)}`,
                    { cause: error },
                  )
                }
              })
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
  "warm runtime uses its captured branch without GitHub requests",
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
          }
          const cold = await resolveWorkspaceChatTurnRuntime(input)
          requests.length = 0
          const samples: number[] = []
          let warm = cold
          for (let i = 0; i < 20; i += 1) {
            const started = Date.now()
            warm = await resolveWorkspaceChatTurnRuntime(input)
            samples.push(Date.now() - started)
          }
          expect(warm.defaultBranch).toBe("main")
          expect(warm.lastBranch).toBe("ctxpipe/chat/conv_warm/1")
          expect(warm.cloneRef).toBe(f.sha)
          expect(warm.desiredSha).toBe(f.sha)
          expect(warm).toEqual(cold)
          expect(requests).toEqual([])
          const ranked = [...samples].sort((left, right) => left - right)
          expect(ranked[Math.floor((ranked.length - 1) * 0.95)]).toBeLessThan(
            5_000,
          )
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
  "recovers a process lost after Git advanced but before its sandbox record moved",
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
      // A process finishes the Git update, then dies before recording the
      // sandbox's new commit.
      const [row] = await withOrgDbContext(f.orgId, () =>
        listSandboxInstances({
          conversationId: f.conversationId,
          kind: "chat",
          state: "live",
        }),
      )
      if (!row?.revision) throw new Error("Sandbox row missing")
      expect(
        await advanceConversationWorktree({
          handle: first.handle,
          from: row.revision,
          to: { ...row.revision, sha },
        }),
      ).toBe("moved")
      const state = await first.handle.fs.read(
        ".git/ctxpipe-revision-transition",
      )
      expect(state.split("\n")[4]).toBe("complete")
      // The next caller resumes the completed Git phase and only records it.
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
  "moves through an intermediate target to a newer tip and never back",
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
      const middle = await warmTanstackWorkspaceChat({
        ...input,
        desiredSha: middleSha,
      })
      if (!middle.ok) throw new Error(middle.error)
      expect(middle).not.toHaveProperty("effectiveRevision")
      const [recorded] = await withOrgDbContext(f.orgId, () =>
        listSandboxInstances({
          conversationId: f.conversationId,
          kind: "chat",
          state: "live",
        }),
      )
      expect(recorded?.revision?.sha).toBe(middleSha)
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: newestSha })
          .where(eq(workspaces.id, f.workspaceId)),
      )
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
      // A queued request for the superseded target never moves it back.
      const stale = await warmTanstackWorkspaceChat({
        ...input,
        desiredSha: middleSha,
      })
      expect(stale).toMatchObject({
        ok: true,
        effectiveRevision: { sha: newestSha },
      })
      expect(
        (await current.handle.process.exec("git rev-parse HEAD")).stdout.trim(),
      ).toBe(newestSha)
    })
  },
)
