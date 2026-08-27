import { trace } from "@opentelemetry/api"
import {
  type ModelMessage,
  modelMessagesToUIMessages,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai"
import { otelMiddleware } from "@tanstack/ai/middlewares/otel"
import { withPersistence } from "@tanstack/ai-persistence"
import { eq } from "drizzle-orm"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
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
  WORKSPACE_CHAT_SESSION_BRANCH_SECRET,
  workspaceChatCloneTokenRef,
  workspaceChatGitSource,
  workspaceChatRuntimeConfig,
  workspaceChatSandboxId,
  workspaceChatSandboxSpec,
} from "./chat-runtime.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"
import {
  emitOpencodeChatAttempt,
  opencodeChatStreamEvent,
  shouldFailEmptyChatTurn,
} from "./opencode-chat-stream.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import {
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
  workspaceChatSandboxSetupChunk,
  workspaceChatWireFormat,
} from "./workspace-chat-agui.js"
import {
  createWorkspaceChatAssistantGate,
  isOpenCodePlanningHold,
} from "./workspace-chat-assistant-text.js"
import { workspaceChatCompletionsBaseUrl } from "./workspace-chat-model-proxy.js"
import {
  WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV,
  WORKSPACE_CHAT_OPENCODE_JSON_SECRET,
  workspaceChatOpenCodeContract,
  writeWorkspaceChatOpenCodeConfig,
} from "./workspace-chat-opencode-contract.js"
import {
  messagesForOpenCodeChat,
  openCodeTrailingUserMiddleware,
} from "./workspace-chat-opencode-messages.js"
import { leaseLocalProcessOpenCodePort } from "./workspace-chat-opencode-port.js"
import {
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  markWorkspaceChatFirstShownToken,
} from "./workspace-chat-otel.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import {
  memoizedChatProvider,
  memoizedConversationSandbox,
} from "./workspace-chat-sandbox-memo.js"
import { mintWorkspaceChatToken } from "./workspace-chat-token.js"
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
  orgSlug?: string
  workspaceId: string
  desiredUrl?: string
  desiredSha?: string | null
  desiredGeneration?: number
  defaultBranch?: string
  lastBranch?: string | null
  ref?: string
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
    return memoizedChatProvider("docker", () =>
      modules.dockerSandbox?.(WORKSPACE_CHAT_DOCKER_SANDBOX),
    )
  }
  if (provider === "unsandboxed") {
    return memoizedChatProvider("unsandboxed", () =>
      modules.localProcessSandbox?.({
        scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
      }),
    )
  }
  return undefined
}

function chatProviderMatchesEffective(
  storedProvider: string | null,
  effective: string,
): boolean {
  return storedProvider === effective
}

