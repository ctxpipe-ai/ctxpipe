import { createServer } from "node:http"
import { createApp } from "../app/app.js"
import { closeDb } from "../db/client.js"

const app = createApp()
const port = Number(process.env.PORT ?? 33123)
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
    method === "GET" || method === "HEAD" ? undefined : await readRequestBody(req)
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
  await closeDb()
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

async function readRequestBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
