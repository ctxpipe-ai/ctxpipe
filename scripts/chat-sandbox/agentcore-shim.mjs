// The AgentCore entry point of the chat sandbox image (CTX-1219; design in
// the AWS migration epic, CTX-1212). AgentCore sends HTTP to port 8080 only:
// `GET /ping` and `POST /invocations`. Each invocation has one action:
//
// - `http`: the backend reaches a port in the sandbox (the OpenCode server)
//   through the shim. The shim sends the request to `127.0.0.1:<port>` and
//   streams the answer back as server-sent events.
// - `put`: the backend stores data for one read by a command in the sandbox
//   (`GET /blobs/<id>` on a Unix socket only `node` and root can reach,
//   see `BLOB_SOCKET`). AgentCore writes the text of
//   each command to the runtime's CloudWatch log group, but not an
//   invocation payload. Thus the scripts and the files that the backend
//   sends (with proxy sessions and repository content) go through `put`, and
//   a command holds only the id. A blob is deleted at its first read or
//   after 5 minutes.
//
// The V2 memory snapshot holds this process only. OpenCode starts later, as
// a command. The shim does not create a secret and does not use Node
// `crypto`:
// random values made in a restored process repeat across sessions (spike
// CTX-1213, test 3).
//
// Request bodies (JSON):
//   { "action": "http", "port": 4096, "method": "GET", "path": "/event",
//     "headers": { "name": "value" }, "body": "<base64>" }
//   { "action": "put", "id": "<32 to 64 hex>", "data": "<base64>" }
// Answer events (`data: <JSON>`), in order:
//   http: { "type": "head", "status": 200, "headers": { "name": "value" } }
//         { "type": "body", "data": "<base64>" }   (zero or more)
//         { "type": "end" }
//   put:  { "type": "stored" }
//   both: { "type": "error", "message": "..." } instead, on a failure
import { lstatSync, mkdirSync, rmSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

/** Headers that belong to one connection, not to the request. */
const HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** The end-to-end headers of a request or an answer, each as one value. */
function endToEndHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (HOP_HEADERS.has(name.toLowerCase())) continue
    if (typeof value === "string") result[name] = value
    else if (Array.isArray(value)) result[name] = value.join(", ")
  }
  return result
}

/**
 * The blobs of `put`, each until its first read or its expiry. `put` gives
 * `{ error }` for data that it does not store; `take` gives the bytes of a
 * blob once, or undefined.
 */
function blobStore() {
  const blobs = new Map()
  const validId = (id) => typeof id === "string" && /^[0-9a-f]{32,64}$/.test(id)
  return {
    put({ id, data }) {
      if (!validId(id))
        return { error: "The id must be 32 to 64 hex characters" }
      if (typeof data !== "string")
        return { error: "The data must be base64 text" }
      if (blobs.has(id)) return { error: "The id is in use" }
      const bytes = Buffer.from(data, "base64")
      let stored = bytes.length
      for (const blob of blobs.values()) stored += blob.bytes.length
      // Blobs are scripts and files; the store holds at most 256 MiB.
      if (stored > 256 * 1024 * 1024) return { error: "The blob store is full" }
      const expiry = setTimeout(() => blobs.delete(id), 5 * 60_000)
      expiry.unref()
      blobs.set(id, { bytes, expiry })
      return {}
    },
    take(id) {
      const blob = validId(id) ? blobs.get(id) : undefined
      if (!blob) return undefined
      blobs.delete(id)
      clearTimeout(blob.expiry)
      return blob.bytes
    },
  }
}

