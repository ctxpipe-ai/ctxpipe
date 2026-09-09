import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  getWorkspaceById,
  persistWriteStatus,
} from "../../models/workspaces.js"
import { conversationFileRoutes } from "../../routes/v1/conversation-files-routes.js"
import { workspaceRoutes } from "../../routes/v1/workspaces.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import { warmTanstackWorkspaceChat } from "./tanstack-workspace-chat.js"
import { destroySandboxesForConversation } from "./workspace-sandbox-cleanup.js"
import { WRITE_STATUS_REASONS } from "./write-status.js"

it(
  "permits session-branch edits under default protection but denies repository permission loss",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        writeStatus: "writable",
        files: [{ path: "AGENTS.md", body: "# Original default\n" }],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const conversationId = `conv_${f.id}`
        const userId = `user_${f.id}`
        const previousProvider = process.env.SANDBOX_PROVIDER
        process.env.SANDBOX_PROVIDER = "unsandboxed"
        try {
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(conversations).values({
              id: conversationId,
              orgId: f.org.id,
              userId,
              workspaceId: f.workspaceId,
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
                writeStatus: "writable",
                prompt: "prepare",
              }),
            ),
          )
          if (!warmed.ok) throw new Error(warmed.error)
          const raw = warmed.handle
          const app = new OpenAPIHono<AppEnv>()
          app.use(contextStorage())
          app.use(withTestRequestLogger)
          app.use("*", async (c, next) => {
            c.set("user", { id: userId } as AppEnv["Variables"]["user"])
            c.set("session", {
              id: `session_${f.id}`,
            } as AppEnv["Variables"]["session"])
            await next()
          })
          app.route("/conversations", conversationFileRoutes)
          app.route("/workspaces", workspaceRoutes)
          const capabilities = () =>
            withOrgIdContext(f.org, async () => {
              const binding = await getWorkspaceById(f.workspaceId)
              if (!binding) throw new Error("Fixture workspace missing")
              const response = await app.request(`/workspaces/${binding.slug}`)
              expect(response.status).toBe(200)
              return response.json()
            })
          const setReason = (readOnlyReason: string) =>
            withOrgIdContext(f.org, async () => {
              const binding = await getWorkspaceById(f.workspaceId)
              if (!binding) throw new Error("Fixture workspace missing")
              await persistWriteStatus(
                binding,
                { writeStatus: "read_only", readOnlyReason },
                f.org.id,
              )
            })
          const save = () =>
            withOrgIdContext(f.org, async () =>
              app.request(`/conversations/${conversationId}/files/blob`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  path: "notes.md",
                  body: "# Conversation edit\n",
                }),
              }),
            )
          await setReason(WRITE_STATUS_REASONS.protectedBranch)
          expect(await capabilities()).toMatchObject({
            writeStatus: "read_only",
            conversationWritable: true,
          })
          const saved = await save()
          expect(saved.status).toBe(200)
          expect(await saved.json()).toMatchObject({
            path: "notes.md",
            body: "# Conversation edit\n",
          })
          expect(await raw.fs.read("notes.md")).toBe("# Conversation edit\n")
          expect(
            (await raw.process.exec("git branch --show-current")).stdout.trim(),
          ).toBe(`ctxpipe/chat/${conversationId}/1`)
          expect(
            (await raw.process.exec("git show main:AGENTS.md")).stdout.trim(),
          ).toBe("# Original default")
          await setReason(WRITE_STATUS_REASONS.contentsWriteDenied)
          expect(await capabilities()).toMatchObject({
            writeStatus: "read_only",
            conversationWritable: false,
          })
          expect((await save()).status).toBe(403)
        } finally {
          await withOrgIdContext(f.org, () =>
            destroySandboxesForConversation(conversationId),
          )
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
