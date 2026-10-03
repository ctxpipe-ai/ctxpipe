import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { chat, defineChatMiddleware, type StreamChunk } from "@tanstack/ai"
import {
  provideSandbox,
  SandboxCapability,
  type SandboxHandle,
} from "@tanstack/ai-sandbox"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { getConversation } from "../../models/conversations.js"
import { conversationRoutes } from "../../routes/v1/conversations.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import { conversationSessionBranch } from "./chat-lifecycle.js"
import { warmTanstackWorkspaceChat } from "./tanstack-workspace-chat.js"
import {
  WORKSPACE_CHAT_SESSION_PUSH_EVENT,
  workspaceChatSessionPush,
} from "./workspace-chat-session-push.js"
import { destroySandboxesForConversation } from "./workspace-sandbox-cleanup.js"

/**
 * The agent is the environment here: a scripted adapter edits the sandbox the
 * way OpenCode would and finishes the run. The chat engine, the production
 * sandbox (setup, session-branch restore), the broker push, Postgres and a
 * real Git remote are all real.
 */
function scriptedAgent(edit: () => Promise<void>) {
  return {
    kind: "text",
    name: "scripted-agent",
    model: "scripted",
    "~types": {},
    async *chatStream(options: { runId?: string; threadId?: string }) {
      await edit()
      const base = {
        runId: options.runId ?? "run",
        threadId: options.threadId ?? "thread",
        model: "scripted",
      }
      yield { ...base, type: "RUN_STARTED", timestamp: Date.now() }
      yield {
        type: "TEXT_MESSAGE_START",
        messageId: "reply",
        role: "assistant",
        model: "scripted",
        timestamp: Date.now(),
      }
      yield {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "reply",
        delta: "Done.",
        model: "scripted",
        timestamp: Date.now(),
      }
      yield {
        type: "TEXT_MESSAGE_END",
        messageId: "reply",
        model: "scripted",
        timestamp: Date.now(),
      }
      yield {
        ...base,
        type: "RUN_FINISHED",
        finishReason: "stop",
        timestamp: Date.now(),
      }
    },
    async structuredOutput() {
      throw new Error("Not used")
    },
  } as unknown as Parameters<typeof chat>[0]["adapter"]
}

