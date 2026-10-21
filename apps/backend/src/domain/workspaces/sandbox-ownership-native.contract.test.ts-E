import { createServer, request as httpRequest } from "node:http"
import type { SandboxHandle, SandboxInstanceRecord } from "@tanstack/ai-sandbox"
import { runSandboxInstanceStoreConformance } from "@tanstack/ai-sandbox/testkit"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { withSessionOnlyEnv } from "./sandbox-provider.js"

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

const fixtures: Array<{ orgId: string; workspaceId: string }> = []

beforeAll(() => {
  const url = process.env.DATABASE_URL
  if (!url)
    throw new Error(
      "DATABASE_URL is required for native sandbox ownership proof",
    )
  initDb(url)
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await withOrgDbContext(fixture.orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.id, fixture.workspaceId)),
    )
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, fixture.orgId))
  }
})

afterAll(closeDb)

async function makeStore() {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Native sandbox ownership",
    createdAt: new Date(),
  })
  fixtures.push({ orgId, workspaceId })
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: "https://example.test/context.git",
    }),
  )
  return postgresSandboxInstanceStore({
    orgId,
    workspaceId,
  })
}

runSandboxInstanceStoreConformance("native Postgres", makeStore)

it.each([
  "workspace",
  "conversation",
] as const)("rejects a global sandbox key collision across %s owners", async (scope) => {
  const orgId = generateObjectId("org")
  const firstWorkspaceId = generateObjectId("ws")
  const secondWorkspaceId = generateObjectId("ws")
  const firstConversationId = generateObjectId("conv")
  const secondConversationId = generateObjectId("conv")
  const key = `forced-global-key-collision-${orgId}`
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Sandbox collision proof",
    createdAt: new Date(),
  })
  try {
    await withOrgDbContext(orgId, (db) =>
      db.transaction(async (tx) => {
        await tx.insert(workspaces).values([
          {
            id: firstWorkspaceId,
            orgId,
            slug: "collision-a",
            displayName: "Collision A",
            workspaceRepositoryUrl: "https://example.test/collision-a.git",
          },
          {
            id: secondWorkspaceId,
            orgId,
            slug: "collision-b",
            displayName: "Collision B",
            workspaceRepositoryUrl: "https://example.test/collision-b.git",
          },
        ])
        await tx.insert(conversations).values([
          {
            id: firstConversationId,
            orgId,
            workspaceId: firstWorkspaceId,
          },
          {
            id: secondConversationId,
            orgId,
            workspaceId:
              scope === "workspace" ? secondWorkspaceId : firstWorkspaceId,
          },
        ])
      }),
    )
    const first = postgresSandboxInstanceStore({
      orgId,
      workspaceId: firstWorkspaceId,
      conversationId: firstConversationId,
      provider: "docker",
      image: "node:22",
    })
    const second = postgresSandboxInstanceStore({
      orgId,
      workspaceId: scope === "workspace" ? secondWorkspaceId : firstWorkspaceId,
      conversationId: secondConversationId,
      provider: "docker",
      image: "node:22",
    })
    const owned: SandboxInstanceRecord = {
      key,
      provider: "docker",
      providerSandboxId: "container-owned-by-a",
      threadId: firstConversationId,
      updatedAt: 1,
    }
    await first.upsert(owned)
    await expect(second.get(key)).rejects.toThrow(
      "already owned by another workspace identity",
    )
    await expect(
      second.upsert({
        ...owned,
        providerSandboxId: "container-owned-by-b",
        threadId: secondConversationId,
      }),
    ).rejects.toThrow("already owned by another workspace identity")
    await expect(second.delete(key)).rejects.toThrow(
      "already owned by another workspace identity",
    )
    expect(await first.get(key)).toEqual(owned)
  } finally {
    await withOrgDbContext(orgId, (db) =>
      db.transaction(async (tx) => {
        await tx.delete(conversations).where(eq(conversations.orgId, orgId))
        await tx.delete(workspaces).where(eq(workspaces.orgId, orgId))
      }),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
})

it(
  "keeps sandbox secrets out of Docker create requests",
  { timeout: 30_000 },
  async () => {
    const endpoint = dockerEndpoint()
    const paths: string[] = []
    let createBody = ""
    const proxy = createServer((request, response) => {
      paths.push(request.url ?? "")
      if (request.url?.includes("/containers/create"))
        request.on("data", (chunk) => {
          createBody += chunk.toString()
        })
      const upstream = httpRequest(
        {
          ...("socketPath" in endpoint
            ? { socketPath: endpoint.socketPath }
            : { hostname: endpoint.host, port: endpoint.port }),
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers)
          result.pipe(response)
        },
      )
      upstream.on("error", (error) => response.destroy(error))
      request.pipe(upstream)
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject)
      proxy.listen(0, "127.0.0.1", resolve)
    })
    const address = proxy.address()
    if (!address || typeof address === "string")
      throw new Error("Docker transport proxy did not bind")
    const provider = withSessionOnlyEnv(
      dockerSandbox({
        image: "alpine:3.22",
        workdir: "/tmp",
        keepAliveCommand: ["/ctxpipe-deliberately-missing-command"],
        dockerodeOptions: { host: "127.0.0.1", port: address.port },
      }),
    )
    try {
      await expect(
        provider.create({
          workspace: { source: { type: "none" } },
          env: { SYNTHETIC_CREDENTIAL: "ctxpipe-native-env-not-in-url" },
        }),
      ).rejects.toThrow(/no such file or directory|executable file not found/i)
      expect(JSON.parse(createBody).Env ?? []).not.toContain(
        "SYNTHETIC_CREDENTIAL=ctxpipe-native-env-not-in-url",
      )
      expect(
        paths.some((path) =>
          decodeURIComponent(path).includes("ctxpipe-native-env-not-in-url"),
        ),
      ).toBe(false)
    } finally {
      proxy.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      )
    }
  },
)

