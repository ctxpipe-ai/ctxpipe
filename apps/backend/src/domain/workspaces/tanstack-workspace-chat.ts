import { trace } from "@opentelemetry/api"
import {
  type ModelMessage,
  modelMessagesToUIMessages,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai"
import { otelMiddleware } from "@tanstack/ai/middlewares/otel"
import { withPersistence } from "@tanstack/ai-persistence"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { eq } from "drizzle-orm"
import { getSystemDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { nameConversationIfUnnamed } from "../../graphs/conversationGraph/nodes/conversationNaming.js"
import { loadConversationTurns } from "../../models/conversation-messages.js"
import { getLogger, log } from "../../observability/logger.js"
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
  workspaceChatSandboxSpec,
} from "./chat-runtime.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import { ensureConversationSessionBranch } from "./conversation-files.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import { workspaceRevisionSchema } from "./revision.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { loadTanstackChatModules } from "./tanstack-runtime.js"
import {
  aguiTextDelta,
  conversationRenameChunk,
  type WorkspaceChatWireFormat,
  workspaceChatHttpResponse,
  workspaceChatWireFormat,
} from "./workspace-chat-agui.js"
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
import { mintWorkspaceChatToken } from "./workspace-chat-token.js"
import { WORKSPACE_CHAT_TOOLS } from "./workspace-chat-tools.js"

export type TanstackWorkspaceChatMessage = {
  id?: string
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
  githubConnectionId?: string | null
  defaultBranch?: string
  lastBranch?: string | null
  ref?: string
  writeStatus: string
  cloneToken?: string | null
  onFinish?: () => Promise<void> | void
  onError?: () => Promise<void> | void
  onUserPersist?: () => Promise<void> | void
  onDelta?: (delta: string) => Promise<void> | void
  resolveRuntime?: () => Promise<Partial<TanstackWorkspaceChatInput>>
  wireFormat?: WorkspaceChatWireFormat
}

export { conversationRenameChunk } from "./workspace-chat-agui.js"

function providerFactoryForChat(
  modules: Awaited<ReturnType<typeof loadTanstackChatModules>>,
  provider: string,
) {
  if (provider === "docker") {
    return modules.dockerSandbox?.(WORKSPACE_CHAT_DOCKER_SANDBOX)
  }
  if (provider === "unsandboxed") {
    return modules.localProcessSandbox?.({
      scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
    })
  }
  return undefined
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
  const prepared = await startWorkspaceChat(turn)
  if (!prepared.ok) throw new Error(prepared.error)
  try {
    for await (const chunk of prepared.stream) {
      const typed = chunk as StreamChunk
      if (typed.type === "RUN_ERROR") await turn.onError?.()
      if (typed.type === "RUN_FINISHED") {
        const name = await nameConversationIfUnnamed({
          conversationId: turn.conversationId,
          prompt: turn.prompt,
        })
        if (name) yield conversationRenameChunk(name)
        await turn.onFinish?.()
      }
      if (
        typed.type === "TEXT_MESSAGE_CONTENT" ||
        typed.type === "REASONING_MESSAGE_CONTENT" ||
        typed.type === "TOOL_CALL_START"
      )
        markWorkspaceChatFirstShownToken(turn.conversationId)
      yield typed
    }
  } finally {
    await prepared.dispose()
  }
}

export async function runTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<Response> {
  return workspaceChatHttpResponse(
    streamTanstackWorkspaceChat(input),
    input.wireFormat ?? workspaceChatWireFormat(new Request("http://local")),
  )
}

export async function warmTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
  options?: { existingOnly?: boolean },
): Promise<
  | { ok: true; handle: SandboxHandle }
  | { ok: false; status: number; error: string }
