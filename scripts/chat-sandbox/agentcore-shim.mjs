// The AgentCore entry point of the chat sandbox image (CTX-1219; design in
// the AWS migration epic, CTX-1212). AgentCore sends HTTP to port 8080 only: `GET /ping` and
// `POST /invocations`. The backend reaches a port in the sandbox (the
// OpenCode server) through this shim: each invocation carries one HTTP
// request, and the shim sends it to `127.0.0.1:<port>` and streams the
// answer back as server-sent events.
//
// The V2 memory snapshot holds this process only. OpenCode starts later, as
// a command. The shim does not create a secret and does not use Node
// `crypto`:
// random values made in a restored process repeat across sessions (spike
// CTX-1213, test 3).
//
// Request body (JSON):
//   { "action": "http", "port": 4096, "method": "GET", "path": "/event",
//     "headers": { "name": "value" }, "body": "<base64>" }
// Answer events (`data: <JSON>`), in order:
//   { "type": "head", "status": 200, "headers": { "name": "value" } }
//   { "type": "body", "data": "<base64>" }   (zero or more)
//   { "type": "end" }  or  { "type": "error", "message": "..." }
import { createServer, request as httpRequest } from "node:http"
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

/** `{ forward }`, or `{ error }` for a body that is not a forward request. */
function parseForward(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { error: "The request body is not JSON" }
  }
  if (payload?.action !== "http") return { error: "The action must be http" }
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

async function invoke(request, response) {
  const { forward, error } = parseForward(await readBody(request))
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
      answer.on("data", (chunk) =>
        send({ type: "body", data: chunk.toString("base64") }),
      )
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

/** The shim's HTTP server; not listening yet. */
export function shimServer() {
  return (
    createServer((request, response) => {
      if (request.method === "GET" && request.url === "/ping") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ status: "Healthy" }))
        return
      }
      if (request.method === "POST" && request.url?.startsWith("/invocations")) {
        invoke(request, response).catch((error) => {
          if (!response.headersSent) response.writeHead(500)
          response.end(String(error))
        })
        return
      }
      response.writeHead(404).end()
    })
      // No request timeout: an event stream can stay open for a whole turn.
      .setTimeout(0)
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  shimServer().listen(8080, "0.0.0.0")
