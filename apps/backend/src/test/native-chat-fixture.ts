import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import type { AppEnv } from "../app/env.js"
import { withUserIdContext } from "../auth/context.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import {
  chatInterrupts,
  chatMetadata,
  chatRuns,
  chatThreads,
} from "../db/schema/chat-persistence.js"
import { conversations } from "../db/schema/conversations.js"
import { orgFirstWorkspaces, workspaces } from "../db/schema/workspaces.js"
import { workspaceChatOpenCodeHomeDir } from "../domain/workspaces/workspace-chat-opencode-contract.js"
import { destroySandboxesForWorkspace } from "../domain/workspaces/workspace-sandbox-cleanup.js"
import { generateObjectId } from "../lib/id.js"
import { listSandboxInstances } from "../models/workspaces.js"
import { conversationRoutes } from "../routes/v1/conversations.js"
import { workspaceChatOpenaiRoutes } from "../routes/v1/workspace-chat-openai.js"
import { workspaceRoutes } from "../routes/v1/workspaces.js"
import { contextStorage, withTestRequestLogger } from "./hono-test-logger.js"
import { withTestLogger } from "./with-test-logger.js"

/** Real PG, Git, OpenCode and the production model proxy; only the external model speaks fixture HTTP. */
export async function withNativeChatFixture<T>(
  fn: (fixture: {
    orgId: string
    userId: string
    orgSlug: string
    workspaceId: string
    conversationId: string
    directory: string
    sha: string
    modelRequests: Array<Record<string, unknown>>
    request: OpenAPIHono<AppEnv>["request"]
  }) => Promise<T>,
  beforeModelResponse?: () => Promise<void>,
  options: { listenHost?: string } = {},
): Promise<T> {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for native chat proof")
  initDb(process.env.DATABASE_URL)
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-native-chat-"))
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  const conversationId = `conv_${orgId}`
  const userId = `user_${orgId}`
  const org = { id: orgId, slug: orgId, name: "Native chat proof" }
  const modelRequests: Array<Record<string, unknown>> = []
  const previous = Object.fromEntries(
    [
      "PORT",
      "SANDBOX_PROVIDER",
      "MODEL_PROVIDER",
      "MODEL_PROVIDER_URL",
      "MODEL_PROVIDER_API_KEY",
      "MODEL_FAST_NAME",
    ].map((key) => [key, process.env[key]]),
  )
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env))
    c.set("user", { id: userId } as AppEnv["Variables"]["user"])
    c.set("session", {
      id: `session_${orgId}`,
    } as AppEnv["Variables"]["session"])
    c.set("orgSlug", orgId)
    await next()
  })
  app.route(`/${orgId}/api/v1/workspace-chat/openai`, workspaceChatOpenaiRoutes)
  app.route("/conversations", conversationRoutes)
  app.route("/workspaces", workspaceRoutes)
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (req.url === "/model/v1/chat/completions") {
        const request = JSON.parse(body.toString()) as Record<string, unknown>
        modelRequests.push(request)
        await beforeModelResponse?.()
        const content = "Native reply completed."
        if (request.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" })
          for (const choice of [
            {
              index: 0,
              delta: { role: "assistant", content },
              finish_reason: null,
            },
            { index: 0, delta: {}, finish_reason: "stop" },
          ])
            res.write(
              `data: ${JSON.stringify({ id: `completion-${modelRequests.length}`, object: "chat.completion.chunk", created: 1, model: request.model, choices: [choice] })}\n\n`,
            )
          res.end("data: [DONE]\n\n")
        } else {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              id: `completion-${modelRequests.length}`,
              object: "chat.completion",
              created: 1,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content },
                  finish_reason: "stop",
                },
              ],
            }),
          )
        }
        return
      }
      const response = await app.fetch(
        new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers: req.headers as HeadersInit,
          body:
            req.method === "GET" || req.method === "HEAD" ? undefined : body,
        }),
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body)
        for await (const chunk of response.body) res.write(chunk)
      res.end()
    })().catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, options.listenHost ?? "127.0.0.1", resolve),
    )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Native chat HTTP port missing")
    Object.assign(process.env, {
      PORT: String(address.port),
      SANDBOX_PROVIDER: "unsandboxed",
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_URL: `http://127.0.0.1:${address.port}/model/v1`,
      MODEL_PROVIDER_API_KEY: "native-fixture-model-key",
      MODEL_FAST_NAME: "openai/gpt-5.6-terra",
    })
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
    git("init", "-b", "main")
    await writeFile(join(directory, "README.md"), "# Native chat workspace\n")
    git("add", ".")
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Initial",
    )
    const sha = git("rev-parse", "HEAD")
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, createdAt: new Date() })
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: directory,
        desiredSha: sha,
        desiredDefaultBranch: "main",
        writeStatus: "read_only",
      })
      await db.insert(conversations).values({
        id: conversationId,
        orgId,
        userId,
        workspaceId,
        name: "Native chat proof",
      })
    })
    return await withOrgIdContext(org, () =>
      withUserIdContext(userId, () =>
        withTestLogger(() =>
          fn({
            orgId,
            userId,
            orgSlug: orgId,
            workspaceId,
            conversationId,
            directory,
            sha,
            modelRequests,
            request: app.request.bind(app),
          }),
        ),
      ),
    )
  } finally {
    const instances = await withOrgDbContext(orgId, () =>
      listSandboxInstances({ workspaceId }),
    )
    await withOrgIdContext(org, async () => {
      const destroyed = await destroySandboxesForWorkspace(workspaceId)
      if (destroyed !== instances.length)
        throw new Error("Native fixture workspace cleanup failed")
    })
    await withOrgDbContext(orgId, async (db) => {
      for (const table of [chatInterrupts, chatMetadata, chatRuns, chatThreads])
        await db.delete(table).where(eq(table.orgId, orgId))
      await db.delete(conversations).where(eq(conversations.orgId, orgId))
      await db
        .delete(orgFirstWorkspaces)
        .where(eq(orgFirstWorkspaces.orgId, orgId))
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
    for (const threadId of new Set([
      conversationId,
      ...instances.flatMap((instance) =>
        instance.conversationId ? [instance.conversationId] : [],
      ),
    ])) {
      await rm(workspaceChatOpenCodeHomeDir(threadId), {
        recursive: true,
        force: true,
      })
    }
  }
}
