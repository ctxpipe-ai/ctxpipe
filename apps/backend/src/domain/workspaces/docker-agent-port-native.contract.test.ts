import { type AddressInfo, connect, createServer, type Socket } from "node:net"
import { startOpencodeServerInSandbox } from "@tanstack/ai-opencode"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { expect, it, vi } from "vitest"
import {
  WORKSPACE_CHAT_OPENCODE_PORT,
  workspaceChatDockerImage,
} from "./chat-runtime.js"
import { withDockerAgentPort } from "./sandbox-provider.js"
import { conversationSandboxProvider } from "./tanstack-workspace-chat.js"

/** The stock local Docker daemon: `DOCKER_HOST`, else the default socket. */
function dockerEndpoint():
  | { socketPath: string }
  | { host: string; port: number } {
  const value = process.env.DOCKER_HOST?.trim()
  if (value?.startsWith("tcp://")) {
    const url = new URL(value.replace("tcp://", "http://"))
    return { host: url.hostname, port: Number(url.port) }
  }
  if (value?.startsWith("unix://")) return { socketPath: value.slice(7) }
  return { socketPath: "/var/run/docker.sock" }
}

it(
  "reaches the agent port on the daemon's host and only with the agent password",
  { timeout: 120_000 },
  async () => {
    // The daemon is reached over TCP at 127.0.0.1, as a remote daemon would
    // be at its own host; stock `ports.connect` answers `localhost` regardless.
    const endpoint = dockerEndpoint()
    // A byte-level relay, so Docker's upgraded exec streams pass unchanged.
    const sockets = new Set<Socket>()
    const proxy = createServer((client) => {
      sockets.add(client)
      client.on("close", () => sockets.delete(client))
      const upstream =
        "socketPath" in endpoint
          ? connect(endpoint.socketPath)
          : connect(endpoint.port, endpoint.host)
      client.on("error", () => upstream.destroy())
      upstream.on("error", () => client.destroy())
      client.pipe(upstream).pipe(client)
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject)
      proxy.listen(0, "127.0.0.1", resolve)
    })
    const { port } = proxy.address() as AddressInfo
    const provider = withDockerAgentPort(
      dockerSandbox({
        image: workspaceChatDockerImage(),
        publishPorts: [WORKSPACE_CHAT_OPENCODE_PORT],
        dockerodeOptions: { host: "127.0.0.1", port },
      }),
      { agentPassword: "native-agent-password", daemonHost: "127.0.0.1" },
    )
    let handle: SandboxHandle | undefined
    let server:
      | Awaited<ReturnType<typeof startOpencodeServerInSandbox>>
      | undefined
    try {
      handle = await provider.create({
        workspace: { source: { type: "none" } },
      })
      server = await startOpencodeServerInSandbox(handle, {
        port: WORKSPACE_CHAT_OPENCODE_PORT,
        cwd: "/workspace",
        // Production passes the session HOME the same way.
        env: { HOME: "/tmp/ctxpipe-opencode-home" },
        timeoutMs: 60_000,
      })
      expect(new URL(server.baseUrl).hostname).toBe("127.0.0.1")
      expect(server.headers?.Authorization).toBe(
        `Basic ${Buffer.from("opencode:native-agent-password").toString("base64")}`,
      )
      const anonymous = await fetch(`${server.baseUrl}/config`)
      expect(anonymous.status).toBe(401)
      const authorized = await fetch(`${server.baseUrl}/config`, {
        headers: server.headers,
      })
      expect(authorized.status).toBe(200)
    } finally {
      await server?.dispose().catch(() => undefined)
      await handle?.destroy().catch(() => undefined)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  },
)

it(
  "starts the agent server in a reused Docker sandbox after a dead backend left its server running",
  { timeout: 180_000 },
  async () => {
    vi.stubEnv("AUTH_SECRET", "native-docker-reuse-secret-0123456789abcdef")
    const provider = conversationSandboxProvider(
      "docker",
      `docker-reuse-${Date.now()}`,
    )
    const options = {
      port: WORKSPACE_CHAT_OPENCODE_PORT,
      cwd: "/workspace",
      env: { HOME: "/tmp/ctxpipe-opencode-home" },
      timeoutMs: 60_000,
    }
    let handle: SandboxHandle | undefined
    let server:
      | Awaited<ReturnType<typeof startOpencodeServerInSandbox>>
      | undefined
    try {
      handle = await provider.create({
        workspace: { source: { type: "none" } },
      })
      // The first turn's backend dies: nothing disposes this server, and it
      // keeps the agent port in the sandbox.
      await startOpencodeServerInSandbox(handle, options)
      // The next turn resumes the same sandbox from its id.
      const reused = await provider.resume({ id: handle.id })
      if (!reused) throw new Error("The Docker sandbox did not resume")
      server = await startOpencodeServerInSandbox(reused, options)
      const config = await fetch(`${server.baseUrl}/config`, {
        headers: server.headers,
      })
      expect(config.status).toBe(200)
    } finally {
      vi.unstubAllEnvs()
      await server?.dispose().catch(() => undefined)
      await handle?.destroy().catch(() => undefined)
    }
  },
)
