import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
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

async function conversationWorktreeVersion(
  request: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response>,
  conversation: string,
) {
  const tree = await request(`${conversation}/files/tree`)
  const body = (await tree.json()) as { worktreeVersion?: string }
  if (!body.worktreeVersion) {
    throw new Error("Conversation worktree version is missing")
  }
  return body.worktreeVersion
}

it(
  "renames binary content through the native Files HTTP seam without data loss",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const sourcePath = "binary.bin"
      const destinationPath = "renamed.bin"
      const binaryBody = Uint8Array.from([0, 255, 1, 2, 3, 254])
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: f.directory,
          encoding: "utf8",
        }).trim()
      await writeFile(join(f.directory, sourcePath), binaryBody)
      git("add", "--", sourcePath)
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "Add binary file",
      )
      const desiredSha = git("rev-parse", "HEAD")
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "writable", desiredSha })
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
      const conversation = `/conversations/${f.conversationId}`
      const prepared = await app().request(`${conversation}/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: f.workspaceId }),
      })
      expect(prepared.status).toBe(204)
      const renamed = await app().request(`${conversation}/files/blob`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: destinationPath,
          from: sourcePath,
          expectedWorktreeVersion: await conversationWorktreeVersion(
            (path, init) => app().request(path, init),
            conversation,
          ),
        }),
      })
      expect(renamed.status).toBe(200)
      const source = await app().request(
        `${conversation}/files/blob?path=${sourcePath}`,
      )
      expect(source.status).toBe(404)
      const destination = await app().request(
        `${conversation}/files/blob?path=${destinationPath}`,
      )
      expect(destination.status).toBe(200)
      expect(await destination.json()).toMatchObject({
        path: destinationPath,
        body: null,
        binary: true,
      })
      const [instance] = await listSandboxInstances({
        conversationId: f.conversationId,
      })
      if (!instance?.providerSandboxId)
        throw new Error("Renamed native sandbox was not persisted")
      const { localProcessSandbox } = await import(
        "@tanstack/ai-sandbox-local-process"
      )
      const raw = await localProcessSandbox().resume({
        id: instance.providerSandboxId,
      })
      if (!raw) throw new Error("Renamed native sandbox could not be resumed")
      const readBytes = (
        raw.fs as unknown as {
          readBytes: (path: string) => Promise<Uint8Array>
        }
      ).readBytes
      expect([...(await readBytes(destinationPath))]).toEqual([...binaryBody])
    })
  },
)

it(
  "keeps shell metacharacters literal through the native Files diff seam",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const path = "tracked ; touch injected-marker.txt ; # file.md"
      const marker = "injected-marker.txt"
      const oldBody = "literal old content\n"
      const currentBody = "literal current content\n"
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: f.directory,
          encoding: "utf8",
        }).trim()
      await writeFile(join(f.directory, path), oldBody)
      git("add", "--", path)
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "Add shell path",
      )
      const desiredSha = git("rev-parse", "HEAD")
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "writable", desiredSha })
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
      expect(
        (
          await app().request(`/conversations/${f.conversationId}/prepare`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: f.workspaceId }),
          })
        ).status,
      ).toBe(204)
      const saved = await app().request(`${base}/blob`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          body: currentBody,
          expectedWorktreeVersion: await conversationWorktreeVersion(
            (requestPath, init) => app().request(requestPath, init),
            `/conversations/${f.conversationId}`,
          ),
        }),
      })
      expect(saved.status).toBe(200)
      const diff = await app().request(`${base}/diff`)
      expect(diff.status).toBe(200)
      expect(await diff.json()).toMatchObject({
        items: expect.arrayContaining([{ path, oldBody, body: currentBody }]),
      })
      const tree = await app().request(`${base}/tree`)
      expect(tree.status).toBe(200)
      const paths = (await tree.json()).paths as string[]
      expect(paths).toContain(path)
      expect(paths).not.toContain(marker)
    })
  },
)

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
        body: JSON.stringify({
          path: "notes.md",
          body: "native saved work",
          expectedWorktreeVersion: await conversationWorktreeVersion(
            (requestPath, init) => app().request(requestPath, init),
            `/conversations/${f.conversationId}`,
          ),
        }),
      })
      expect(saved.status).toBe(200)
      const savedBody = (await saved.json()) as {
        worktreeVersion?: string
        tree?: { paths?: string[]; worktreeVersion?: string }
        status?: { dirty?: boolean; worktreeVersion?: string }
      }
      expect(savedBody.worktreeVersion).toEqual(expect.any(String))
      expect(savedBody.tree).toMatchObject({
        paths: ["README.md", "notes.md"],
        worktreeVersion: savedBody.worktreeVersion,
      })
      expect(savedBody.status).toMatchObject({
        dirty: true,
        worktreeVersion: savedBody.worktreeVersion,
      })
      const tree = await app().request(`${base}/tree`)
      expect(tree.status).toBe(200)
      expect(await tree.json()).toMatchObject({
        paths: ["README.md", "notes.md"],
        worktreeVersion: savedBody.worktreeVersion,
      })
      const status = await app().request(`${base}/status`)
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({
        dirty: true,
        items: [expect.objectContaining({ path: "notes.md" })],
        worktreeVersion: savedBody.worktreeVersion,
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
  "rejects a stale conversation file write and accepts the current worktree version",
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
      const conversation = `/conversations/${f.conversationId}`
      const base = `${conversation}/files`
      expect(
        (
          await app().request(`${conversation}/prepare`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: f.workspaceId }),
          })
        ).status,
      ).toBe(204)
      const tree = await app().request(`${base}/tree`)
      expect(tree.status).toBe(200)
      const initial = (await tree.json()) as { worktreeVersion: string }
      const first = await app().request(`${base}/blob`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "notes.md",
          body: "first write",
          expectedWorktreeVersion: initial.worktreeVersion,
        }),
      })
      expect(first.status).toBe(200)
      const missingVersion = await app().request(`${base}/blob`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "notes.md",
          body: "rejected without a version",
        }),
      })
      expect(missingVersion.status).toBe(400)
      const firstBody = (await first.json()) as { worktreeVersion: string }
      expect(firstBody.worktreeVersion).not.toBe(initial.worktreeVersion)
      const stale = await app().request(`${base}/blob`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "notes.md",
          body: "stale write",
          expectedWorktreeVersion: initial.worktreeVersion,
        }),
      })
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({
        error: "stale_worktree",
        worktreeVersion: firstBody.worktreeVersion,
      })
      const second = await app().request(`${base}/blob`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "notes.md",
          body: "second write",
          expectedWorktreeVersion: firstBody.worktreeVersion,
        }),
      })
      expect(second.status).toBe(200)
      expect(await second.json()).toMatchObject({
        body: "second write",
        tree: { paths: expect.arrayContaining(["notes.md"]) },
        status: { dirty: true },
      })
      expect(
        await (await app().request(`${base}/blob?path=notes.md`)).json(),
      ).toMatchObject({ body: "second write" })
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
      const expectedWorktreeVersion = await conversationWorktreeVersion(
        (path, init) => f.request(path, init),
        `/conversations/${f.conversationId}`,
      )
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
              expectedWorktreeVersion,
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
