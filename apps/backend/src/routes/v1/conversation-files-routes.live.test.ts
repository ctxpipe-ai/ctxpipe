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
