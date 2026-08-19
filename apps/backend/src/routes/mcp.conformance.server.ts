import { createServer } from "node:http"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { z } from "zod"
import type { AppEnv } from "../app/env.js"
import {
  handleMcpTransportRequest,
  rejectInvalidMcpOrigin,
} from "../mcp/transport.js"

const port = Number(process.env.PORT ?? 33123)
const app = new Hono<AppEnv>()

app.use(contextStorage())
app.use(evlog())
app.use("*", async (c, next) => {
  c.set("env", {
    AUTH_BASE_URL: `http://127.0.0.1:${port}`,
  } as AppEnv["Variables"]["env"])
  c.set("user", {
    id: "user_conformance",
    email: "conformance@example.com",
  } as AppEnv["Variables"]["user"])
  c.set("session", {
    id: "session_conformance",
    userId: "user_conformance",
  } as AppEnv["Variables"]["session"])
  c.set("orgSlug", "acme")
  c.set("orgId", "org_conformance")
  await next()
})
app.get("/.status", (c) => c.json({ status: "ok" }))
app.use("/mcp", (c, next) => rejectInvalidMcpOrigin(c) ?? next())
app.all("/mcp", (c) =>
  handleMcpTransportRequest(c, (server) => {
    server.registerTool(
      "conformance_echo",
      {
        title: "Conformance Echo",
        description: "Return text for deterministic MCP conformance checks.",
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => ({
        content: [{ type: "text", text }],
      }),
    )
  }),
)

let shuttingDown = false

const server = createServer(async (req, res) => {
  const host = req.headers.host ?? `127.0.0.1:${port}`
  const url = new URL(req.url ?? "/", `http://${host}`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (typeof value === "string") {
      headers.set(key, value)
    }
  }

  const method = req.method ?? "GET"
  const bodyBuffer =
    method === "GET" || method === "HEAD"
      ? undefined
      : await readRequestBody(req)
  const request = new Request(url, {
    method,
    headers,
    body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
  })

  const response = await app.fetch(request)
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  const arrayBuffer = await response.arrayBuffer()
  res.end(Buffer.from(arrayBuffer))
})

server.listen(port, "127.0.0.1")

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  server.close(() => {
    process.exit(0)
  })
}

process.on("SIGINT", () => {
  void shutdown()
})

process.on("SIGTERM", () => {
  void shutdown()
})

async function readRequestBody(
  request: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    )
  }
  return Buffer.concat(chunks)
}
