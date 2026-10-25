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
import {
  RAW_FILE_MAX_BYTES,
  rawFileTooLargeMessage,
} from "../../domain/workspaces/raw-file.js"
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

/**
 * Starts a local chat sandbox for a new conversation, and gives a request
 * function for the conversation routes as the user of that conversation.
 */
async function withConversationSandbox(
  run: (fixture: {
    orgId: string
    conversationId: string
    exec: (command: string) => Promise<unknown>
    write: (path: string, content: string) => Promise<void>
    request: (path: string) => Promise<Response>
  }) => Promise<void>,
) {
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
            name: "Conversation file reads",
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
        await run({
          orgId: f.org.id,
          conversationId,
          exec: (command) => sandbox.process.exec(command),
          write: (path, content) => sandbox.fs.write(path, content),
          request: (path) =>
            Promise.resolve(
              app.request(`/conversations/${conversationId}/files/${path}`, {
                signal: AbortSignal.timeout(5_000),
              }),
            ),
        })
      } finally {
        if (previousProvider === undefined) delete process.env.SANDBOX_PROVIDER
        else process.env.SANDBOX_PROVIDER = previousProvider
        await withOrgIdContext(f.org, () =>
          destroySandboxesForConversation(conversationId),
        ).catch(() => undefined)
        await withOrgDbContext(f.org.id, (db) =>
          db.delete(conversations).where(eq(conversations.id, conversationId)),
        )
      }
    },
  )
}

it(
  "reads a file at once from the sandbox while a turn holds the conversation",
  { timeout: 60_000 },
  async () => {
    await withConversationSandbox(
      async ({ orgId, conversationId, write, request }) => {
        await write("notes.md", "# First\n")
        const read = async () => {
          const started = Date.now()
          const response = await request("blob?path=notes.md")
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
        const releaseTurn = await holdTurnLock(orgId, conversationId)
        try {
          expect(await read()).toEqual({
            status: 200,
            body: { path: "notes.md", body: "# First\n", binary: false },
            fast: true,
          })
          // The agent writes during the turn: the next read shows it.
          await write("notes.md", "# Second\n")
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
            withOrgDbContext(orgId, (db) =>
              db
                .update(workspaceSandboxInstances)
                .set({ state })
                .where(
                  eq(workspaceSandboxInstances.conversationId, conversationId),
                ),
            )
          await setState("stopped")
          expect(await read()).toEqual(busy)
          await setState("live")
          // A live row whose sandbox does not run: no attach either.
          const [row] = await withOrgDbContext(orgId, (db) =>
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
      },
    )
  },
)

it(
  "sends raw sandbox bytes with headers that never run them as a page, and refuses a large file",
  { timeout: 60_000 },
  async () => {
    await withConversationSandbox(async ({ exec, write, request }) => {
      await write(
        "diagram.svg",
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      )
      await write("logo.png", "png bytes")
      await exec(`head -c ${RAW_FILE_MAX_BYTES + 1} /dev/zero > huge.png`)
      const raw = async (path: string) => {
        const response = await request(`raw?path=${encodeURIComponent(path)}`)
        return {
          status: response.status,
          type: response.headers.get("content-type"),
          disposition: response.headers.get("content-disposition"),
          nosniff: response.headers.get("x-content-type-options"),
          csp: response.headers.get("content-security-policy"),
          body: await response.text(),
        }
      }
      const csp =
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox"
      expect({
        png: await raw("logo.png"),
        svg: await raw("diagram.svg"),
        huge: await raw("huge.png"),
      }).toEqual({
        png: {
          status: 200,
          type: "image/png",
          disposition: `inline; filename="logo.png"; filename*=UTF-8''logo.png`,
          nosniff: "nosniff",
          csp,
          body: "png bytes",
        },
        svg: {
          status: 200,
          type: "image/svg+xml",
          disposition: `attachment; filename="diagram.svg"; filename*=UTF-8''diagram.svg`,
          nosniff: "nosniff",
          csp,
          body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        },
        huge: {
          status: 413,
          type: "application/json",
          disposition: null,
          nosniff: null,
          csp: null,
          body: JSON.stringify({
            error: rawFileTooLargeMessage(RAW_FILE_MAX_BYTES + 1),
          }),
        },
      })
    })
  },
)
