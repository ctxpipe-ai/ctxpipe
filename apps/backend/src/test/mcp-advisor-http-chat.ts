import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { evlog } from "evlog/hono"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaces } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { registerMcpRoutes } from "../routes/mcp.js"
import { workspaceChatOpenaiRoutes } from "../routes/v1/workspace-chat-openai.js"
import { contextStorage, withTestRequestLogger } from "./hono-test-logger.js"

export type McpAdvisorHttpChatServer = {
  origin: string
  port: number
  workspaceId: string
  directory: string
  sha: string
  close: () => Promise<void>
}

/** Listening MCP + workspace-chat model proxy so OpenCode can reach the proxy. */
export async function startMcpAdvisorHttpChat(input: {
  orgId: string
  orgSlug: string
}): Promise<McpAdvisorHttpChatServer> {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-mcp-advisor-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
  git("init", "-b", "main")
  await writeFile(join(directory, "README.md"), "# MCP advisor continuity\n")
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
  const workspaceId = generateObjectId("ws")
  await withOrgDbContext(input.orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId: input.orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: directory,
      desiredSha: sha,
      desiredDefaultBranch: "main",
      writeStatus: "read_only",
    }),
  )

  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", backendOtelMiddleware())
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env as Record<string, string | undefined>))
    c.set("user", null)
    c.set("session", null)
    c.set("oauthOrganizationId", null)
    c.set("oauthClientId", null)
    c.set("orgApiKey", null)
    c.set("personalApiKeyId", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
  app.route(
    `/${input.orgSlug}/api/v1/workspace-chat/openai`,
    workspaceChatOpenaiRoutes,
  )
  registerMcpRoutes(app)

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
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

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("MCP advisor HTTP port missing")
  }
  const previousPort = process.env.PORT
  process.env.PORT = String(address.port)

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    workspaceId,
    directory,
    sha,
    close: async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
        await rm(directory, { recursive: true, force: true })
      } finally {
        if (previousPort === undefined) delete process.env.PORT
        else process.env.PORT = previousPort
      }
    },
  }
}
