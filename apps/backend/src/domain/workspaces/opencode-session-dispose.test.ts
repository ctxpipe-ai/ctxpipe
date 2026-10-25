import { createServer } from "node:http"

import { startOpencodeSession } from "@tanstack/ai-opencode"
import { afterEach, expect, it } from "vitest"

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

it(
  "does not reconnect to a stopped OpenCode server after its session is disposed (CTX-848)",
  {
    timeout: 15_000,
  },
  async () => {
    // An OpenCode server that sends one event and then stays silent, as an
    // idle OpenCode does after a turn. Before the fix, a silent stream kept
    // its request open after dispose. When the server then stopped, the SDK
    // reconnected to it without end (3 s, 6 s, ... up to 30 s apart), and that
    // kept the backend process alive.
    let eventRequests = 0
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url?.startsWith("/session")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ id: "ses_fixture" }))
        return
      }
      if (request.url?.startsWith("/event")) {
        eventRequests += 1
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(
          `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
        )
        return
      }
      response.writeHead(404).end()
    })
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    )
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("fixture did not bind")

    const session = await startOpencodeSession({
      baseUrl: `http://127.0.0.1:${address.port}`,
      providerID: "synthetic",
      modelID: "probe",
      onEvent: () => undefined,
      onPermissionRequest: () => "reject",
    })
    await session.dispose()
    // The server stops: its connections drop. The SDK's first reconnect
    // comes 3 s after the drop.
    server.closeAllConnections()
    await new Promise((resolve) => setTimeout(resolve, 3_500))

    expect(eventRequests).toBe(1)
  },
)
