import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, get as httpGet } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { shim as makeShim } from "../chat-sandbox/agentcore-shim.mjs"

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  )

/** The shim's events for one invocation, in order. */
async function invoke(shimPort, payload) {
  const response = await fetch(`http://127.0.0.1:${shimPort}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  return (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.replace(/^data: /, "")))
}

const bodyOf = (events) =>
  Buffer.concat(
    events
      .filter((event) => event.type === "body")
      .map((event) => Buffer.from(event.data, "base64")),
  ).toString("utf8")

test("the shim answers the AgentCore health check", async (t) => {
  const shim = makeShim().invocations
  t.after(() => shim.close())
  const response = await fetch(`http://127.0.0.1:${await listen(shim)}/ping`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: "Healthy" })
})

test("the shim forwards a request to a sandbox port and streams the answer", async (t) => {
  const seen = []
  const upstream = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        connection: request.headers["x-custom-connection"],
        body,
      })
      response.writeHead(201, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  const shim = makeShim().invocations
  t.after(() => {
    upstream.close()
    shim.close()
  })
  const port = await listen(upstream)
  const events = await invoke(await listen(shim), {
    action: "http",
    port,
    method: "POST",
    path: "/session?directory=%2Fworkspace",
    headers: {
      Authorization: "Basic b3BlbmNvZGU6cHc=",
      Host: "other.example",
      "x-custom-connection": "kept",
    },
    body: Buffer.from('{"title":"t"}').toString("base64"),
  })
  assert.deepEqual(seen, [
    {
      method: "POST",
      url: "/session?directory=%2Fworkspace",
      authorization: "Basic b3BlbmNvZGU6cHc=",
      connection: "kept",
      body: '{"title":"t"}',
    },
  ])
  assert.equal(events[0].type, "head")
  assert.equal(events[0].status, 201)
  assert.equal(events[0].headers["content-type"], "application/json")
  assert.equal(events[0].headers["content-length"], undefined)
  assert.equal(bodyOf(events), '{"ok":true}')
  assert.deepEqual(events.at(-1), { type: "end" })
})

test("the shim stops the request to the port when the backend closes the invocation", async (t) => {
  let upstreamClosed
  const closed = new Promise((resolve) => (upstreamClosed = resolve))
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: first\n\n")
    request.on("close", upstreamClosed)
  })
  const shim = makeShim().invocations
  t.after(() => {
    upstream.close()
    shim.close()
  })
  const port = await listen(upstream)
  const controller = new AbortController()
  const response = await fetch(
    `http://127.0.0.1:${await listen(shim)}/invocations`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "http",
        port,
        method: "GET",
        path: "/event",
      }),
      signal: controller.signal,
    },
  )
  const reader = response.body.getReader()
  let text = ""
  while (!text.includes('"type":"body"'))
    text += new TextDecoder().decode((await reader.read()).value)
  controller.abort()
  await closed
})

test("the shim refuses a request that is not a forward to a sandbox port", async (t) => {
  const shim = makeShim().invocations
  t.after(() => shim.close())
  const port = await listen(shim)
  for (const [payload, message] of [
    [{ action: "exec" }, "The action must be http or put"],
    [
      { action: "http", port: 8080, method: "GET", path: "/" },
      "The port must be a sandbox port other than 8080",
    ],
    [
      { action: "http", port: 4096, method: "GET", path: "http://evil/" },
      "The path must start with /",
    ],
  ])
    assert.deepEqual(await invoke(port, payload), [{ type: "error", message }])
})

test("the shim reports a port that does not answer", async (t) => {
  const gone = createServer()
  const closedPort = await listen(gone)
  // Closed again, so the port refuses connections.
  await new Promise((resolve) => gone.close(resolve))
  const shim = makeShim().invocations
  t.after(() => shim.close())
  const events = await invoke(await listen(shim), {
    action: "http",
    port: closedPort,
    method: "GET",
    path: "/",
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, "error")
})

test("the shim uses no Node crypto: no import and no global (spike CTX-1213, test 3)", () => {
  const code = readFileSync(
    new URL("../chat-sandbox/agentcore-shim.mjs", import.meta.url),
    "utf8",
  )
    // Comments may name crypto; code may not.
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  assert.doesNotMatch(code, /\bcrypto\b|randomUUID|getRandomValues|randomBytes/)
})

/** GET a path on a Unix socket: the status and the body. */
const getOnSocket = (socketPath, path) =>
  new Promise((resolve, reject) => {
    httpGet({ socketPath, path }, (answer) => {
      const chunks = []
      answer.on("data", (chunk) => chunks.push(chunk))
      answer.on("end", () =>
        resolve({ status: answer.statusCode, body: Buffer.concat(chunks) }),
      )
    }).on("error", reject)
  })

test("the shim keeps a blob for one read on its socket, not on TCP", async (t) => {
  const { invocations, blobs } = makeShim()
  const folder = mkdtempSync(join(tmpdir(), "shim-"))
  const socket = join(folder, "blobs.sock")
  await new Promise((resolve) => blobs.listen(socket, resolve))
  t.after(() => {
    invocations.close()
    blobs.close()
    rmSync(folder, { recursive: true, force: true })
  })
  const port = await listen(invocations)
  const id = "a".repeat(32)
  const data = Buffer.from("export HTTPS_PROXY='https://session@vault:14322'\n")
  assert.deepEqual(
    await invoke(port, { action: "put", id, data: data.toString("base64") }),
    [{ type: "stored" }],
  )
  // A second put with the same id does not replace the first.
  assert.deepEqual(await invoke(port, { action: "put", id, data: "eA==" }), [
    { type: "error", message: "The id is in use" },
  ])
  // AgentCore's port does not serve blobs.
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/blobs/${id}`)).status,
    404,
  )
  const first = await getOnSocket(socket, `/blobs/${id}`)
  assert.equal(first.status, 200)
  assert.deepEqual(first.body, data)
  assert.equal((await getOnSocket(socket, `/blobs/${id}`)).status, 404)
  assert.deepEqual(
    await invoke(port, { action: "put", id: "short", data: "" }),
    [{ type: "error", message: "The id must be 32 to 64 hex characters" }],
  )
})
