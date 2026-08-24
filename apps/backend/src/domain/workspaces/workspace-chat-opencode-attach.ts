import { randomUUID } from "node:crypto"
import type { PermissionHandler } from "@tanstack/ai-opencode"
import {
  startOpencodeSession,
  translateOpencodeStream,
} from "@tanstack/ai-opencode"
import { log } from "../../observability/logger.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"
import type { WorkspaceChatOpenCodeServe } from "./workspace-chat-conversation-runtime.js"

type SandboxSpawnHandle = TanstackLikeHandle & {
  process: TanstackLikeHandle["process"] & {
    spawn?: (
      command: string,
      options?: { cwd?: string; env?: Record<string, string> },
    ) => Promise<{
      stdout: AsyncIterable<string>
      stderr: AsyncIterable<string>
      kill: () => Promise<void>
    }>
  }
  ports?: {
    connect: (port: number) => Promise<{
      url: string
      headers?: Record<string, string>
      token?: string
    }>
  }
}

export async function startConversationOpenCodeServe(input: {
  handle: TanstackLikeHandle
  port: number
  isolation: "docker" | "local_process"
}): Promise<WorkspaceChatOpenCodeServe | null> {
  const channel = await resolveServeChannel(input.handle, input.port)
  const baseUrl = channel.url
  const headers = channel.headers
  if (await isOpenCodeServeHealthy(baseUrl, headers)) {
    return {
      baseUrl,
      ...(headers ? { headers } : {}),
      dispose: async () => {},
    }
  }
  await waitUntilUnhealthy(baseUrl, headers, 2_000)

  const sandbox = input.handle as SandboxSpawnHandle
  const canOfficial = Boolean(sandbox.process.spawn && sandbox.ports?.connect)
  if (canOfficial) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { startOpencodeServerInSandbox } = await import(
          "@tanstack/ai-opencode"
        )
        const server = await startOpencodeServerInSandbox(
          sandbox as Parameters<typeof startOpencodeServerInSandbox>[0],
          {
            port: input.port,
            hostname: "0.0.0.0",
            cwd: "/workspace",
          },
        )
        return {
          baseUrl: server.baseUrl,
          ...(server.headers ? { headers: server.headers } : {}),
          dispose: () => server.dispose(),
        }
      } catch (error) {
        log.warn({
          step: "workspace-chat-opencode-serve",
          message: "official in-sandbox serve start failed",
          attempt,
          error: error instanceof Error ? error.message : String(error),
        })
        await killListenPort(input.handle, input.port)
        if (await isOpenCodeServeHealthy(baseUrl, headers)) {
          return {
            baseUrl,
            ...(headers ? { headers } : {}),
            dispose: async () => {},
          }
        }
        await sleep(250 * (attempt + 1))
      }
    }
    return null
  }

  if (input.isolation !== "local_process") return null
  const exec = sandbox.process.exec
  if (!exec) return null
  const started = await exec(
    `sh -c 'nohup opencode serve --hostname=0.0.0.0 --port=${input.port} >/tmp/ctxpipe-opencode-serve.log 2>&1 & echo $!'`,
  )
  const pid = Number(started.stdout.trim())
  if (started.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) return null
  const ready = await waitForOpenCodeServe(baseUrl, headers)
  if (!ready) {
    await exec(`sh -c 'kill ${pid} || true'`).catch(() => undefined)
    return null
  }
  return {
    baseUrl,
    ...(headers ? { headers } : {}),
    dispose: async () => {
      await exec(`sh -c 'kill ${pid} || true'`).catch(() => undefined)
    },
  }
}

export async function* streamAttachedOpenCodeTurn(input: {
  baseUrl: string
  headers?: Record<string, string>
  model: string
  prompt: string
  sessionId?: string | null
  threadId: string
  runId?: string
  onPermissionRequest: PermissionHandler
}): AsyncGenerator<object> {
  const slash = input.model.indexOf("/")
  if (slash <= 0) {
    throw new Error(`OpenCode models must be addressed as provider/model`)
  }
  const queue = createAttachQueue()
  const session = await startOpencodeSession({
    baseUrl: input.baseUrl,
    ...(input.headers ? { headers: input.headers } : {}),
    providerID: input.model.slice(0, slash),
    modelID: input.model.slice(slash + 1),
    ...(input.sessionId ? { resumeSessionId: input.sessionId } : {}),
    onEvent: (event) => queue.push({ kind: "event", event } as never),
    onPermissionRequest: input.onPermissionRequest,
    onError: (error) => queue.fail(error),
  })
  queue.push({ kind: "session", sessionId: session.sessionId } as never)
  session
    .prompt(input.prompt)
    .then(({ message }) => {
      queue.push({ kind: "done", message } as never)
      queue.end()
    })
    .catch((error) => queue.fail(error))
  try {
    yield* translateOpencodeStream(queue, {
      model: input.model,
      runId: input.runId ?? randomUUID(),
      threadId: input.threadId,
      genId: () => randomUUID(),
    })
  } finally {
    await session.dispose().catch(() => undefined)
  }
}

export async function isOpenCodeServeHealthy(
  baseUrl: string,
  headers?: Record<string, string>,
): Promise<boolean> {
  return fetch(`${baseUrl}/global/health`, headers ? { headers } : undefined)
    .then((res) => res.ok)
    .catch(() => false)
}

async function resolveServeChannel(
  handle: TanstackLikeHandle,
  port: number,
): Promise<{ url: string; headers?: Record<string, string> }> {
  const sandbox = handle as SandboxSpawnHandle
  if (!sandbox.ports?.connect) {
    return { url: `http://127.0.0.1:${port}` }
  }
  try {
    const channel = await sandbox.ports.connect(port)
    const headers =
      channel.headers ??
      (channel.token ? { Authorization: `Bearer ${channel.token}` } : undefined)
    return {
      url: channel.url,
      ...(headers ? { headers } : {}),
    }
  } catch {
    return { url: `http://127.0.0.1:${port}` }
  }
}

async function waitUntilUnhealthy(
  baseUrl: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!(await isOpenCodeServeHealthy(baseUrl, headers))) return
    await sleep(100)
  }
}

async function waitForOpenCodeServe(
  baseUrl: string,
  headers?: Record<string, string>,
  timeoutMs = 30_000,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await isOpenCodeServeHealthy(baseUrl, headers)) return true
    await sleep(150)
  }
  return false
}

async function killListenPort(
  handle: TanstackLikeHandle,
  port: number,
): Promise<void> {
  const exec = handle.process?.exec
  if (!exec) return
  await exec(
    `sh -c 'if command -v fuser >/dev/null; then fuser -k ${port}/tcp || true; elif command -v lsof >/dev/null; then lsof -ti tcp:${port} -sTCP:LISTEN | xargs -r kill || true; fi'`,
  ).catch(() => undefined)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createAttachQueue(): {
  push: (event: never) => void
  fail: (error: unknown) => void
  end: () => void
} & AsyncIterable<never> {
  const pending: never[] = []
  const waiters: Array<{
    resolve: (value: IteratorResult<never>) => void
    reject: (error: unknown) => void
  }> = []
  let done = false
  let failed: unknown
  return {
    push(event) {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve({ value: event, done: false })
      else pending.push(event)
    },
    fail(error) {
      failed = error
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
    end() {
      done = true
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ value: undefined as never, done: true })
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<never>> {
          if (failed) return Promise.reject(failed)
          if (pending.length > 0) {
            return Promise.resolve({
              value: pending.shift() as never,
              done: false,
            })
          }
          if (done)
            return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve, reject) =>
            waiters.push({ resolve, reject }),
          )
        },
      }
    },
  }
}