it(
  "applies session environment, including HOME, to Docker commands and resumes",
  { timeout: 30_000 },
  async () => {
    const endpoint = dockerEndpoint()
    const provider = dockerSandbox({
      image: "alpine:3.22",
      workdir: "/tmp",
      dockerodeOptions: endpoint,
    })
    const handle = await provider.create({})
    try {
      // Workspace secrets, including the chat HOME, are session environment.
      await handle.env.set({
        HOME: "/tmp/native-home",
        NATIVE_RUNTIME: "session",
      })
      const result = await handle.process.exec(
        'printf "%s|%s|%s" "$HOME" "$NATIVE_RUNTIME" "$NATIVE_COMMAND"',
        { env: { NATIVE_COMMAND: "command" } },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("/tmp/native-home|session|command")
      const resumed = await provider.resume({ id: handle.id })
      if (!resumed) throw new Error("Native Docker container did not resume")
      await resumed.env.set({ HOME: "/tmp/native-home" })
      expect((await resumed.process.exec('printf "%s" "$HOME"')).stdout).toBe(
        "/tmp/native-home",
      )
    } finally {
      await handle.destroy()
    }
  },
)

it(
  "connects to native Docker published ports through the public channel",
  { timeout: 60_000 },
  async () => {
    const endpoint = dockerEndpoint()
    const dockerodeOptions = endpoint
    const baseConfig = {
      image: "alpine:3.22",
      workdir: "/tmp",
      dockerodeOptions,
      publishPorts: [8080],
    }
    const defaultProvider = dockerSandbox(baseConfig)

    type RunningServer = {
      handle: SandboxHandle
      process: Awaited<ReturnType<SandboxHandle["process"]["spawn"]>>
      channel: { url: string }
    }
    async function startServer(
      provider: typeof defaultProvider,
      body: string,
    ): Promise<RunningServer> {
      const handle = await provider.create({
        workspace: { source: { type: "none" } },
      })
      let serverProcess: RunningServer["process"] | undefined
      try {
        const responseScript = [
          "#!/bin/sh",
          `body=${shellQuote(body)}`,
          `printf 'HTTP/1.1 200 OK\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\nContent-Type: text/plain\\r\\n\\r\\n%s' "\${#body}" "$body"`,
        ].join("\n")
        await handle.fs.write("/tmp/reply.sh", responseScript)
        await handle.process.exec("chmod +x reply.sh", { cwd: "/tmp" })
        serverProcess = await handle.process.spawn(
          "nc -lk -p 8080 -e /tmp/reply.sh",
          { cwd: "/tmp" },
        )
        const channel = await handle.ports.connect(8080)
        return { handle, process: serverProcess, channel }
      } catch (error) {
        const cleanup = await Promise.allSettled([
          serverProcess?.kill() ?? Promise.resolve(),
          handle.destroy(),
        ])
        const cleanupErrors = cleanup
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason)
        if (cleanupErrors.length)
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Native port server startup and cleanup failed",
          )
        throw error
      }
    }
    async function fetchBody(url: string, expected: string): Promise<void> {
      let lastError: unknown
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(1_000),
          })
          expect(await response.text()).toContain(expected)
          return
        } catch (error) {
          lastError = error
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      throw lastError
    }
    function shellQuote(value: string): string {
      return `'${value.replaceAll("'", "'\\''")}'`
    }
    async function disposeServer(server: RunningServer | undefined) {
      if (!server) return
      const cleanup = await Promise.allSettled([
        server.process.kill(),
        server.handle.destroy(),
      ])
      const cleanupErrors = cleanup
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason)
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          "Native port server cleanup failed",
        )
    }

    let defaultServer: RunningServer | undefined
    let testError: unknown
    try {
      defaultServer = await startServer(defaultProvider, "default-channel")
      await fetchBody(defaultServer.channel.url, "default-channel")
    } catch (error) {
      testError = error
    }
    const cleanup = await Promise.allSettled([disposeServer(defaultServer)])
    const cleanupErrors = cleanup
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason)
    if (testError && cleanupErrors.length)
      throw new AggregateError(
        [testError, ...cleanupErrors],
        "Native port contract and cleanup both failed",
      )
    if (testError) throw testError
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Native port cleanup failed")
  },
)
