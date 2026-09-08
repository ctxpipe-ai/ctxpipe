import { OpenAPIHono } from "@hono/zod-openapi"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
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
import { adaptTanstackHandle } from "./job-sandbox.js"
import {
  attachWorkspaceSandbox,
  resetRegisteredSandboxes,
} from "./sandbox-registry.js"
import { WRITE_STATUS_REASONS } from "./write-status.js"

it(
  "permits session-branch edits under default protection but denies repository permission loss",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, writeStatus: "writable" },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const conversationId = `conv_${f.id}`
        const userId = `user_${f.id}`
        const raw = await localProcessSandbox().create({ id: conversationId })
        try {
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(conversations).values({
              id: conversationId,
              orgId: f.org.id,
              userId,
              workspaceId: f.workspaceId,
            }),
          )
          await raw.process.exec("git init -b main")
          await raw.process.exec("git config user.email fixture@example.test")
          await raw.process.exec("git config user.name Fixture")
          await raw.fs.write("AGENTS.md", "# Original default\n")
          await raw.process.exec("git add AGENTS.md")
          await raw.process.exec("git commit -m Initial")
          attachWorkspaceSandbox({
            id: conversationId,
            kind: "chat",
            workspaceId: f.workspaceId,
            conversationId,
            orgId: f.org.id,
            handle: adaptTanstackHandle(raw),
          })
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
          resetRegisteredSandboxes()
          await raw.destroy()
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
