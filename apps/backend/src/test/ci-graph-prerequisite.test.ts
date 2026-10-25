import net from "node:net"

import { expect, it } from "vitest"

import { graphReady } from "../../../../scripts/ci/graph-ready.mjs"

it("CI graph prerequisite fails at its deadline when the server accepts but never answers", async () => {
  // The sockets stay open on purpose: closing them makes the Redis client
  // emit an error on an emitter that connect() never returned.
  const server = net.createServer((socket) => socket.unref())
  server.unref()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  await expect(graphReady(`redis://127.0.0.1:${port}`, 300, 2)).rejects.toThrow(
    /did not answer within 300 ms \(connect\)/,
  )
})