> {
  const prepareStarted = Date.now()
  const built = await buildWorkspaceChatSandbox(input)
  if (!built.ok) return built
  const session = await resolveWorkspaceChatSession(input, built.spec.isolation)
  if (!session.ok) return session
  const definition = defineConversationSandbox({
    modules: built.modules,
    spec: built.spec,
    input,
    provider: built.provider,
    runToken: session.runToken,
    proxyUrl: session.proxyUrl,
    modelBase: built.contract.modelBase,
  })
  const ensureStarted = Date.now()
  const abortController = abortControllerFrom(input.abortSignal)
  try {
    const ensure = options?.existingOnly
      ? definition.ensureExisting
      : definition.ensure
    const ready = await ensure({
      threadId: input.conversationId,
      runId: input.runId ?? `prepare-${input.conversationId}`,
      store: built.instances,
      locks: postgresSandboxLocks(
        input.orgId,
        abortController,
        `workspace-sandboxes:${input.workspaceId}`,
      ),
      signal: abortController.signal,
      // Match the optional fields emitted by native withSandbox's tenantFrom.
      tenant: { userId: undefined, orgId: input.orgId },
      adapterName: "opencode",
    })
    if (!ready) return { ok: false, status: 409, error: "missing_sandbox" }
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
    return { ok: true, handle: ready }
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
  const definition = defineConversationSandbox({
    modules: built.modules,
    spec: built.spec,
    input,
    provider: built.provider,
    runToken: session.runToken,
    proxyUrl: session.proxyUrl,
    modelBase: built.contract.modelBase,
  })
  try {
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
    const abortController = abortControllerFrom(input.abortSignal)
    const stream = await modules.chat({
      adapter: modules.opencodeText(built.contract.opencodeModel, {
        port: servePort,
        permissionMode: runtime.permissionMode,
        onPermissionRequest: runtime.onPermissionRequest,
      }),
      threadId: input.conversationId,
      runId: input.runId,
      context: {
        orgId: input.orgId,
        orgSlug: await resolveWorkspaceChatOrgSlug(input),
        workspaceId: input.workspaceId,
      },
      messages: (input.messages
        ? messagesForOpenCodeChat(input.messages, input.prompt)
        : []) as Array<ModelMessage | UIMessage>,
      abortController,
      tools: WORKSPACE_CHAT_TOOLS,
      middleware: [
        otelMiddleware({
          tracer: trace.getTracer("ctxpipe-workspace-chat"),
        }),
        withPersistence(persistence, {
          snapshotStreaming: true,
          threadLocks: postgresSandboxLocks(input.orgId, abortController),
        }),
        modules.withSandbox(definition, {
          instances,
          locks: postgresSandboxLocks(
            input.orgId,
            abortController,
            `workspace-sandboxes:${input.workspaceId}`,
          ),
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
  const revision = workspaceRevisionSchema.safeParse({
    workspaceId: input.workspaceId,
    remote: { url: desiredUrl, connectionId: input.githubConnectionId ?? null },
    sha: input.desiredSha,
    generation: input.desiredGeneration ?? 1,
    defaultBranch: input.defaultBranch ?? "main",
    access: "read",
  })
  const ref = input.desiredSha?.trim() || input.ref?.trim()
  if (!revision.success || !ref) {
    return {
      ok: false as const,
      status: 409,
      error: "Workspace chat needs a stored desired SHA",
    }
  }
  const spec = workspaceChatSandboxSpec({
    sandboxId: `${input.orgId}:${JSON.stringify(revision.data)}:chat:1`,
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
  const effective = runtime.provider
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
      revision: revision.data,
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
}) {
  const { modules, spec, provider, input: chatInput } = input
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
    [WORKSPACE_CHAT_CLONE_TOKEN_SECRET]: chatInput.cloneToken ?? "",
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
      onReady: async (ready: SandboxHandle) => {
        const session = chatInput.lastBranch?.trim()
        if (session?.startsWith("ctxpipe/chat/")) {
          await ensureConversationSessionBranch({
            handle: adaptTanstackHandle(ready),
            conversationId: chatInput.conversationId,
            defaultBranch: chatInput.defaultBranch ?? "main",
          })
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

export async function conversationHasStoredTurns(
  conversationId: string,
): Promise<boolean> {
  const persisted =
    await workspaceChatPersistence().stores.messages.loadThread(conversationId)
  if (persisted.length > 0) return true
  const turns = await loadConversationTurns(conversationId)
  return turns.length > 0
}

export function conversationUiMessagesFromModelMessages(
  messages: Parameters<typeof modelMessagesToUIMessages>[0],
) {
  return modelMessagesToUIMessages(messages)
}
