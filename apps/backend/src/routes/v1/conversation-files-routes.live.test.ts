import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { destroySandboxesForConversation } from "../../domain/workspaces/workspace-sandbox-cleanup.js"
import {
  listSandboxInstances,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { conversationFileRoutes } from "./conversation-files-routes.js"
import { conversationRoutes } from "./conversations.js"

it(
  "resumes Files through native persisted ownership and never clones for a missing tree/status GET",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "writable" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const app = () => {
        const hono = new OpenAPIHono<AppEnv>()
        hono.use(contextStorage())
        hono.use(withTestRequestLogger)
        hono.use("*", async (c, next) => {
          c.set("user", {
            id: `user_${f.orgId}`,
          } as AppEnv["Variables"]["user"])
          c.set("session", {
            id: `session_${f.orgId}`,
          } as AppEnv["Variables"]["session"])
          await next()
        })
        hono.route("/conversations", conversationFileRoutes)
        hono.route("/conversations", conversationRoutes)
        return hono
      }
      const base = `/conversations/${f.conversationId}/files`
      expect((await app().request(`${base}/tree`)).status).toBe(409)
      const prepared = await app().request(
        `/conversations/${f.conversationId}/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: f.workspaceId }),
        },
      )
      expect(prepared.status).toBe(204)
      expect(f.modelRequests).toEqual([])
      const saved = await app().request(`${base}/blob`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes.md", body: "native saved work" }),
      })
      expect(saved.status).toBe(200)
      const tree = await app().request(`${base}/tree`)
      expect(tree.status).toBe(200)
      expect(await tree.json()).toMatchObject({
        paths: ["README.md", "notes.md"],
      })
      const status = await app().request(`${base}/status`)
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({
        dirty: true,
        items: [expect.objectContaining({ path: "notes.md" })],
      })
      const blob = await app().request(`${base}/blob?path=notes.md`)
      expect(await blob.json()).toMatchObject({ body: "native saved work" })
      const [owned] = await listSandboxInstances({
        conversationId: f.conversationId,
      })
      if (!owned) throw new Error("Prepared native sandbox was not persisted")
      await persistSandboxInstance({
        ...owned,
        provider: "unconfigured-provider",
      })
      expect(await destroySandboxesForConversation(f.conversationId)).toBe(0)
      expect(
        await listSandboxInstances({ conversationId: f.conversationId }),
      ).toMatchObject([
        { providerSandboxId: owned.providerSandboxId, state: "destroy_failed" },
      ])
      await persistSandboxInstance(owned)
      expect(
        await (await app().request(`${base}/blob?path=notes.md`)).json(),
      ).toMatchObject({ body: "native saved work" })
      expect(await destroySandboxesForConversation(f.conversationId)).toBe(1)
      expect((await app().request(`${base}/tree`)).status).toBe(409)
      expect((await app().request(`${base}/status`)).status).toBe(409)
    })
  },
)

it(
  "serializes push with Files and stops a pending write when its native lease is lost",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "writable" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      expect(
        (
          await f.request(`/conversations/${f.conversationId}/prepare`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: f.workspaceId }),
          })
        ).status,
      ).toBe(204)
      let body!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
        },
      })
      const pending = f.request(
        `/conversations/${f.conversationId}/files/blob`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: stream,
          duplex: "half",
        } as RequestInit,
      )
      const { sandboxLocks } = await import("../../db/schema/sandbox-locks.js")
      const key = `chat-thread:${f.conversationId}`
      await expect
        .poll(
          () =>
            withOrgDbContext(f.orgId, (db) =>
              db.select().from(sandboxLocks).where(eq(sandboxLocks.key, key)),
            ),
          { timeout: 5_000 },
        )
        .toHaveLength(1)
      let pushed = false
      const push = Promise.resolve(
        f.request(`/conversations/${f.conversationId}/push`, {
          method: "POST",
        }),
      ).then((response) => {
        pushed = true
        return response
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(pushed).toBe(false)
        // Remove this fixture's real lock ownership. The next native renewal
        // must abort the pending operation before its request body can write.
        await withOrgDbContext(f.orgId, (db) =>
          db.delete(sandboxLocks).where(eq(sandboxLocks.key, key)),
        )
        await new Promise((resolve) => setTimeout(resolve, 11_000))
      } finally {
        body.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              path: "after-lease-loss.md",
              body: "must not be written",
            }),
          ),
        )
        body.close()
      }
      expect((await pending).status).toBe(500)
      await push
      const blob = await f.request(
        `/conversations/${f.conversationId}/files/blob?path=after-lease-loss.md`,
      )
      expect(blob.status).toBe(404)
    })
  },
)
