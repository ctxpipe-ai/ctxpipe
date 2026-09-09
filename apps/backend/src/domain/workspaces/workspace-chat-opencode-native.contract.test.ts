import { mkdtemp, rm } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type SandboxOpencodeServer,
  startOpencodeServerInSandbox,
  startOpencodeSession,
} from "@tanstack/ai-opencode"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { expect, it } from "vitest"

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

it(
  "connects to the port OpenCode reports when local-process requests port 0",
  { timeout: 60_000 },
  async () => {
    const directories = await Promise.all([
      mkdtemp(join(tmpdir(), "ctxpipe-opencode-a-")),
      mkdtemp(join(tmpdir(), "ctxpipe-opencode-b-")),
    ])
    const entries = await Promise.all(
      directories.map(async (directory) => ({
        directory,
        sandbox: await localProcessSandbox({
          dir: directory,
          removeOnDestroy: true,
        }).create({
          id: directory,
          workspace: { source: { type: "none" } },
        }),
      })),
    )
    const sandboxes = entries.map(({ sandbox }) => sandbox)
    let servers: Array<SandboxOpencodeServer> = []
    const failures: unknown[] = []
    try {
      await Promise.all(
        entries.map(({ directory, sandbox }) =>
          sandbox.env.set({
            XDG_DATA_HOME: join(directory, "data"),
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["synthetic"],
              provider: {
                synthetic: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "synthetic",
                  options: {
                    baseURL: "http://127.0.0.1:9",
                    apiKey: "synthetic-test-key",
                  },
                  models: { probe: { name: "probe" } },
                },
              },
            }),
          }),
        ),
      )
      const started = await Promise.allSettled(
        entries.map(({ sandbox }) =>
          startOpencodeServerInSandbox(sandbox, {
            port: 0,
            hostname: "127.0.0.1",
            cwd: ".",
          }),
        ),
      )
      servers = started.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      )
      for (const result of started)
        if (result.status === "rejected") throw result.reason
      const urls = servers.map((server) => new URL(server.baseUrl))
      for (const url of urls) expect(url.port).toMatch(/^[1-9]\d*$/)
      expect(urls[0]?.port).not.toBe(urls[1]?.port)
      const health = await Promise.all(
        urls.map(async (url) => {
          const response = await fetch(`${url.origin}/global/health`)
          expect(response.status).toBe(200)
          return response.json()
        }),
      )
      expect(health).toEqual([
        { healthy: true, version: "1.18.18" },
        { healthy: true, version: "1.18.18" },
      ])
      await Promise.all(servers.map((server) => server.dispose()))
      for (const url of urls)
        await expect(fetch(`${url.origin}/global/health`)).rejects.toThrow()
      servers = []
    } catch (error) {
      failures.push(error)
    }
    const cleanup = [
      ...(await Promise.allSettled(servers.map((server) => server.dispose()))),
      ...(await Promise.allSettled(
        sandboxes.map((sandbox) => sandbox.destroy()),
      )),
      ...(await Promise.allSettled(
        directories.map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      )),
    ]
    for (const result of cleanup)
      if (result.status === "rejected") failures.push(result.reason)
    if (failures.length)
      throw new AggregateError(failures, "Native OpenCode port proof failed")
  },
)

