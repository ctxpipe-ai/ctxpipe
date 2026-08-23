import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StreamChunk } from "@tanstack/ai"
import { withOrgDbContext } from "../../db/client.js"
import { nameConversationIfUnnamed } from "../../graphs/conversationGraph/nodes/conversationNaming.js"
import { appendConversationTurn } from "../../models/conversation-messages.js"
import {
  getWorkspaceById,
  listSandboxInstances,
  listWorkspaceKnowledgeUnitsForChat,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { hybridSearch } from "../../retrieval/index.js"
import { generateEmbedding } from "../../retrieval/services/modelProvider.js"
import {
  CHAT_HEARTBEAT_INTERVAL_MS,
  shouldHeartbeatChatSandbox,
} from "./chat-lifecycle.js"
import {
  WORKSPACE_CHAT_DOCKER_SANDBOX,
  WORKSPACE_CHAT_OPENCODE_PORT,
  WORKSPACE_CHAT_SANDBOX_SETUP,
  workspaceChatGitSource,
  workspaceChatRuntimeConfig,
  workspaceChatSandboxId,
  workspaceChatSandboxSpec,
} from "./chat-runtime.js"
import { adaptTanstackHandle, type TanstackLikeHandle } from "./job-sandbox.js"
import {
  emitOpencodeChatAttempt,
  opencodeChatStreamEvent,
  shouldFailEmptyChatTurn,
  withTanstackConsoleCapture,
} from "./opencode-chat-stream.js"
import {
  postgresSandboxInstanceStore,
  postgresSandboxLockStore,
} from "./sandbox-instance-store.js"
import {
  attachChatSandboxHandle,
  heartbeatChatSandboxes,
} from "./sandbox-registry.js"
import { loadTanstackChatModules } from "./tanstack-runtime.js"
import {
  aguiTextDelta,
  conversationRenameChunk,
  type WorkspaceChatWireFormat,
  withWorkspaceChatHeartbeats,
  workspaceChatHttpResponse,
  workspaceChatRunError,
  workspaceChatRunStarted,
  workspaceChatWireFormat,
} from "./workspace-chat-agui.js"
import { startWorkspaceChatModelProxy } from "./workspace-chat-model-proxy.js"
import {
  WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV,
  workspaceChatOpenCodeConfig,
  workspaceChatOpenCodeContract,
} from "./workspace-chat-opencode-contract.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"

export type TanstackWorkspaceChatMessage = {
  role: string
  content?: unknown
  parts?: unknown[]
}

export type TanstackWorkspaceChatInput = {
  conversationId: string
  prompt: string
  messages?: TanstackWorkspaceChatMessage[]
  threadId?: string
  runId?: string
  orgId: string
  workspaceId: string
  desiredUrl: string
  desiredSha: string | null
  desiredGeneration?: number
  defaultBranch?: string
  ref: string
  writeStatus: string
  cloneToken?: string | null
  onHeartbeat?: () => Promise<void> | void
  onFinish?: () => Promise<void> | void
  onError?: () => Promise<void> | void
  onUserPersist?: () => Promise<void> | void
  onDelta?: (delta: string) => Promise<void> | void
  /** Set when the user turn + lastMessageAt were written before the stream opened. */
  userTurnAccepted?: boolean
  resolveRuntime?: () => Promise<Partial<TanstackWorkspaceChatInput>>
  wireFormat?: WorkspaceChatWireFormat
  appendTurn?: (input: {
    conversationId: string
    role: "user" | "assistant"
    content: string
    orgId?: string
  }) => Promise<void>
}

export { conversationRenameChunk } from "./workspace-chat-agui.js"

function localProcessChatProvider(
  modules: Awaited<ReturnType<typeof loadTanstackChatModules>>,
) {
  return modules.localProcessSandbox?.({
    scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
  })
}

function providerFactoryForStoredChat(
  modules: Awaited<ReturnType<typeof loadTanstackChatModules>>,
  storedProvider: string,
) {
  if (storedProvider === "sbx") return modules.sbxSandbox?.()
  if (storedProvider === "docker") {
    return modules.dockerSandbox?.(WORKSPACE_CHAT_DOCKER_SANDBOX)
  }
  if (
    storedProvider === "local-process" ||
    storedProvider === "local_process"
  ) {
    return localProcessChatProvider(modules)
  }
  return undefined
}

export async function collectTanstackWorkspaceChatText(
  input: TanstackWorkspaceChatInput,
): Promise<
  { ok: true; text: string } | { ok: false; status: number; error: string }
> {
  const prepared = await prepareTanstackWorkspaceChat(input)
  if (!prepared.ok) return prepared
  try {
    let text = ""
    for await (const chunk of prepared.stream) {
      const delta = aguiTextDelta(chunk)
      if (delta) {
        text += delta
        await input.onDelta?.(delta)
      }
    }
    await persistCompletedTurns(input, {
      persistUser: !input.userTurnAccepted,
      assistant: text,
    })
    return { ok: true, text }
  } catch (error) {
    await input.onError?.()
    throw error
  }
}

export async function* streamTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): AsyncGenerator<StreamChunk> {
  yield workspaceChatRunStarted({
    conversationId: input.threadId ?? input.conversationId,
    runId: input.runId,
  })
  const resolved = input.resolveRuntime ? await input.resolveRuntime() : {}
  const turn: TanstackWorkspaceChatInput = { ...input, ...resolved }
  if (!turn.userTurnAccepted) {
    await persistCompletedTurns(turn, { persistUser: true, assistant: "" })
    await turn.onUserPersist?.()
  }

  const prepared = await prepareTanstackWorkspaceChat(turn)
  if (!prepared.ok) {
    await turn.onError?.()
    yield workspaceChatRunError(prepared.error)
    return
  }

  const runtime = workspaceChatRuntimeConfig({
    writeStatus: turn.writeStatus,
  })
  let lastHeartbeatAt: Date | null = new Date()
  heartbeatChatSandboxes(turn.conversationId, lastHeartbeatAt)
  void turn.onHeartbeat?.()
  const heartbeat = setInterval(() => {
    const now = new Date()
    if (
      !shouldHeartbeatChatSandbox({
        turnInProgress: true,
        lastHeartbeatAt,
        now,
      })
    ) {
      return
    }
    lastHeartbeatAt = now
    heartbeatChatSandboxes(turn.conversationId, now)
    void turn.onHeartbeat?.()
  }, CHAT_HEARTBEAT_INTERVAL_MS)

  const startedAt = Date.now()
  const chatAttemptFields = (error?: unknown) =>
    opencodeChatStreamEvent({
      conversationId: turn.conversationId,
      workspaceId: turn.workspaceId,
      error,
      provider: runtime.provider,
      opencodePort: WORKSPACE_CHAT_OPENCODE_PORT,
      durationMs: Date.now() - startedAt,
    })
  const recordChatAttempt = (error?: unknown) => {
    const fields = chatAttemptFields(error)
    const message = String(fields.message ?? "OpenCode chat stream failed")
    const logged =
      error == null ? null : error instanceof Error ? error : new Error(message)
    emitOpencodeChatAttempt(fields, logged)
    return { fields, logged, message }
  }

  let assistant = ""
  let finished = false
  const capturedFatals: Error[] = []
  const originalConsole = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  }
  const intercept = (...args: unknown[]) => {
    const text = args.map((arg) => String(arg)).join(" ")
    if (
      text.includes("tanstack-ai:errors") ||
      text.includes("opencode.chatStream") ||
      text.includes("Unexpected server error")
    ) {
      capturedFatals.push(new Error(text))
    }
  }
  console.error = intercept
  console.info = intercept
  console.log = intercept
  console.warn = intercept
  try {
    for await (const chunk of prepared.stream) {
      const typed = chunk as StreamChunk
      const delta = aguiTextDelta(typed)
      if (delta) assistant += delta
      if (typed.type === "RUN_FINISHED") finished = true
      if (typed.type === "RUN_ERROR") {
        throw new Error(
          "message" in typed && typeof typed.message === "string"
            ? typed.message
            : "OpenCode chat stream failed",
        )
      }
      yield typed
    }
    const streamFatal = capturedFatals[0] ?? prepared.constructFatal
    if (
      shouldFailEmptyChatTurn({
        assistant,
        error: streamFatal,
      })
    ) {
      const { message } = recordChatAttempt(streamFatal)
      await turn.onError?.()
      yield workspaceChatRunError(message)
      return
    }
    if (finished || assistant.trim()) {
      await persistCompletedTurns(turn, {
        persistUser: false,
        assistant,
      })
      const name = await nameConversationIfUnnamed({
        conversationId: turn.conversationId,
        prompt: turn.prompt,
      }).catch(() => null)
      if (name) yield conversationRenameChunk(name)
      if (turn.onFinish) await turn.onFinish()
    }
    recordChatAttempt()
  } catch (error) {
    const { message } = recordChatAttempt(error)
    await turn.onError?.()
    yield workspaceChatRunError(message)
  } finally {
    console.error = originalConsole.error
    console.info = originalConsole.info
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    clearInterval(heartbeat)
  }
}

