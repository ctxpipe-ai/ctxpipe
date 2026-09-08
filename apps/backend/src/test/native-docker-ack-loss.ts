import { createServer, request as nativeRequest } from "node:http"

/** Forward the real Docker API, withholding one successful named allocation reply. */
export async function holdDockerAllocationReply(socketPath: string) {
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
  let held = false
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://docker")
    const name = url.searchParams.get("name")
    const target =
      request.method === "POST" &&
      url.pathname.endsWith("/containers/create") &&
      name?.startsWith("ctxpipe-semantic-merge-") &&
      !held
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
          const chunks: Buffer[] = []
          for await (const chunk of upstreamResponse)
            chunks.push(Buffer.from(chunk))
          const body = Buffer.concat(chunks)
          const created = JSON.parse(body.toString()) as { Id: string }
          allocated({ id: created.Id, name })
          await released
          if (!response.destroyed) {
            response.writeHead(201, upstreamResponse.headers)
            response.end(body)
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
  return {
    socketPath,
    allocation,
    release,
    close: async () => {
      release()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
