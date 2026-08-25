import { randomBytes } from "node:crypto"
import { trace } from "@opentelemetry/api"
import {
  type ModelMessage,
  modelMessagesToUIMessages,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai"
import { otelMiddleware } from "@tanstack/ai/middlewares/otel"
import { withPersistence } from "@tanstack/ai-persistence"
import { withOrgDbContext } from "../../db/client.js"
import { nameConversationIfUnnamed } from "../../graphs/conversationGraph/nodes/conversationNaming.js"
import { loadConversationTurns } from "../../models/conversation-messages.js"
import {
  getWorkspaceById,
  listSandboxInstances,
  listWorkspaceKnowledgeUnitsForChat,
} from "../../models/workspaces.js"
import { getLogger, log } from "../../observability/logger.js"
import { hybridSearch } from "../../retrieval/index.js"
import { generateEmbedding } from "../../retrieval/services/modelProvider.js"
import {
  CHAT_HEARTBEAT_INTERVAL_MS,
  shouldHeartbeatChatSandbox,
} from "./chat-lifecycle.js"
import {
  WORKSPACE_CHAT_CLONE_BRANCH_SECRET,
  WORKSPACE_CHAT_CLONE_SHA_SECRET,
  WORKSPACE_CHAT_CLONE_TOKEN_SECRET,
  WORKSPACE_CHAT_CLONE_URL_SECRET,
  WORKSPACE_CHAT_DOCKER_SANDBOX,
  WORKSPACE_CHAT_OPENCODE_PORT,
  WORKSPACE_CHAT_SANDBOX_SETUP,
  workspaceChatCloneTokenRef,
  workspaceChatGitSource,
  workspaceChatRuntimeConfig,
  workspaceChatSandboxId,
  workspaceChatSandboxSpec,
} from "./chat-runtime.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import { adaptTanstackHandle, type TanstackLikeHandle } from "./job-sandbox.js"
import {
  emitOpencodeChatAttempt,
  opencodeChatStreamEvent,
  shouldFailEmptyChatTurn,
} from "./opencode-chat-stream.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import {
  attachChatSandboxHandle,
  destroySandboxesForConversation,
  heartbeatChatSandboxes,
} from "./sandbox-registry.js"
import { loadTanstackChatModules } from "./tanstack-runtime.js"
import {
  aguiTextDelta,
  conversationRenameChunk,
  takeWorkspaceChatProducer,
  type WorkspaceChatWireFormat,
  withWorkspaceChatHeartbeats,
  workspaceChatHttpResponse,
  workspaceChatRunError,
  workspaceChatRunFinished,
  workspaceChatRunStarted,
  workspaceChatWireFormat,
} from "./workspace-chat-agui.js"
import {
  createWorkspaceChatAssistantGate,
  isOpenCodePlanningHold,
  workspaceChatRecoveredAssistant,
} from "./workspace-chat-assistant-text.js"
import { startWorkspaceChatModelProxy } from "./workspace-chat-model-proxy.js"
import {
  workspaceChatOpenCodeConfig,
  workspaceChatOpenCodeContract,
} from "./workspace-chat-opencode-contract.js"
import {
  messagesForOpenCodeChat,
  openCodeTrailingUserMiddleware,
} from "./workspace-chat-opencode-messages.js"
import {
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  lastWorkspaceChatStopText,
  markWorkspaceChatFirstShownToken,
} from "./workspace-chat-otel.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import { invalidateChatSandbox } from "./workspace-chat-sandbox-health.js"
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
  abortSignal?: AbortSignal
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
  resolveRuntime?: () => Promise<Partial<TanstackWorkspaceChatInput>>
  wireFormat?: WorkspaceChatWireFormat
  streamSetupMs?: number
  streamIdleMs?: number
}

export { conversationRenameChunk } from "./workspace-chat-agui.js"

function providerFactoryForChat(
  modules: Awaited<ReturnType<typeof loadTanstackChatModules>>,
  provider: string,
) {
  if (provider === "docker") {
    return modules.dockerSandbox?.(WORKSPACE_CHAT_DOCKER_SANDBOX)
  }
  return undefined
}

function chatProviderMatchesEffective(
  storedProvider: string | null,
  effective: string,
): boolean {
  return storedProvider === effective
}

