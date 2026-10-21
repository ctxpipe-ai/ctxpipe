import { existsSync } from "node:fs"
import { rename } from "node:fs/promises"
import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaceSandboxInstances } from "../../db/schema/workspaces.js"
import { conversationSessionBranch } from "../../domain/workspaces/chat-lifecycle.js"
import { postgresSandboxLocks } from "../../domain/workspaces/sandbox-lock-store.js"
import { warmTanstackWorkspaceChat } from "../../domain/workspaces/tanstack-workspace-chat.js"
import { destroySandboxesForConversation } from "../../domain/workspaces/workspace-sandbox-cleanup.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import { conversationRoutes } from "./conversations.js"

/** Hold the conversation lock as a chat turn does, until the call to release. */
async function holdTurnLock(orgId: string, conversationId: string) {
  let release = () => {}
  let acquired = () => {}
  const isAcquired = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const held = postgresSandboxLocks(orgId).withLock(
    `chat-thread:${conversationId}`,
    () =>
      new Promise<void>((resolve) => {
        release = resolve
        acquired()
      }),
  )
  await isAcquired
  return async () => {
    release()
    await held
  }
}

it(
  "reads a file at once from the sandbox while a turn holds the conversation",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const conversationId = `conv_${f.id}`
        const userId = `user_${f.id}`
        const previousProvider = process.env.SANDBOX_PROVIDER
        process.env.SANDBOX_PROVIDER = "unsandboxed"
        try {
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(conversations).values({
              id: conversationId,
              userId,
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              name: "Read during a turn",
            }),
          )
          const warmed = await withOrgIdContext(f.org, () =>
            withTestLogger(() =>
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
                lastBranch: conversationSessionBranch(conversationId),
                writeStatus: "writable",
                prompt: "prepare",
              }),
            ),
          )
          if (!warmed.ok) throw new Error(warmed.error)
          const sandbox = warmed.handle
          await sandbox.process.exec("git init -q -b main")
          await sandbox.fs.write("notes.md", "# First\n")
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
          const read = async () => {
            const started = Date.now()
            const response = await app.request(
              `/conversations/${conversationId}/files/blob?path=notes.md`,
              { signal: AbortSignal.timeout(5_000) },
            )
            return {
              status: response.status,
              body: await response.text().then((text) => {
                try {
                  return JSON.parse(text) as unknown
                } catch {
                  return text
                }
              }),
              fast: Date.now() - started < 3_000,
            }
          }
          const releaseTurn = await holdTurnLock(f.org.id, conversationId)
          try {
            expect(await read()).toEqual({
              status: 200,
              body: { path: "notes.md", body: "# First\n", binary: false },
              fast: true,
            })
            // The agent writes during the turn: the next read shows it.
            await sandbox.fs.write("notes.md", "# Second\n")
            expect(await read()).toEqual({
              status: 200,
              body: { path: "notes.md", body: "# Second\n", binary: false },
              fast: true,
            })
            // The lock holder can also be the idle sweep: a stopped sandbox
            // is never started for a read; the pane polls again. No running
            // row exists, so the answer is chat_starting.
            const busy = {
              status: 409,
              body: { error: "chat_starting" },
              fast: true,
            }
            const setState = (state: "live" | "stopped") =>
              withOrgDbContext(f.org.id, (db) =>
                db
                  .update(workspaceSandboxInstances)
                  .set({ state })
                  .where(
                    eq(
                      workspaceSandboxInstances.conversationId,
                      conversationId,
                    ),
                  ),
              )
            await setState("stopped")
            expect(await read()).toEqual(busy)
            await setState("live")
            // A live row whose sandbox does not run: no attach either.
            const [row] = await withOrgDbContext(f.org.id, (db) =>
              db
                .select()
                .from(workspaceSandboxInstances)
                .where(
                  eq(workspaceSandboxInstances.conversationId, conversationId),
                ),
            )
            const directory = row?.providerSandboxId
            if (!directory) throw new Error("The sandbox row has no id")
            await rename(directory, `${directory}.away`)
            try {
              expect(await read()).toEqual(busy)
            } finally {
              await rename(`${directory}.away`, directory)
            }
            expect(existsSync(`${directory}.away`)).toBe(false)
          } finally {
            await releaseTurn()
          }
          // With no turn, the read is the same.
          expect(await read()).toEqual({
            status: 200,
            body: { path: "notes.md", body: "# Second\n", binary: false },
            fast: true,
          })
        } finally {
          if (previousProvider === undefined)
            delete process.env.SANDBOX_PROVIDER
          else process.env.SANDBOX_PROVIDER = previousProvider
          await withOrgIdContext(f.org, () =>
            destroySandboxesForConversation(conversationId),
          ).catch(() => undefined)
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