it(
  "keeps each turn's files on the session branch, resumes a recreated sandbox from it, and squashes on Create PR",
  { timeout: 120_000 },
  async () => {
    const pullRequests: Array<Record<string, unknown>> = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        onGithubPullRequest: (body) => {
          pullRequests.push(body as Record<string, unknown>)
        },
      },
      async (f) => {
        const conversationId = `conv_${f.id}`
        const userId = `user_${f.id}`
        const branch = conversationSessionBranch(conversationId)
        const previousProvider = process.env.SANDBOX_PROVIDER
        process.env.SANDBOX_PROVIDER = "unsandboxed"
        const asUser = <T>(fn: () => Promise<T>) =>
          withOrgIdContext(f.org, () =>
            withUserIdContext(userId, () => withTestLogger(fn)),
          )
        const remoteCommitsAboveMain = () =>
          f
            .git("--git-dir", f.remote, "branch", "--list", branch)
            .includes(branch)
            ? Number(
                f.git(
                  "--git-dir",
                  f.remote,
                  "rev-list",
                  "--count",
                  `main..${branch}`,
                ),
              )
            : 0
        const warm = async () => {
          const conversation = await asUser(() =>
            getConversation(conversationId),
          )
          const warmed = await asUser(() =>
            warmTanstackWorkspaceChat({
              conversationId,
              orgId: f.org.id,
              orgSlug: f.org.slug,
              workspaceId: f.workspaceId,
              desiredUrl: f.workspaceUrl,
              desiredSha: f.sha,
              desiredGeneration: f.revision.generation,
              githubConnectionId: f.connectionId,
              defaultBranch: "main",
              lastBranch: conversation?.lastBranch ?? null,
              writeStatus: "writable",
              prompt: "prepare",
              cloneToken: "fixture-native-clone",
            }),
          )
          if (!warmed.ok) throw new Error(warmed.error)
          return warmed.handle
        }
        const turn = async (
          handle: SandboxHandle,
          edit: () => Promise<void>,
        ) => {
          const chunks: StreamChunk[] = []
          await asUser(async () => {
            const stream = chat({
              adapter: scriptedAgent(edit),
              threadId: conversationId,
              messages: [{ role: "user", content: "Write it down" }],
              middleware: [
                defineChatMiddleware({
                  name: "sandbox-under-test",
                  provides: [SandboxCapability],
                  setup(ctx) {
                    provideSandbox(ctx, handle)
                  },
                }),
                workspaceChatSessionPush({
                  conversationId,
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                }),
              ],
            }) as AsyncIterable<StreamChunk>
            for await (const chunk of stream) chunks.push(chunk)
          })
          expect(chunks.filter((chunk) => chunk.type === "RUN_ERROR")).toEqual(
            [],
          )
          expect(chunks.at(-1)?.type).toBe("RUN_FINISHED")
          return chunks
            .filter(
              (chunk) =>
                chunk.type === "CUSTOM" &&
                chunk.name === WORKSPACE_CHAT_SESSION_PUSH_EVENT,
            )
            .map((chunk) => (chunk as { value: unknown }).value)
        }
        try {
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(conversations).values({
              id: conversationId,
              userId,
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              name: "Chat changes",
            }),
          )
          let handle = await warm()

          // A failed push is a non-fatal turn event; the commit waits in the sandbox.
          const rejectPushes = join(f.remote, "hooks", "pre-receive")
          writeFileSync(rejectPushes, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
          expect(
            await turn(handle, () => handle.fs.write("one.md", "# One\n")),
          ).toEqual([{ status: "failed", error: expect.any(String) }])
          expect(remoteCommitsAboveMain()).toBe(0)

          // The next turn retries: both turns' commits reach the branch.
          rmSync(rejectPushes)
          expect(
            await turn(handle, () => handle.fs.write("two.md", "# Two\n")),
          ).toEqual([{ status: "pushed", branch }])
          expect(remoteCommitsAboveMain()).toBe(2)
          expect(
            await asUser(() => getConversation(conversationId)),
          ).toMatchObject({ lastBranch: branch })

          // One commit per turn that changed files.
          expect(
            await turn(handle, () => handle.fs.write("three.md", "# Three\n")),
          ).toEqual([{ status: "pushed", branch }])
          expect(remoteCommitsAboveMain()).toBe(3)
          expect(
            f.git("--git-dir", f.remote, "log", "-1", "--format=%s", branch),
          ).toBe("ctxpipe - Bootstrap workspace knowledge")

          // A turn without changes pushes nothing.
          const tip = f.git("--git-dir", f.remote, "rev-parse", branch)
          expect(await turn(handle, async () => {})).toEqual([])
          expect(f.git("--git-dir", f.remote, "rev-parse", branch)).toBe(tip)

          // A lost sandbox is recreated from the session branch.
          await asUser(() => destroySandboxesForConversation(conversationId))
          const lost = handle.id
          handle = await warm()
          expect(handle.id).not.toBe(lost)
          expect(
            (await handle.process.exec("git branch --show-current")).stdout,
          ).toBe(`${branch}\n`)
          expect(await handle.fs.read("one.md")).toBe("# One\n")
          expect(await handle.fs.read("three.md")).toBe("# Three\n")
          // The restore fetched only the branch tip; Create PR must still squash.
          expect(
            (await handle.process.exec("git rev-parse --is-shallow-repository"))
              .stdout,
          ).toBe("true\n")
          expect(
            await turn(handle, () => handle.fs.write("four.md", "# Four\n")),
          ).toEqual([{ status: "pushed", branch }])
          expect(remoteCommitsAboveMain()).toBe(4)

          // Create PR publishes the turn commits as one commit.
          const app = new OpenAPIHono<AppEnv>()
          app.use(contextStorage())
          app.use(withTestRequestLogger)
          app.use("*", async (c, next) => {
            c.set("user", { id: userId } as AppEnv["Variables"]["user"])
            c.set("session", {
              id: `sess_${f.id}`,
            } as AppEnv["Variables"]["session"])
            await withOrgIdContext(f.org, next)
          })
          app.route("/conversations", conversationRoutes)
          const created = await app.request(
            `/conversations/${conversationId}/pull-request`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: "Write the four notes" }),
            },
          )
          expect({
            status: created.status,
            body: await created.json(),
          }).toMatchObject({ status: 200, body: { branch, prNumber: 41 } })
          expect(pullRequests).toEqual([
            expect.objectContaining({ head: branch, base: "main" }),
          ])
          expect(remoteCommitsAboveMain()).toBe(1)
          expect(
            f.git("--git-dir", f.remote, "log", "-1", "--format=%s", branch),
          ).toBe("Write the four notes")
          expect(
            f
              .git(
                "--git-dir",
                f.remote,
                "diff",
                "--name-only",
                `main...${branch}`,
              )
              .split("\n"),
          ).toEqual(["four.md", "one.md", "three.md", "two.md"])
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)

          // The next turn builds on the squashed commit instead of undoing it.
          expect(
            await turn(handle, () => handle.fs.write("five.md", "# Five\n")),
          ).toEqual([{ status: "pushed", branch }])
          expect(remoteCommitsAboveMain()).toBe(2)
        } finally {
          await asUser(() => destroySandboxesForConversation(conversationId))
          if (previousProvider === undefined)
            delete process.env.SANDBOX_PROVIDER
          else process.env.SANDBOX_PROVIDER = previousProvider
          await withOrgDbContext(f.org.id, (db) =>
            db
              .delete(conversations)
              .where(eq(conversations.id, conversationId)),
          )
        }
      },
    )
  },
)
