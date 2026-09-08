import { OpenAPIHono } from "@hono/zod-openapi"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { conversationSessionBranch } from "../../domain/workspaces/chat-lifecycle.js"
import { shellSingleQuote } from "../../domain/workspaces/conversation-publish.js"
import { adaptTanstackHandle } from "../../domain/workspaces/job-sandbox.js"
import {
  attachWorkspaceSandbox,
  resetRegisteredSandboxes,
} from "../../domain/workspaces/sandbox-registry.js"
import { getConversation } from "../../models/conversations.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { conversationRoutes } from "./conversations.js"

it.each(["push", "pull-request", "missing", "stale"])(
  "publishes from the authenticated conversation HTTP boundary: %s",
  { timeout: 30_000 },
  async (scenario) => {
    const pullRequests: unknown[] = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        onGithubPullRequest: (body) => pullRequests.push(body),
      },
      async (f) => {
        const conversationId = `conv_${f.id}`
        const userId = `user_${f.id}`
        const raw = await localProcessSandbox().create({ id: conversationId })
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
          await raw.process.exec("git init -b main")
          await raw.process.exec(`git fetch ${shellSingleQuote(f.remote)} main`)
          await raw.process.exec("git checkout -B main FETCH_HEAD")
          await raw.fs.write("notes.md", "# Saved conversation\n")
          if (scenario !== "missing")
            attachWorkspaceSandbox({
              id: conversationId,
              kind: "chat",
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              conversationId,
              handle: adaptTanstackHandle(raw),
              desiredUrl:
                scenario === "stale"
                  ? "https://github.com/fixture/other"
                  : f.workspaceUrl,
              desiredSha: f.sha,
              desiredGeneration: f.revision.generation,
              defaultBranch: "main",
            })
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
          const response = await app.request(
            `/conversations/${conversationId}/${scenario === "push" ? "push" : "pull-request"}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: "Chat changes" }),
            },
          )
          const body = await response.json()
          const branch = conversationSessionBranch(conversationId)
          if (scenario === "missing" || scenario === "stale") {
            expect({ status: response.status, body }).toEqual({
              status: scenario === "missing" ? 409 : 400,
              body: {
                error: scenario === "missing" ? "missing_sandbox" : "stale_url",
              },
            })
            expect(pullRequests).toEqual([])
            expect(
              f.git("--git-dir", f.remote, "rev-list", "--all", "--count"),
            ).toBe("1")
          } else {
            expect(response.status).toBe(200)
            expect(body).toMatchObject({ branch })
            expect(
              f.git("--git-dir", f.remote, "show", `${branch}:notes.md`),
            ).toBe("# Saved conversation")
            if (scenario === "pull-request") {
              expect(body).toMatchObject({
                prNumber: 41,
                pullUrl:
                  "https://github.com/fixture/hydration-contract/pull/41",
                prState: "open",
              })
              expect(pullRequests).toEqual([
                expect.objectContaining({
                  head: branch,
                  base: "main",
                  title: "Chat changes",
                }),
              ])
              const { withUserIdContext } = await import(
                "../../auth/context.js"
              )
              expect(
                await withOrgIdContext(f.org, () =>
                  withUserIdContext(userId, () =>
                    getConversation(conversationId),
                  ),
                ),
              ).toMatchObject({ lastBranch: branch, lastChatPrNumber: 41 })
            }
          }
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
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