it.each(["startup", "completion"] as const)(
  "waits for OpenCode SSE at %s",
  { timeout: 60_000 },
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-opencode-sse-"))
    const sandbox = await localProcessSandbox({
      dir: directory,
      removeOnDestroy: true,
    }).create({
      id: directory,
      workspace: { source: { type: "none" } },
    })
    let server: SandboxOpencodeServer | undefined
    let session: Awaited<ReturnType<typeof startOpencodeSession>> | undefined
    let proxy: ReturnType<typeof createServer> | undefined
    const modelCompleted = deferred<void>()
    const promptResponseCompleted = deferred<void>()
    const model = createServer((request, response) => {
      if (request.url !== "/model/v1/chat/completions") {
        response.writeHead(404)
        response.end()
        return
      }
      const body: Buffer[] = []
      request.on("data", (chunk: Buffer) => body.push(chunk))
      request.on("end", () => {
        void body
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          [
            {
              id: "native-sse-proof",
              object: "chat.completion.chunk",
              created: 1,
              model: "probe",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "Native reply completed.",
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "native-sse-proof",
              object: "chat.completion.chunk",
              created: 1,
              model: "probe",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .concat("data: [DONE]\n\n")
            .join(""),
        )
        modelCompleted.resolve()
      })
    })
    const handshakeObserved = deferred<void>()
    const handshakeRelease = deferred<void>()
    const eventsRelease = deferred<void>()
    const assistantEventObserved = deferred<void>()
    const connectedEventObserved = deferred<void>()
    let eventResponse: import("node:http").ServerResponse | undefined
    let eventHeadersSent = false
    let eventsReleased = false
    let eventEnded = false
    const initialEventChunks: Buffer[] = []
    const heldEventChunks: Buffer[] = []
    const flushEventChunks = (): void => {
      if (!eventResponse || !eventHeadersSent) return
      for (const chunk of initialEventChunks) eventResponse.write(chunk)
      initialEventChunks.length = 0
      if (!eventsReleased) return
      for (const chunk of heldEventChunks) eventResponse.write(chunk)
      heldEventChunks.length = 0
      if (eventEnded) eventResponse.end()
    }
    void eventsRelease.promise.then(() => {
      eventsReleased = true
      flushEventChunks()
    })
    const failures: unknown[] = []
    let primaryError: unknown
    try {
      await new Promise<void>((resolve, reject) => {
        model.once("error", reject)
        model.listen(0, "127.0.0.1", () => resolve())
      })
      const modelAddress = model.address()
      if (!modelAddress || typeof modelAddress === "string")
        throw new Error("model fixture did not bind")
      await sandbox.env.set({
        XDG_DATA_HOME: join(directory, "data"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["synthetic"],
          provider: {
            synthetic: {
              npm: "@ai-sdk/openai-compatible",
              name: "synthetic",
              options: {
                baseURL: `http://127.0.0.1:${modelAddress.port}/model/v1`,
                apiKey: "synthetic-test-key",
              },
              models: { probe: { name: "probe" } },
            },
          },
        }),
      })
      server = await startOpencodeServerInSandbox(sandbox, {
        port: 0,
        hostname: "127.0.0.1",
        cwd: ".",
      })
      const upstream = new URL(server.baseUrl)
      proxy = createServer((request, response) => {
        const upstreamRequest = httpRequest(
          {
            hostname: upstream.hostname,
            port: Number(upstream.port),
            path: request.url,
            method: request.method,
            headers: request.headers,
          },
          (upstreamResponse) => {
            if (!request.url?.startsWith("/event")) {
              const isPrompt =
                request.method === "POST" && request.url?.endsWith("/message")
              if (isPrompt)
                upstreamResponse.once("end", () =>
                  promptResponseCompleted.resolve(),
                )
              response.writeHead(
                upstreamResponse.statusCode ?? 502,
                upstreamResponse.headers,
              )
              upstreamResponse.pipe(response)
              return
            }
            eventResponse = response
            let firstEvent = Buffer.alloc(0)
            let firstEventSent = false
            upstreamResponse.on("data", (chunk: Buffer) => {
              if (!firstEventSent) {
                firstEvent = Buffer.concat([firstEvent, chunk])
                const boundary = firstEvent.indexOf("\n\n")
                if (boundary < 0) return
                initialEventChunks.push(firstEvent.subarray(0, boundary + 2))
                firstEvent = firstEvent.subarray(boundary + 2)
                if (firstEvent.length > 0) heldEventChunks.push(firstEvent)
                firstEventSent = true
                handshakeObserved.resolve()
                flushEventChunks()
                return
              }
              heldEventChunks.push(chunk)
              flushEventChunks()
            })
            upstreamResponse.on("end", () => {
              eventEnded = true
              flushEventChunks()
            })
            void handshakeRelease.promise.then(() => {
              if (eventHeadersSent) return
              eventHeadersSent = true
              const headers = { ...upstreamResponse.headers }
              delete headers["content-length"]
              response.writeHead(upstreamResponse.statusCode ?? 502, headers)
              flushEventChunks()
            })
          },
        )
        upstreamRequest.on("error", (error) => response.destroy(error))
        request.pipe(upstreamRequest)
      })
      await new Promise<void>((resolve, reject) => {
        proxy?.once("error", reject)
        proxy?.listen(0, "127.0.0.1", () => resolve())
      })
      const proxyAddress = proxy.address()
      if (!proxyAddress || typeof proxyAddress === "string")
        throw new Error("event proxy did not bind")
      const eventTypes: string[] = []
      const startup = startOpencodeSession({
        baseUrl: `http://127.0.0.1:${proxyAddress.port}`,
        providerID: "synthetic",
        modelID: "probe",
        onEvent: (event) => {
          eventTypes.push(event.type)
          if (eventTypes.at(-1) === "server.connected")
            connectedEventObserved.resolve()
          if (
            event.type === "message.part.updated" &&
            event.properties.part.type === "text" &&
            "text" in event.properties.part &&
            event.properties.part.text === "Native reply completed."
          )
            assistantEventObserved.resolve()
        },
        onPermissionRequest: () => "reject",
      })
      let startupSettled = false
      void startup.then(
        (value) => {
          session = value
          startupSettled = true
        },
        () => {
          startupSettled = true
        },
      )
      await handshakeObserved.promise
      if (phase === "startup") expect(startupSettled).toBe(false)
      handshakeRelease.resolve()
      session = await startup
      await connectedEventObserved.promise
      expect(eventTypes[0]).toBe("server.connected")

      if (phase === "completion") {
        const prompt = session.prompt("return the fixture reply")
        await Promise.all([
          modelCompleted.promise,
          promptResponseCompleted.promise,
        ])
        const promptSettledBeforeEvents = await Promise.race([
          prompt.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), 250)
          }),
        ])
        expect(promptSettledBeforeEvents).toBe(false)
        eventsRelease.resolve()
        await assistantEventObserved.promise
        await expect(prompt).resolves.toMatchObject({
          text: "Native reply completed.",
        })
      }
    } catch (error) {
      primaryError = error
      handshakeRelease.resolve()
      eventsRelease.resolve()
    }
    handshakeRelease.resolve()
    eventsRelease.resolve()
    const cleanup: PromiseSettledResult<void>[] = []
    const clean = async (operation: Promise<void>): Promise<void> => {
      try {
        await operation
        cleanup.push({ status: "fulfilled", value: undefined })
      } catch (reason) {
        cleanup.push({ status: "rejected", reason })
      }
    }
    if (session) await clean(session.dispose())
    if (server) await clean(server.dispose())
    if (proxy)
      await clean(
        new Promise<void>((resolve, reject) => {
          proxy?.closeAllConnections()
          proxy?.close((error) => (error ? reject(error) : resolve()))
        }),
      )
    await clean(
      new Promise<void>((resolve, reject) => {
        model.close((error) => (error ? reject(error) : resolve()))
        model.closeAllConnections()
      }),
    )
    await clean(sandbox.destroy())
    await clean(rm(directory, { recursive: true, force: true }))
    if (primaryError !== undefined) failures.push(primaryError)
    for (const result of cleanup)
      if (result.status === "rejected") failures.push(result.reason)
    if (failures.length)
      throw new AggregateError(failures, "Native OpenCode SSE proof failed", {
        cause: primaryError,
      })
  },
)
