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
  const sandbox = input.handle as SandboxSpawnHandle
  if (sandbox.process.spawn && sandbox.ports?.connect) {
    try {
      const { startOpencodeServerInSandbox } = await import(
        "@tanstack/ai-opencode"
      )
      const server = await startOpencodeServerInSandbox(
        sandbox as Parameters<typeof startOpencodeServerInSandbox>[0],
        {
          port: input.port,
          hostname: "127.0.0.1",
          cwd: ".",
        },
      )
      return {
        baseUrl: server.baseUrl,
        dispose: () => server.dispose(),
      }
    } catch (error) {
      log.warn({
        step: "workspace-chat-opencode-serve",
        message: "official in-sandbox serve start failed; trying exec",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (input.isolation !== "local_process") return null
  const exec = sandbox.process.exec
  if (!exec) return null
  const started = await exec(
    `sh -c 'nohup opencode serve --hostname=127.0.0.1 --port=${input.port} >/tmp/ctxpipe-opencode-serve.log 2>&1 & echo $!'`,
  )
  const pid = Number(started.stdout.trim())
  if (started.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) return null
  const baseUrl = `http://127.0.0.1:${input.port}`
  const ready = await waitForOpenCodeServe(baseUrl)
  if (!ready) return null
  return {
    baseUrl,
    dispose: async () => {
      await exec(`sh -c 'kill ${pid} || true'`).catch(() => undefined)
    },
  }
}

export async function* streamAttachedOpenCodeTurn(input: {
  baseUrl: string
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

async function waitForOpenCodeServe(
  baseUrl: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await fetch(`${baseUrl}/global/health`).then(
      (res) => res.ok,
      () => false,
    )
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
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
