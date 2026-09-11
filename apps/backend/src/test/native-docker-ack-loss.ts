import { createServer, request as nativeRequest } from "node:http"
import { connect as nativeConnect } from "node:net"
import type { Duplex } from "node:stream"

/** Forward the real Docker API, withholding one successful named allocation reply. */
export async function holdDockerAllocationReply(
  socketPath: string,
  options: { holdAnyNamedAllocation?: boolean } = {},
) {
  const upstream = process.env.DOCKER_HOST
  if (upstream && !upstream.startsWith("unix://"))
    throw new Error(
      "The native allocation fault fixture requires a Unix Docker socket",
    )
  const upstreamSocket =
    upstream?.slice("unix://".length) ?? "/var/run/docker.sock"
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let allocated!: (value: { id: string; name: string }) => void
  const allocation = new Promise<{ id: string; name: string }>((resolve) => {
    allocated = resolve
  })
  const lifecycle: string[] = []
  let held = false
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://docker")
    const name = url.searchParams.get("name")
    const target =
      request.method === "POST" &&
      url.pathname.endsWith("/containers/create") &&
      (options.holdAnyNamedAllocation
        ? Boolean(name)
        : name?.startsWith("ctxpipe-semantic-merge-")) &&
      !held
    if (target) lifecycle.push("allocation-request-forwarded")
    const forwarded = nativeRequest(
      {
        socketPath: upstreamSocket,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      async (upstreamResponse) => {
        if (target && upstreamResponse.statusCode === 201 && name) {
          held = true
          lifecycle.push("allocation-created-reply-held")
          const chunks: Buffer[] = []
          for await (const chunk of upstreamResponse)
            chunks.push(Buffer.from(chunk))
          const body = Buffer.concat(chunks)
          const created = JSON.parse(body.toString()) as { Id: string }
          allocated({ id: created.Id, name })
          await released
          lifecycle.push("allocation-release-observed")
          if (!response.destroyed) {
            lifecycle.push("allocation-reply-forwarded")
            response.writeHead(201, upstreamResponse.headers)
            response.end(body)
          } else {
            lifecycle.push("allocation-client-disconnected")
          }
        } else {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          )
          upstreamResponse.pipe(response)
        }
      },
    )
    forwarded.on("error", (error) => {
      if (target) lifecycle.push("allocation-upstream-error")
      if (!response.destroyed) {
        response.writeHead(502)
        response.end(error.message)
      }
    })
    request.pipe(forwarded)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  lifecycle.push("listener-started")
  return {
    socketPath,
    allocation,
    release: () => {
      lifecycle.push("release-requested")
      release()
    },
    trace: () => [...lifecycle],
    close: async () => {
      lifecycle.push("close-requested")
      release()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      lifecycle.push("closed")
    },
  }
}

export async function faultDockerCommitReply(
  socketPath: string,
  mode: "reject-before-forward" | "reset-after-commit",
) {
  const upstream = process.env.DOCKER_HOST
  if (upstream && !upstream.startsWith("unix://"))
    throw new Error(
      "The native commit fault fixture requires a Unix Docker socket",
    )
  const upstreamSocket =
    upstream?.slice("unix://".length) ?? "/var/run/docker.sock"
  let commitRequests = 0
  let faulted!: (value: { containerId: string; imageId?: string }) => void
  const fault = new Promise<{ containerId: string; imageId?: string }>(
    (resolve) => {
      faulted = resolve
    },
  )
  const sockets = new Set<Duplex>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://docker")
    const containerId = url.searchParams.get("container") ?? ""
    const target =
      request.method === "POST" &&
      url.pathname.endsWith("/commit") &&
      Boolean(containerId)
    if (target) commitRequests += 1
    if (target && commitRequests === 1 && mode === "reject-before-forward") {
      request.resume()
      faulted({ containerId })
      response.writeHead(500, { "content-type": "text/plain" })
      response.end("injected snapshot commit failure")
      return
    }
    const forwarded = nativeRequest(
      {
        socketPath: upstreamSocket,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      async (upstreamResponse) => {
        if (
          target &&
          commitRequests === 1 &&
          mode === "reset-after-commit" &&
          upstreamResponse.statusCode === 201
        ) {
          const chunks: Buffer[] = []
          for await (const chunk of upstreamResponse)
            chunks.push(Buffer.from(chunk))
          const body = Buffer.concat(chunks)
          const committed = JSON.parse(body.toString()) as { Id: string }
          faulted({ containerId, imageId: committed.Id })
          response.destroy()
          return
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        )
        upstreamResponse.pipe(response)
      },
    )
    forwarded.on("error", (error) => {
      if (!response.destroyed) {
        response.writeHead(502)
        response.end(error.message)
      }
    })
    request.pipe(forwarded)
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("error", () => socket.destroy())
    socket.once("close", () => sockets.delete(socket))
  })
  server.on("upgrade", (request, socket, head) => {
    const upstream = nativeConnect({ path: upstreamSocket })
    sockets.add(upstream)
    upstream.once("close", () => sockets.delete(upstream))
    upstream.on("error", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
    upstream.once("connect", () => {
      const headers: string[] = []
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        headers.push(
          `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`,
        )
      }
      upstream.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
      )
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    fault,
    commitRequests: () => commitRequests,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