function abortControllerFrom(signal?: AbortSignal): AbortController {
  const abortController = new AbortController()
  if (!signal) return abortController
  if (signal.aborted) abortController.abort(signal.reason)
  else {
    signal.addEventListener(
      "abort",
      () => abortController.abort(signal.reason),
      {
        once: true,
      },
    )
  }
  return abortController
}

export async function collectTanstackWorkspaceChatText(
  input: TanstackWorkspaceChatInput,
): Promise<
  { ok: true; text: string } | { ok: false; status: number; error: string }
> {
  const gate = createWorkspaceChatAssistantGate(input.prompt)
  try {
    for await (const chunk of streamTanstackWorkspaceChat(input)) {
      for (const next of gate.take(chunk)) {
        const delta = aguiTextDelta(next)
        if (delta) await input.onDelta?.(delta)
      }
    }
    for (const next of gate.flush()) {
      const delta = aguiTextDelta(next)
      if (delta) await input.onDelta?.(delta)
    }
    return { ok: true, text: gate.assistant() }
  } catch (error) {
    await input.onError?.()
    throw error
  }
}

export async function* streamTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): AsyncGenerator<StreamChunk> {
  beginWorkspaceChatTurn(input.conversationId)
  try {
    yield* streamTanstackWorkspaceChatBody(input)
    finishWorkspaceChatTurn(input.conversationId)
  } catch (error) {
    finishWorkspaceChatTurn(input.conversationId, {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function* streamTanstackWorkspaceChatBody(
  input: TanstackWorkspaceChatInput,
): AsyncGenerator<StreamChunk> {
  const resolved = input.resolveRuntime ? await input.resolveRuntime() : {}
  const turn: TanstackWorkspaceChatInput = { ...input, ...resolved }
  await turn.onUserPersist?.()

  const prepared = await startWorkspaceChat(turn)
  if (!prepared.ok) {
    await turn.onError?.()
    yield workspaceChatRunStarted({
      conversationId: turn.conversationId,
      runId: turn.runId,
    })
    yield workspaceChatRunError(prepared.error)
    return
  }

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
  const runtime = workspaceChatRuntimeConfig({ writeStatus: turn.writeStatus })
  const recordChatAttempt = (error?: unknown) => {
    const fields = opencodeChatStreamEvent({
      conversationId: turn.conversationId,
      workspaceId: turn.workspaceId,
      error,
      provider: runtime.provider,
      opencodePort: prepared.servePort,
      durationMs: Date.now() - startedAt,
    })
    const message = String(fields.message ?? "OpenCode chat stream failed")
    emitOpencodeChatAttempt(
      fields,
      error == null
        ? null
        : error instanceof Error
          ? error
          : new Error(message),
    )
    return message
  }

  const gate = createWorkspaceChatAssistantGate(turn.prompt)
  let streamError: Error | null = null
  try {
    for await (const chunk of takeWorkspaceChatProducer(prepared.stream, {
      setupMs: turn.streamSetupMs,
      idleMs: turn.streamIdleMs,
    })) {
      for (const next of gate.take(chunk)) {
        const typed = next as StreamChunk
        if (typed.type === "RUN_ERROR") {
          streamError = new Error(
            "message" in typed && typeof typed.message === "string"
              ? typed.message
              : "OpenCode chat stream failed",
          )
          continue
        }
        if (
          typed.type === "TEXT_MESSAGE_CONTENT" ||
          typed.type === "REASONING_MESSAGE_CONTENT" ||
          typed.type === "TOOL_CALL_START"
        ) {
          markWorkspaceChatFirstShownToken(turn.conversationId)
        }
        yield typed
      }
    }
    let finished: StreamChunk | null = null
    for (const next of gate.flush()) {
      const typed = next as StreamChunk
      if (typed.type === "RUN_ERROR") {
        streamError = new Error(
          "message" in typed && typeof typed.message === "string"
            ? typed.message
            : "OpenCode chat stream failed",
        )
        continue
      }
      if (typed.type === "RUN_FINISHED") {
        finished = typed
        continue
      }
      if (
        typed.type === "TEXT_MESSAGE_CONTENT" ||
        typed.type === "REASONING_MESSAGE_CONTENT" ||
        typed.type === "TOOL_CALL_START"
      ) {
        markWorkspaceChatFirstShownToken(turn.conversationId)
      }
      yield typed
    }
    const streamed = gate.assistant()
    const assistant = workspaceChatRecoveredAssistant({
      prompt: turn.prompt,
      streamed,
      fallback: streamError
        ? undefined
        : lastWorkspaceChatStopText(turn.conversationId),
    })
    if (assistant.trim() && assistant !== streamed.trim()) {
      const messageId = `recover-${turn.conversationId}`
      yield {
        type: "TEXT_MESSAGE_START",
        messageId,
      } as StreamChunk
      yield {
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: assistant,
      } as StreamChunk
      yield {
        type: "TEXT_MESSAGE_END",
        messageId,
      } as StreamChunk
      markWorkspaceChatFirstShownToken(turn.conversationId)
    }
    const failed =
      streamError != null ||
      !assistant.trim() ||
      isOpenCodePlanningHold(assistant) ||
      shouldFailEmptyChatTurn({ assistant, error: streamError })
    if (failed) {
      const error =
        streamError ?? new Error("workspace chat produced no assistant reply")
      await invalidateChatSandbox({
        handle: prepared.handle.current,
        orgId: turn.orgId,
        conversationId: turn.conversationId,
      })
      const message = recordChatAttempt(error)
      await turn.onError?.()
      yield workspaceChatRunError(message)
      return
    }
    const name = await nameConversationIfUnnamed({
      conversationId: turn.conversationId,
      prompt: turn.prompt,
    }).catch(() => null)
    if (name) yield conversationRenameChunk(name)
    if (turn.onFinish) await turn.onFinish()
    recordChatAttempt()
    yield finished ??
      workspaceChatRunFinished({
        conversationId: turn.conversationId,
        runId: turn.runId,
      })
  } catch (error) {
    await invalidateChatSandbox({
      handle: prepared.handle.current,
      orgId: turn.orgId,
      conversationId: turn.conversationId,
    })
    const message = recordChatAttempt(error)
    await turn.onError?.()
    yield workspaceChatRunError(message)
  } finally {
    clearInterval(heartbeat)
    await prepared.dispose()
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

export async function warmTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const prepareStarted = Date.now()
  const built = await buildWorkspaceChatSandbox(input)
  if (!built.ok) return built
  const definition = defineConversationSandbox({
    modules: built.modules,
    spec: built.spec,
    input,
    provider: built.provider,
    runToken: "prepare",
    proxyUrl: "http://127.0.0.1:0",
    modelBase: built.contract.modelBase,
    handle: { current: null },
  })
  const ensureStarted = Date.now()
  try {
    if (typeof definition.ensure !== "function") {
      return { ok: false, status: 503, error: "sandbox ensure is unavailable" }
    }
    await definition.ensure({
      threadId: input.conversationId,
      runId: input.runId ?? `prepare-${input.conversationId}`,
      store: built.instances,
      tenant: { orgId: input.orgId },
      adapterName: "opencode",
    })
    log.info({
      step: "workspace-chat-timing",
      phase: "ensure",
      message: `workspace chat timing ensure ${Date.now() - ensureStarted}ms`,
      ms: Date.now() - ensureStarted,
      conversationId: input.conversationId,
    })
    log.info({
      step: "workspace-chat-timing",
      phase: "prepare",
      message: `workspace chat timing prepare ${Date.now() - prepareStarted}ms`,
      ms: Date.now() - prepareStarted,
      conversationId: input.conversationId,
    })
    return { ok: true }
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      {
        step: "workspace-chat-prepare-ensure",
      },
    )
    return { ok: false, status: 503, error: "workspace chat prepare failed" }
  }
}

async function startWorkspaceChat(input: TanstackWorkspaceChatInput): Promise<
  | {
      ok: true
      stream: AsyncIterable<object>
      servePort: number
      handle: { current: TanstackLikeHandle | null }
      dispose: () => Promise<void>
    }
  | { ok: false; status: number; error: string }
> {
  const built = await buildWorkspaceChatSandbox(input)
  if (!built.ok) return built
  const runtime = workspaceChatRuntimeConfig({ writeStatus: input.writeStatus })
  const contract = workspaceChatOpenCodeContract(process.env)
  if (!contract.ok) {
    return { ok: false, status: contract.status, error: contract.error }
  }

  const runToken = randomBytes(32).toString("hex")
  let proxy: Awaited<ReturnType<typeof startWorkspaceChatModelProxy>> | null =
    null
  const handle = { current: null as TanstackLikeHandle | null }
  try {
    const proxyAndToolsStarted = Date.now()
    const [startedProxy, tools] = await Promise.all([
      startWorkspaceChatModelProxy({
        runToken,
        conversationId: input.conversationId,
        upstreamBaseUrl: contract.upstreamBaseUrl,
        upstreamApiKey: contract.apiKey,
        modelBase: contract.modelBase,
        modelParams: contract.modelParams,
        listenHost: "0.0.0.0",
        advertisedHost: "host.docker.internal",
      }),
      loadWorkspaceChatTools(input),
    ])
    proxy = startedProxy
    log.info({
      step: "workspace-chat-timing",
      phase: "proxy-and-tools",
      message: `workspace chat timing proxy-and-tools ${Date.now() - proxyAndToolsStarted}ms`,
      ms: Date.now() - proxyAndToolsStarted,
      conversationId: input.conversationId,
    })
    const servePort = WORKSPACE_CHAT_OPENCODE_PORT
    const modules = built.modules
    const definition = defineConversationSandbox({
      modules,
      spec: built.spec,
      input,
      provider: built.provider,
      runToken,
      proxyUrl: proxy.baseUrl,
      modelBase: contract.modelBase,
      handle,
    })
    const instances = built.instances
    const persistence = workspaceChatPersistence()
    const snapshots = {
      ...(await modules.memorySandboxSnapshots({
        sandbox: definition,
        instances,
      })),
      persistence,
    }
    const chatStarted = Date.now()
    const stream = await modules.chat({
      adapter: modules.opencodeText(contract.opencodeModel, {
        port: servePort,
        permissionMode: runtime.permissionMode,
        onPermissionRequest: runtime.onPermissionRequest,
      }),
      threadId: input.threadId ?? input.conversationId,
      runId: input.runId,
      messages: messagesForOpenCodeChat(input.messages, input.prompt) as Array<
        ModelMessage | UIMessage
      >,
      abortController: abortControllerFrom(input.abortSignal),
      tools,
      middleware: [
        otelMiddleware({
          tracer: trace.getTracer("ctxpipe-workspace-chat"),
        }),
        withPersistence(persistence),
        modules.withSandbox(definition, {
          instances,
          snapshots,
        }),
        openCodeTrailingUserMiddleware(input.prompt),
      ],
    })
    log.info({
      step: "workspace-chat-timing",
      phase: "chat-create",
      message: `workspace chat timing chat-create ${Date.now() - chatStarted}ms`,
      ms: Date.now() - chatStarted,
      attached: false,
      conversationId: input.conversationId,
    })
    return {
      ok: true,
      stream,
      servePort,
      handle,
      dispose: async () => {
        await proxy?.close().catch(() => undefined)
      },
    }
  } catch (error) {
    await proxy?.close().catch(() => undefined)
    throw error
  }
}

async function buildWorkspaceChatSandbox(input: TanstackWorkspaceChatInput) {
  const runtime = workspaceChatRuntimeConfig({ writeStatus: input.writeStatus })
  const contract = workspaceChatOpenCodeContract(process.env)
  if (!contract.ok) {
    return {
      ok: false as const,
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
      ok: false as const,
      status: 409,
      error: "Workspace chat needs a stored desired SHA",
    }
  }
  const spec = workspaceChatSandboxSpec({
    sandboxId: snapshotId,
    provider: runtime.provider,
    gitUrl: input.desiredUrl,
    ref: input.desiredSha ?? input.ref,
  })
  if (!spec.ok) {
    return {
      ok: false as const,
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
  const effective = runtime.provider
  if (
    storedProvider &&
    !chatProviderMatchesEffective(storedProvider, effective)
  ) {
    await destroySandboxesForConversation(input.conversationId)
  }
  const provider = providerFactoryForChat(modules, effective)
  if (!provider) {
    return {
      ok: false as const,
      status: 503,
      error: `TanStack sandbox provider ${effective} is not available`,
    }
  }
  return {
    ok: true as const,
    modules,
    spec,
    provider,
    contract,
    instances: postgresSandboxInstanceStore({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
    }),
  }
}

function defineConversationSandbox(input: {
  modules: Awaited<ReturnType<typeof loadTanstackChatModules>>
  spec: Extract<ReturnType<typeof workspaceChatSandboxSpec>, { ok: true }>
  provider: NonNullable<ReturnType<typeof providerFactoryForChat>>
  input: TanstackWorkspaceChatInput
  runToken: string
  proxyUrl: string
  modelBase: string
  handle: { current: TanstackLikeHandle | null }
}) {
  const { modules, spec, provider, input: chatInput, handle } = input
  const secrets = modules.createSecrets({
    CTXPIPE_OPENCODE_RUN_TOKEN: input.runToken,
    CTXPIPE_MODEL_PROXY_URL: `${input.proxyUrl}/v1`,
    [WORKSPACE_CHAT_CLONE_URL_SECRET]: originUrlWithoutCredentials(
      chatInput.desiredUrl,
    ),
    [WORKSPACE_CHAT_CLONE_BRANCH_SECRET]:
      chatInput.defaultBranch?.trim() || "main",
    [WORKSPACE_CHAT_CLONE_SHA_SECRET]: chatInput.desiredSha?.trim() ?? "",
    ...(chatInput.cloneToken
      ? { [WORKSPACE_CHAT_CLONE_TOKEN_SECRET]: chatInput.cloneToken }
      : {}),
  })
  const opencodeConfig = workspaceChatOpenCodeConfig({
    modelBase: input.modelBase,
  })
  return modules.defineSandbox({
    id: spec.id,
    provider,
    workspace: modules.defineWorkspace({
      source: modules.gitSource(
        workspaceChatGitSource({
          url: spec.source.url,
          ref: chatInput.defaultBranch ?? spec.source.ref,
          token: workspaceChatCloneTokenRef(
            secrets as Record<string, unknown>,
            chatInput.cloneToken,
          ),
        }) as Parameters<typeof modules.gitSource>[0],
      ),
      setup: [...WORKSPACE_CHAT_SANDBOX_SETUP],
      secrets,
      skills: [
        modules.fileSkill({
          path: "opencode.json",
          content: `${JSON.stringify(opencodeConfig, null, 2)}\n`,
        }),
      ],
    }),
    lifecycle: spec.lifecycle,
    hooks: {
      onReady: async (ready: TanstackLikeHandle) => {
        handle.current = ready
        await attachChatSandboxHandle({
          kind: "chat",
          workspaceId: chatInput.workspaceId,
          conversationId: chatInput.conversationId,
          orgId: chatInput.orgId,
          desiredUrl: chatInput.desiredUrl,
          desiredGeneration: chatInput.desiredGeneration,
          desiredSha: chatInput.desiredSha,
          defaultBranch: chatInput.defaultBranch,
          handle: adaptTanstackHandle(ready),
          destroy: () => ready.destroy(),
        }).catch((error) => {
          getLogger().error(
            error instanceof Error ? error : new Error(String(error)),
            { step: "attach-chat-sandbox-handle" },
          )
        })
      },
    },
  })
}

async function loadWorkspaceChatTools(input: TanstackWorkspaceChatInput) {
  const activeProjectionSha = await withOrgDbContext(input.orgId, async () => {
    const workspace = await getWorkspaceById(input.workspaceId)
    return workspace?.activeProjectionSha ?? null
  }).catch(() => null)
  return workspaceChatTools({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    writeStatus: input.writeStatus,
    activeProjectionSha,
    loadUnits: () =>
      withOrgDbContext(input.orgId, () =>
        listWorkspaceKnowledgeUnitsForChat(input.workspaceId),
      ),
    embedQuery: generateEmbedding,
    searchObjects: async (query, embedding) =>
      hybridSearch(input.orgId, { embedding, query }, { limit: 20 }),
  }).catch(() => [])
}

export async function conversationHasStoredTurns(
  conversationId: string,
): Promise<boolean> {
  const persisted = await workspaceChatPersistence()
    .stores.messages.loadThread(conversationId)
    .catch(() => [])
  if (persisted.length > 0) return true
  const turns = await loadConversationTurns(conversationId)
  return turns.length > 0
}

export function conversationUiMessagesFromModelMessages(
  messages: Parameters<typeof modelMessagesToUIMessages>[0],
) {
  return modelMessagesToUIMessages(messages)
}
