#!/usr/bin/env node
/* eslint-disable */
/**
 * Minimal stand-in for `@agentmemory/agentmemory` used by supervisor tests.
 *
 * It honours the env contract ctxpipe sets when spawning the real runtime:
 *
 *  - III_REST_PORT     : binds an HTTP server here for /agentmemory/* routes
 *  - AGENTMEMORY_SECRET: optional bearer required by REST callers
 *  - III_STREAMS_PORT, III_VIEWER_PORT, III_ENGINE_PORT: also bound so port
 *    isolation between concurrent supervisors can be verified.
 *
 * Capabilities are deliberately tiny:
 *  - GET /agentmemory/livez             -> 200 OK
 *  - GET /agentmemory/health            -> { ok: true }
 *  - POST /agentmemory/import           -> echoes the payload back
 *  - POST /agentmemory/search           -> returns the in-memory store
 *  - POST /agentmemory/remember         -> appends to the in-memory store
 *  - POST /__test/inject                -> seed memories for tests
 *  - GET  /__test/requests              -> in-memory HTTP request log (for contract tests)
 *  - POST /__test/requests/reset       -> clear the request log
 *  - POST /__test/shutdown              -> graceful exit
 *
 * State is kept in-process and never touches disk so tests can run in
 * parallel without coordinating cleanup.
 */

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

const ports = {
  rest: int(process.env.III_REST_PORT),
  streams: int(process.env.III_STREAMS_PORT),
  viewer: int(process.env.III_VIEWER_PORT),
  engine: int(process.env.III_ENGINE_PORT),
}
const secret = process.env.AGENTMEMORY_SECRET || null
const home = process.env.HOME || process.cwd()
const stateFile = path.join(home, ".agentmemory", "test-state.json")

const memories = new Map()
/** @type {Array<{ method: string, path: string, bodySummary: unknown, at: string }>} */
const requestLog = []

const servers = []

function logRequest(method, path, bodySummary) {
  requestLog.push({
    method,
    path,
    bodySummary,
    at: new Date().toISOString(),
  })
}

function importSummary(payload) {
  if (!payload || typeof payload !== "object") return {}
  const mems =
    payload.exportData && payload.exportData.memories
      ? payload.exportData.memories
      : []
  return {
    strategy: payload.strategy,
    memoryCount: mems.length,
    deletedCount: Array.isArray(payload.deletedIds) ? payload.deletedIds.length : 0,
  }
}

const rest = http.createServer(handle)
servers.push(rest)
rest.listen(ports.rest || 0, "127.0.0.1", () => {
  ensureDir(path.dirname(stateFile))
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      pid: process.pid,
      ports,
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  )
  process.stdout.write(`fake-agentmemory listening on ${rest.address().port}\n`)
})

// Bind the auxiliary ports so concurrent supervisors can prove they were
// allocated distinct ports.
for (const key of ["streams", "viewer", "engine"]) {
  const srv = http.createServer((_, res) => {
    res.statusCode = 204
    res.end()
  })
  servers.push(srv)
  if (ports[key]) srv.listen(ports[key], "127.0.0.1")
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

function shutdown() {
  for (const srv of servers) {
    try {
      srv.close()
    } catch {}
  }
  process.exit(0)
}

function int(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

function unauthorized(res) {
  res.statusCode = 401
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ error: "missing bearer" }))
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => (buf += chunk))
    req.on("end", () => {
      if (!buf) return resolve({})
      try {
        resolve(JSON.parse(buf))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", reject)
  })
}

function authorize(req, res) {
  if (!secret) return true
  const header = req.headers.authorization || ""
  if (!header.startsWith("Bearer ")) {
    unauthorized(res)
    return false
  }
  const token = header.slice("Bearer ".length).trim()
  if (token !== secret) {
    unauthorized(res)
    return false
  }
  return true
}

function handle(req, res) {
  const url = req.url || ""
  if (req.method === "GET" && url === "/agentmemory/livez") {
    res.statusCode = 200
    res.setHeader("content-type", "text/plain")
    res.end("ok")
    return
  }
  if (req.method === "GET" && url === "/agentmemory/health") {
    return send(res, 200, { ok: true, ports })
  }
  if (req.method === "GET" && url === "/__test/requests") {
    return send(res, 200, { requests: requestLog })
  }
  if (req.method === "POST" && url === "/__test/requests/reset") {
    requestLog.length = 0
    return send(res, 200, { ok: true })
  }
  if (req.method === "POST" && url.startsWith("/agentmemory/import")) {
    if (!authorize(req, res)) return
    readJson(req)
      .then((payload) => {
        logRequest("POST", "/agentmemory/import", importSummary(payload))
        if (payload && payload.strategy === "replace") memories.clear()
        const mems = (payload && payload.exportData && payload.exportData.memories) || []
        for (const m of mems) memories.set(m.id, m)
        const deleted = (payload && payload.deletedIds) || []
        for (const id of deleted) {
          memories.delete(`ctxpipe_${id}`)
          memories.delete(id)
        }
        send(res, 200, { imported: mems.length, total: memories.size })
      })
      .catch((err) => send(res, 400, { error: String(err) }))
    return
  }
  if (req.method === "POST" && url.startsWith("/agentmemory/search")) {
    if (!authorize(req, res)) return
    readJson(req)
      .then((payload) => {
        logRequest("POST", "/agentmemory/search", {
          query: (payload && payload.query) || "",
        })
        const q = (payload && payload.query) || ""
        const results = []
        for (const memory of memories.values()) {
          if (`${memory.title}\n${memory.content}`.toLowerCase().includes(q.toLowerCase())) {
            results.push({ ...memory, score: 1 })
          }
        }
        send(res, 200, { results })
      })
      .catch((err) => send(res, 400, { error: String(err) }))
    return
  }
  if (req.method === "POST" && url.startsWith("/agentmemory/remember")) {
    if (!authorize(req, res)) return
    readJson(req)
      .then((payload) => {
        const memory = { ...payload, id: payload.id || `mem-${Date.now()}` }
        memories.set(memory.id, memory)
        send(res, 200, memory)
      })
      .catch((err) => send(res, 400, { error: String(err) }))
    return
  }
  if (req.method === "POST" && url.startsWith("/__test/inject")) {
    readJson(req)
      .then((payload) => {
        for (const memory of payload.memories || []) {
          memories.set(memory.id, memory)
        }
        send(res, 200, { ok: true, total: memories.size })
      })
      .catch((err) => send(res, 400, { error: String(err) }))
    return
  }
  if (req.method === "POST" && url.startsWith("/__test/shutdown")) {
    send(res, 200, { ok: true })
    setTimeout(shutdown, 25)
    return
  }
  send(res, 404, { error: "not found" })
}