/** `{ forward }`, or `{ error }` for a payload that is not a forward request. */
function parseForward(payload) {
  const { port, method, path } = payload
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 8080)
    return { error: "The port must be a sandbox port other than 8080" }
  if (typeof method !== "string" || !/^[A-Z]+$/.test(method))
    return { error: "The method is not valid" }
  if (typeof path !== "string" || !path.startsWith("/"))
    return { error: "The path must start with /" }
  if (payload.body !== undefined && typeof payload.body !== "string")
    return { error: "The body must be base64 text" }
  return {
    forward: {
      port,
      method,
      path,
      headers: endToEndHeaders(payload.headers),
      body: payload.body ? Buffer.from(payload.body, "base64") : undefined,
    },
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

async function invoke(store, request, response) {
  let payload
  try {
    payload = JSON.parse(await readBody(request))
  } catch {
    payload = undefined
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  })
  let open = true
  const send = (event) => {
    if (open) response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const finish = (event) => {
    send(event)
    open = false
    response.end()
  }
  if (payload?.action === "put") {
    const { error } = store.put(payload)
    return finish(
      error ? { type: "error", message: error } : { type: "stored" },
    )
  }
  if (payload?.action !== "http")
    return finish({
      type: "error",
      message: payload
        ? "The action must be http or put"
        : "The request body is not JSON",
    })
  const { forward, error } = parseForward(payload)
  if (error) return finish({ type: "error", message: error })
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: forward.port,
      method: forward.method,
      path: forward.path,
      headers: forward.headers,
    },
    (answer) => {
      send({
        type: "head",
        status: answer.statusCode,
        headers: endToEndHeaders(answer.headers),
      })
      answer.on("data", (chunk) => {
        send({ type: "body", data: chunk.toString("base64") })
        // A slow reader: hold the port's answer until the buffer drains.
        if (open && response.writableNeedDrain) {
          answer.pause()
          response.once("drain", () => answer.resume())
        }
      })
      answer.on("end", () => finish({ type: "end" }))
      answer.on("error", (error) =>
        finish({ type: "error", message: String(error) }),
      )
    },
  )
  upstream.on("error", (error) => {
    if (open) finish({ type: "error", message: String(error) })
  })
  // The backend closed the invocation: stop the request to the port too, so
  // a long answer (OpenCode's event stream) does not stay open.
  response.on("close", () => {
    open = false
    upstream.destroy()
  })
  upstream.end(forward.body)
}

/**
 * The shim's two servers, not listening yet, on one blob store:
 * `invocations` for AgentCore on TCP 8080 (`GET /ping`, `POST /invocations`),
 * and `blobs` for commands in the sandbox (`GET /blobs/<id>`). The blob
 * server listens only on a Unix socket in a folder of the shim's user
 * (`node`), so root and `node` can read a blob and the ingest agent user
 * (ADR-052) cannot, also when it sees a blob id in a command line.
 */
export function shim() {
  const store = blobStore()
  return {
    invocations: createServer((request, response) => {
      if (request.method === "GET" && request.url === "/ping") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ status: "Healthy" }))
        return
      }
      if (
        request.method === "POST" &&
        request.url?.startsWith("/invocations")
      ) {
        invoke(store, request, response).catch((error) => {
          if (!response.headersSent) response.writeHead(500)
          response.end(String(error))
        })
        return
      }
      response.writeHead(404).end()
    })
      // No request timeout: an event stream can stay open for a whole turn.
      .setTimeout(0),
    blobs: createServer((request, response) => {
      const bytes =
        request.method === "GET" && request.url?.startsWith("/blobs/")
          ? store.take(request.url.slice("/blobs/".length))
          : undefined
      if (!bytes) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
      })
      response.end(bytes)
    }),
  }
}

/** Where commands read blobs: a socket in a folder that only `node` owns. */
export const BLOB_SOCKET = "/tmp/ctxpipe-shim/blobs.sock"

/**
 * Make the socket's folder, mode 0700 and owned by this process's user. The
 * shim starts before any command, but the check also refuses a folder that
 * another user made first.
 */
function blobSocketFolder(folder) {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const stat = lstatSync(folder)
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error(`${folder} must be a 0700 folder of the shim's user`)
  rmSync(join(folder, "blobs.sock"), { force: true })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { invocations, blobs } = shim()
  blobSocketFolder(dirname(BLOB_SOCKET))
  blobs.listen(BLOB_SOCKET)
  invocations.listen(8080, "0.0.0.0")
}