export async function runTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<Response> {
  return workspaceChatHttpResponse(
    withWorkspaceChatHeartbeats(streamTanstackWorkspaceChat(input)),
    input.wireFormat ?? workspaceChatWireFormat(new Request("http://local")),
  )
}

async function persistCompletedTurns(
  input: TanstackWorkspaceChatInput,
  turns: { persistUser: boolean; assistant: string },
): Promise<void> {
  const append = input.appendTurn ?? appendConversationTurn
  if (turns.persistUser) {
    await append({
      conversationId: input.conversationId,
      role: "user",
      content: input.prompt,
      orgId: input.orgId,
    })
  }
  const content = turns.assistant.trim()
  if (!content) return
  await append({
    conversationId: input.conversationId,
    role: "assistant",
    content,
    orgId: input.orgId,
  })
}

async function prepareTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<
  | {
      ok: true
      stream: AsyncIterable<object>
      constructFatal: Error | null
    }
  | { ok: false; status: number; error: string }
> {
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
  })
  const contract = workspaceChatOpenCodeContract(process.env)
  if (!contract.ok) {
    return {
      ok: false,
      status: contract.status,
      error: contract.error,
    }
  }
  const snapshotId = workspaceChatSandboxId({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    desiredUrl: input.desiredUrl,
    desiredSha: input.desiredSha,
    image: "chat:1",
  })
  if (!snapshotId) {
    return {
      ok: false,
      status: 409,
      error: "Workspace chat needs a stored desired SHA",
    }
  }
  const spec = workspaceChatSandboxSpec({
    sandboxId: snapshotId,
    provider: runtime.provider,
    gitUrl: input.desiredUrl,
    ref: input.ref,
  })
  if (!spec.ok) {
    return {
      ok: false,
      status: 503,
      error:
        "Workspace chat requires an isolated TanStack sandbox provider. Host OpenCode is not a fallback.",
    }
  }

  const modules = await loadTanstackChatModules()
  const storedChat = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({
      conversationId: input.conversationId,
      kind: "chat",
    }),
  )
  const storedProvider =
    storedChat.find((row) => row.providerSandboxId)?.provider ??
    storedChat[0]?.provider ??
    null
  const locked = process.env.SANDBOX_PROVIDER?.trim() || null
  let provider = storedProvider
    ? providerFactoryForStoredChat(modules, storedProvider)
    : spec.isolation === "docker"
      ? modules.dockerSandbox?.(WORKSPACE_CHAT_DOCKER_SANDBOX)
      : localProcessChatProvider(modules)
  if (
    !storedProvider &&
    !provider &&
    locked !== "docker" &&
    locked !== "railway"
  ) {
    provider = localProcessChatProvider(modules)
  }
  if (!provider) {
    return {
      ok: false,
      status: 503,
      error: storedProvider
        ? `TanStack sandbox provider ${storedProvider} is not available`
        : "TanStack sandbox provider is not installed",
    }
  }

  const messages = tanstackChatModelMessages(
    input.messages && input.messages.length > 0
      ? input.messages
      : [{ role: "user", content: input.prompt }],
  )

  const runToken = randomBytes(32).toString("hex")
  const proxy = await startWorkspaceChatModelProxy({
    runToken,
    upstreamBaseUrl: contract.upstreamBaseUrl,
    upstreamApiKey: contract.apiKey,
    modelBase: contract.modelBase,
    modelParams: contract.modelParams,
  })
  const opencodeConfig = workspaceChatOpenCodeConfig({
    modelBase: contract.modelBase,
    baseUrl: `${proxy.baseUrl}/v1`,
  })
  const opencodeConfigPath = join(
    tmpdir(),
    `ctxpipe-opencode-${input.conversationId}.json`,
  )
  const tools = await workspaceChatTools({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    writeStatus: input.writeStatus,
    activeProjectionSha: await withOrgDbContext(input.orgId, async () => {
      const workspace = await getWorkspaceById(input.workspaceId)
      return workspace?.activeProjectionSha ?? null
    }).catch(() => null),
    loadUnits: () =>
      withOrgDbContext(input.orgId, () =>
        listWorkspaceKnowledgeUnitsForChat(input.workspaceId),
      ),
    embedQuery: generateEmbedding,
    searchObjects: async (query, embedding) =>
      hybridSearch(input.orgId, { embedding, query }, { limit: 20 }),
  }).catch(() => [])
  try {
    writeFileSync(
      opencodeConfigPath,
      `${JSON.stringify(opencodeConfig, null, 2)}\n`,
    )
    const definition = modules.defineSandbox({
      id: spec.id,
      provider,
      workspace: modules.defineWorkspace({
        source: modules.gitSource(
          workspaceChatGitSource({
            url: spec.source.url,
            ref: spec.source.ref,
            token: input.cloneToken,
          }),
        ),
        setup: [...WORKSPACE_CHAT_SANDBOX_SETUP],
        secrets: modules.createSecrets({
          CTXPIPE_OPENCODE_RUN_TOKEN: runToken,
          OPENCODE_CONFIG: opencodeConfigPath,
        }),
        skills: [
          modules.fileSkill({
            path: "opencode.json",
            content: `${JSON.stringify(opencodeConfig, null, 2)}\n`,
          }),
        ],
      }),
      lifecycle: spec.lifecycle,
      hooks: {
        onReady: (handle: TanstackLikeHandle) => {
          void attachChatSandboxHandle({
            kind: "chat",
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            orgId: input.orgId,
            desiredUrl: input.desiredUrl,
            desiredGeneration: input.desiredGeneration,
            desiredSha: input.desiredSha,
            defaultBranch: input.defaultBranch,
            handle: adaptTanstackHandle(handle),
            destroy: () => handle.destroy(),
          }).catch((error) => {
            getLogger().error(
              error instanceof Error ? error : new Error(String(error)),
              { step: "attach-chat-sandbox-handle" },
            )
          })
        },
      },
    })
    const constructed = await withTanstackConsoleCapture(async () =>
      modules.chat({
        adapter: modules.opencodeText(contract.opencodeModel, {
          port: WORKSPACE_CHAT_OPENCODE_PORT,
          permissionMode: runtime.permissionMode,
          onPermissionRequest: runtime.onPermissionRequest,
        }),
        threadId: input.threadId ?? input.conversationId,
        runId: input.runId,
        messages,
        tools,
        middleware: [
          modules.withSandbox(definition, {
            instances: postgresSandboxInstanceStore({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
            }),
            locks: postgresSandboxLockStore({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
            }),
          }),
        ],
      }),
    )
    return {
      ok: true,
      stream: closeProxyAfterStream(constructed.result, proxy.close),
      constructFatal: constructed.fatal,
    }
  } catch (error) {
    await proxy.close().catch(() => undefined)
    throw error
  }
}

function tanstackChatModelMessages(
  messages: TanstackWorkspaceChatMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content:
      typeof message.content === "string"
        ? message.content
        : message.content == null
          ? ""
          : JSON.stringify(message.content),
  }))
}

async function* closeProxyAfterStream(
  stream: AsyncIterable<object>,
  close: () => Promise<void>,
): AsyncGenerator<object> {
  try {
    yield* stream
  } finally {
    await close().catch(() => undefined)
  }
}
