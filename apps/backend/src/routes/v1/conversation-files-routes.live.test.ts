import { resolve } from "node:path"
import { config } from "dotenv"
import { OpenAPIHono } from "@hono/zod-openapi"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { adaptTanstackHandle } from "../../domain/workspaces/job-sandbox.js"
import {
  attachWorkspaceSandbox,
  resetRegisteredSandboxes,
} from "../../domain/workspaces/sandbox-registry.js"
import { resetWorkspaceChatSandboxMemos } from "../../domain/workspaces/workspace-chat-sandbox-memo.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationFileRoutes } from "./conversation-files-routes.js"

config({
  path: resolve(import.meta.dirname, "../../../.env.local"),
  quiet: true,
})

const conversation = {
  id: "conv_live_tree",
  orgId: "org_live_tree",
  workspaceId: "ws_live_tree",
  lastBranch: null,
}

const workspace = {
  id: "ws_live_tree",
  orgId: "org_live_tree",
  workspaceRepositoryUrl: "file:///tmp/ctxpipe-live-tree-origin",
  writeStatus: "writable",
  desiredSha: "HEAD",
}

vi.mock("../../models/conversations.js", () => ({
  getConversation: async () => conversation,
  persistConversationLastBranch: async () => undefined,
}))

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById: async () => workspace,
}))

function app() {
  const hono = new OpenAPIHono<AppEnv>()
  hono.use(contextStorage())
  hono.use(withTestRequestLogger)
  hono.use("*", async (c, next) => {
    c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    await next()
  })
  hono.route("/conversations", conversationFileRoutes)
  return hono
}

describe("conversation files tree against a live sandbox workdir", () => {
  beforeEach(() => {
    resetRegisteredSandboxes()
    resetWorkspaceChatSandboxMemos()
  })

  afterEach(() => {
    resetRegisteredSandboxes()
    resetWorkspaceChatSandboxMemos()
  })

  it("lists a write from the live handle and 409s without inventing a fresh clone", async () => {
    const provider = localProcessSandbox()
    const raw = await provider.create({ id: "conv-live-tree" })
    try {
      await raw.process.exec("git init -b main")
      await raw.process.exec("git config user.email test@ctxpipe.local")
      await raw.process.exec("git config user.name ctxpipe")
      await raw.fs.write("AGENTS.md", "original\n")
      await raw.process.exec("git add AGENTS.md")
      await raw.process.exec("git commit -m init")
      const handle = adaptTanstackHandle(raw)
      attachWorkspaceSandbox({
        id: conversation.id,
        kind: "chat",
        workspaceId: workspace.id,
        conversationId: conversation.id,
        orgId: workspace.orgId,
        handle,
      })

      const first = await app().request(
        `/conversations/${conversation.id}/files/tree`,
      )
      expect(first.status).toBe(200)
      expect(await first.json()).toMatchObject({
        paths: ["AGENTS.md"],
        branch: "ctxpipe/chat/conv_live_tree/1",
      })

      await handle.fs.write("e2e.md", "live")

      const afterWrite = await app().request(
        `/conversations/${conversation.id}/files/tree`,
      )
      expect(afterWrite.status).toBe(200)
      expect(await afterWrite.json()).toMatchObject({
        paths: ["AGENTS.md", "e2e.md"],
      })

      const status = await app().request(
        `/conversations/${conversation.id}/files/status`,
      )
      expect(status.status).toBe(200)
      const statusBody = (await status.json()) as {
        dirty: boolean
        items: Array<{ path: string }>
      }
      expect(statusBody.dirty).toBe(true)
      expect(statusBody.items.map((item) => item.path)).toContain("e2e.md")

      resetRegisteredSandboxes()

      const missed = await app().request(
        `/conversations/${conversation.id}/files/tree`,
      )
      expect(missed.status).toBe(409)
      expect(await missed.json()).toEqual({ error: "missing_sandbox" })

      const missedStatus = await app().request(
        `/conversations/${conversation.id}/files/status`,
      )
      expect(missedStatus.status).toBe(409)

      attachWorkspaceSandbox({
        id: conversation.id,
        kind: "chat",
        workspaceId: workspace.id,
        conversationId: conversation.id,
        orgId: workspace.orgId,
        handle,
      })
      const restored = await app().request(
        `/conversations/${conversation.id}/files/tree`,
      )
      expect(restored.status).toBe(200)
      expect(await restored.json()).toMatchObject({
        paths: ["AGENTS.md", "e2e.md"],
      })
    } finally {
      await raw.destroy()
    }
  })
})