function asTanstackLikeHandle(value: unknown): TanstackLikeHandle | null {
  if (!value || typeof value !== "object") return null
  const exec = (value as { process?: { exec?: unknown } }).process?.exec
  if (typeof exec !== "function") return null
  return value as TanstackLikeHandle
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
  try {
    let text = ""
    for await (const chunk of streamTanstackWorkspaceChat(input)) {
      const delta = aguiTextDelta(chunk)
      if (delta) {
        text += delta
        await input.onDelta?.(delta)
      }
    }
    return { ok: true, text }
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

  yield workspaceChatRunStarted({
    conversationId: turn.conversationId,
    runId: turn.runId,
  })
  yield workspaceChatSandboxSetupChunk("starting")

  const prepared = await startWorkspaceChat(turn)
  if (!prepared.ok) {
    await turn.onError?.()
    yield workspaceChatRunError(prepared.error)
    return
  }
  yield workspaceChatSandboxSetupChunk("ready")

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
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: turn.writeStatus,
    currentBranch: turn.ref,
    defaultBranch: turn.defaultBranch,
  })
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

  let streamError: Error | null = null
  let assistant = ""
  const gate = createWorkspaceChatAssistantGate(turn.prompt)
  try {
    let finished: StreamChunk | null = null
    const release = function* (chunks: object[]): Generator<StreamChunk> {
      for (const next of chunks) {
        const typed = next as StreamChunk
        if (typed.type === "RUN_ERROR") {
          streamError = new Error(
            "message" in typed && typeof typed.message === "string"
              ? typed.message
              : "OpenCode chat stream failed",
          )
          continue
        }
        if (typed.type === "RUN_STARTED") {
          continue
        }
        if (typed.type === "RUN_FINISHED") {
          finished = typed
          continue
        }
        const delta = aguiTextDelta(typed)
        if (delta) assistant += delta
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
    for await (const chunk of takeWorkspaceChatProducer(prepared.stream, {
      setupMs: turn.streamSetupMs,
      idleMs: turn.streamIdleMs,
    })) {
      const typed = chunk as StreamChunk
      if (typed.type === "RUN_ERROR") {
        streamError = new Error(
          "message" in typed && typeof typed.message === "string"
            ? typed.message
            : "OpenCode chat stream failed",
        )
        continue
      }
      yield* release(gate.take(chunk))
    }
    yield* release(gate.flush())
    assistant = gate.assistant() || assistant
    const failed =
      streamError != null ||
      !assistant.trim() ||
      isOpenCodePlanningHold(assistant) ||
      shouldFailEmptyChatTurn({ assistant, error: streamError })
    if (failed) {
      const error =
        streamError ?? new Error("workspace chat produced no assistant reply")
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
  const session = await resolveWorkspaceChatSession(input, built.spec.isolation)
  if (!session.ok) return session
  const { definition, handle } = memoizedConversationSandbox({
    conversationId: input.conversationId,
    specId: built.spec.id,
    isolation: built.spec.isolation,
    create: (box) =>
      defineConversationSandbox({
        modules: built.modules,
        spec: built.spec,
        input,
        provider: built.provider,
        runToken: session.runToken,
        proxyUrl: session.proxyUrl,
        modelBase: built.contract.modelBase,
        handle: box,
      }),
  })
  const ensureStarted = Date.now()
  try {
    if (typeof definition.ensure !== "function") {
      return { ok: false, status: 503, error: "sandbox ensure is unavailable" }
    }
    const ready = asTanstackLikeHandle(
      await definition.ensure({
        threadId: input.conversationId,
        runId: input.runId ?? `prepare-${input.conversationId}`,
        store: built.instances,
        tenant: { orgId: input.orgId },
        adapterName: "opencode",
      }),
    )
    if (ready) handle.current = ready
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
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
    currentBranch: input.lastBranch ?? input.ref,
    defaultBranch: input.defaultBranch,
  })
  const session = await resolveWorkspaceChatSession(input, built.spec.isolation)
  if (!session.ok) return session
  const portLease =
    built.spec.isolation === "unsandboxed"
      ? await leaseLocalProcessOpenCodePort()
      : null
  const { definition, handle } = memoizedConversationSandbox({
    conversationId: input.conversationId,
    specId: built.spec.id,
    isolation: built.spec.isolation,
    create: (box) =>
      defineConversationSandbox({
        modules: built.modules,
        spec: built.spec,
        input,
        provider: built.provider,
        runToken: session.runToken,
        proxyUrl: session.proxyUrl,
        modelBase: built.contract.modelBase,
        handle: box,
      }),
  })
  try {
    const toolsStarted = Date.now()
    const tools = await loadWorkspaceChatTools(input)
    log.info({
      step: "workspace-chat-timing",
      phase: "proxy-and-tools",
      message: `workspace chat timing proxy-and-tools ${Date.now() - toolsStarted}ms`,
      ms: Date.now() - toolsStarted,
      conversationId: input.conversationId,
    })
    const servePort = portLease?.port ?? WORKSPACE_CHAT_OPENCODE_PORT
    const modules = built.modules
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
      adapter: modules.opencodeText(built.contract.opencodeModel, {
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
        await portLease?.release().catch(() => undefined)
      },
    }
  } catch (error) {
    await portLease?.release().catch(() => undefined)
    throw error
  }
}

async function resolveWorkspaceChatSession(
  input: TanstackWorkspaceChatInput,
  isolation: "docker" | "unsandboxed" | "railway",
): Promise<
  | { ok: true; runToken: string; proxyUrl: string }
  | { ok: false; status: number; error: string }
> {
  const authSecret = process.env.AUTH_SECRET?.trim() ?? ""
  if (authSecret.length < 32) {
    return {
      ok: false,
      status: 503,
      error: "Workspace chat needs AUTH_SECRET to mint a completions token.",
    }
  }
  const orgSlug = await resolveWorkspaceChatOrgSlug(input)
  if (!orgSlug) {
    return {
      ok: false,
      status: 503,
      error: "Workspace chat needs an organization slug.",
    }
  }
  return {
    ok: true,
    runToken: mintWorkspaceChatToken({
      authSecret,
      orgId: input.orgId,
      conversationId: input.conversationId,
    }),
    proxyUrl: workspaceChatCompletionsBaseUrl({
      isolation,
      orgSlug,
      port: Number(process.env.PORT) || 3000,
    }),
  }
}

async function resolveWorkspaceChatOrgSlug(
  input: TanstackWorkspaceChatInput,
): Promise<string | null> {
  const fromInput = input.orgSlug?.trim()
  if (fromInput) return fromInput
  const [row] = await getSystemDb()
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1)
  return row?.slug ?? null
}

async function buildWorkspaceChatSandbox(input: TanstackWorkspaceChatInput) {
  const desiredUrl = input.desiredUrl?.trim() ?? ""
  if (!desiredUrl) {
    return {
      ok: false as const,
      status: 400,
      error: "workspace_required",
    }
  }
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
    currentBranch: input.lastBranch ?? input.ref,
    defaultBranch: input.defaultBranch,
  })
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
    desiredUrl,
    desiredSha: input.desiredSha ?? null,
    image: "chat:1",
  })
  const ref = input.desiredSha?.trim() || input.ref?.trim()
  if (!snapshotId || !ref) {
    return {
      ok: false as const,
      status: 409,
      error: "Workspace chat needs a stored desired SHA",
    }
  }
  const spec = workspaceChatSandboxSpec({
    sandboxId: snapshotId,
    provider: runtime.provider,
    gitUrl: desiredUrl,
    ref,
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
      conversationId: input.conversationId,
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
  const opencodeHome = writeWorkspaceChatOpenCodeConfig({
    conversationId: chatInput.conversationId,
    modelBase: input.modelBase,
  })
  const secrets = modules.createSecrets({
    CTXPIPE_OPENCODE_RUN_TOKEN: input.runToken,
    CTXPIPE_MODEL_PROXY_URL: input.proxyUrl,
    [WORKSPACE_CHAT_CLONE_URL_SECRET]: originUrlWithoutCredentials(
      chatInput.desiredUrl ?? "",
    ),
    [WORKSPACE_CHAT_CLONE_BRANCH_SECRET]:
      chatInput.defaultBranch?.trim() || "main",
    [WORKSPACE_CHAT_CLONE_SHA_SECRET]: chatInput.desiredSha?.trim() ?? "",
    [WORKSPACE_CHAT_OPENCODE_JSON_SECRET]: opencodeHome.configJson,
    ...(chatInput.lastBranch?.startsWith("ctxpipe/chat/")
      ? { [WORKSPACE_CHAT_SESSION_BRANCH_SECRET]: chatInput.lastBranch }
      : {}),
    ...opencodeHome.homeEnv,
    ...(chatInput.cloneToken
      ? { [WORKSPACE_CHAT_CLONE_TOKEN_SECRET]: chatInput.cloneToken }
      : {}),
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
    }),
    lifecycle: spec.lifecycle,
    hooks: {
      onReady: async (ready: TanstackLikeHandle) => {
        handle.current = ready
        const session = chatInput.lastBranch?.trim()
        if (session?.startsWith("ctxpipe/chat/") && ready.process?.exec) {
          await ready.process
            .exec(`git checkout -B ${session}`)
            .catch(() => undefined)
        }
        log.info({
          step: "workspace-chat-sandbox-ready",
          message: `workspace chat sandbox ready ${ready.id ?? "unknown"}`,
          conversationId: chatInput.conversationId,
          sandboxId: ready.id ?? null,
          lastBranch: session ?? null,
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
