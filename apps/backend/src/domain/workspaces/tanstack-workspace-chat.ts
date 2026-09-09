import { trace } from "@opentelemetry/api"
import {
  defineChatMiddleware,
  type ModelMessage,
  modelMessagesToUIMessages,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai"
import { otelMiddleware } from "@tanstack/ai/middlewares/otel"
import { withPersistence } from "@tanstack/ai-persistence"
import {
  defineSandbox,
  getSandbox,
  SandboxCapability,
  type SandboxEnsureContext,
  type SandboxHandle,
  type SandboxProvider,
} from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { nameConversationIfUnnamed } from "../../graphs/conversationGraph/nodes/conversationNaming.js"
import { loadConversationTurns } from "../../models/conversation-messages.js"
import {
  getDesiredWorkspaceRevision,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { getLogger, log } from "../../observability/logger.js"
import {
  CHAT_SANDBOX_KEEP_ALIVE,
  WORKSPACE_CHAT_CLONE_BRANCH_SECRET,
  WORKSPACE_CHAT_CLONE_SHA_SECRET,
  WORKSPACE_CHAT_CLONE_TOKEN_SECRET,
  WORKSPACE_CHAT_CLONE_URL_SECRET,
  WORKSPACE_CHAT_DOCKER_SANDBOX,
  WORKSPACE_CHAT_OPENCODE_PORT,
  WORKSPACE_CHAT_SANDBOX_SETUP,
  WORKSPACE_CHAT_SESSION_BRANCH_SECRET,
  WORKSPACE_CHAT_THREAD_SETUP,
  workspaceChatRuntimeConfig,
  workspaceChatSandboxSpec,
} from "./chat-runtime.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import {
  sameWorkspaceBinding,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "./revision.js"
import {
  LegacyWorkspaceSandboxConflict,
  postgresSandboxInstanceStore,
} from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { discoverSandboxProvider } from "./sandbox-provider.js"
import { loadTanstackChatModules } from "./tanstack-runtime.js"
import {
  aguiTextDelta,
  conversationRenameChunk,
  type WorkspaceChatWireFormat,
  workspaceChatHttpResponse,
  workspaceChatWireFormat,
} from "./workspace-chat-agui.js"
import {
  sandboxCallbackHost,
  workspaceChatCallbackMiddleware,
} from "./workspace-chat-callback.js"
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
import {
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  markWorkspaceChatFirstShownToken,
} from "./workspace-chat-otel.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import {
  transitionWorkspaceChatRevision,
  WorkspaceChatRevisionConflict,
} from "./workspace-chat-revision-transition.js"
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

function conversationSandboxDefinition(provider: SandboxProvider) {
  return defineSandbox({
    id: "workspace-chat",
    provider,
    lifecycle: {
      reuse: "thread",
      snapshot: "after-setup",
      baseSnapshot: true,
      keepAlive: CHAT_SANDBOX_KEEP_ALIVE,
      destroyOnComplete: false,
    },
    hooks: {
      onWorkspaceTransition: transitionWorkspaceChatRevision,
      onReady: async (ready: SandboxHandle, ctx: SandboxEnsureContext) => {
        log.info({
          step: "workspace-chat-sandbox-ready",
          message: `workspace chat sandbox ready ${ready.id}`,
          conversationId: ctx.threadId,
          sandboxId: ready.id,
        })
      },
    },
  })
}

const CHAT_SANDBOX_DEFINITIONS = {
  docker: conversationSandboxDefinition(
    dockerSandbox(WORKSPACE_CHAT_DOCKER_SANDBOX),
  ),
  unsandboxed: conversationSandboxDefinition(
    localProcessSandbox({
      scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
    }),
  ),
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
}

export async function runTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<Response> {
  return workspaceChatHttpResponse(
    streamTanstackWorkspaceChat(input),
    input.wireFormat ?? workspaceChatWireFormat(new Request("http://local")),
  )
}

async function previousChatRevision(input: TanstackWorkspaceChatInput) {
  const expected = workspaceRevisionSchema.safeParse({
    workspaceId: input.workspaceId,
    remote: {
      url: input.desiredUrl,
      connectionId: input.githubConnectionId ?? null,
    },
    generation: input.desiredGeneration ?? 1,
    defaultBranch: input.defaultBranch ?? "main",
    sha: input.desiredSha,
    access: "read",
  })
  if (!expected.success) return null
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({
      conversationId: input.conversationId,
      kind: "chat",
      state: "live",
    }),
  )
  const compatible = rows.filter(
    (row) => row.revision && sameWorkspaceBinding(row.revision, expected.data),
  )
  if (compatible.some((row) => row.revision?.sha === input.desiredSha))
    return null
  return (
    compatible.sort(
      (a, b) => b.lastHeartbeatAt.getTime() - a.lastHeartbeatAt.getTime(),
    )[0]?.revision ?? null
  )
}

async function resumeStaleChatRevision(
  input: TanstackWorkspaceChatInput,
  revision: WorkspaceRevision,
) {
  const result = await warmTanstackWorkspaceChat(
    { ...input, desiredSha: revision.sha },
    { existingOnly: true, allowStale: false },
  )
  return result.ok ? { ...result, effectiveRevision: revision } : result
}

export async function warmTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
  options?: {
    existingOnly?: boolean
    allowStale?: boolean
    transcriptLocked?: boolean
  },
): Promise<
  | { ok: true; handle: SandboxHandle; effectiveRevision?: WorkspaceRevision }
  | { ok: false; status: number; error: string }
> {
  if (!options?.existingOnly && !options?.transcriptLocked) {
    return postgresSandboxLocks(
      input.orgId,
      abortControllerFrom(input.abortSignal),
    ).withLock(`chat-thread:${input.conversationId}`, () =>
      warmTanstackWorkspaceChat(input, { ...options, transcriptLocked: true }),
    )
  }
  const prepareStarted = Date.now()
  const built = await buildWorkspaceChatSandbox(input)
  if (!built.ok) return built
  const callbackHost = sandboxCallbackHost()
  const session = await resolveWorkspaceChatSession(
    input,
    built.spec.isolation,
    callbackHost,
  )
  if (!session.ok) return session
  const definition = built.definition
  const workspace = conversationSandboxWorkspace({
    modules: built.modules,
    spec: built.spec,
    input,
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
      workspace,
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
    if (!ready) {
      const previous =
        options?.allowStale === false ? null : await previousChatRevision(input)
      if (previous) return resumeStaleChatRevision(input, previous)
      return { ok: false, status: 409, error: "missing_sandbox" }
    }
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
    if (error instanceof LegacyWorkspaceSandboxConflict)
      return { ok: false, status: 409, error: error.message }
    if (error instanceof WorkspaceChatRevisionConflict) {
      if (options?.allowStale !== false)
        return resumeStaleChatRevision(input, error.revision)
      return { ok: false, status: 409, error: error.message }
    }
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
    }
  | { ok: false; status: number; error: string }
> {
  const built = await buildWorkspaceChatSandbox(input)
  if (!built.ok) return built
  let activeSandbox: SandboxHandle | undefined
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
    getCurrentBranch: async () => {
      if (!activeSandbox) throw new Error("Chat sandbox is not ready")
      const current = await activeSandbox.process.exec(
        "git branch --show-current",
      )
      if (current.exitCode !== 0)
        throw new Error("Chat working branch is unavailable")
      return current.stdout.trim()
    },
    defaultBranch: input.defaultBranch,
  })
  const callbackHost = sandboxCallbackHost()
  const session = await resolveWorkspaceChatSession(
    input,
    built.spec.isolation,
    callbackHost,
  )
  if (!session.ok) return session
  const definition = built.definition
  const workspace = conversationSandboxWorkspace({
    modules: built.modules,
    spec: built.spec,
    input,
    runToken: session.runToken,
    proxyUrl: session.proxyUrl,
    modelBase: built.contract.modelBase,
  })
  const servePort =
    built.spec.isolation === "unsandboxed" ? 0 : WORKSPACE_CHAT_OPENCODE_PORT
  const modules = built.modules
  const instances = built.instances
  let revisionRecoveryNotice: string | undefined
  const persistence = workspaceChatPersistence()
  const snapshots = {
    ...(await modules.memorySandboxSnapshots({
      sandbox: definition,
      workspace,
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
      defineChatMiddleware({
        name: "workspace-chat-revision",
        async setup() {
          if (!(await previousChatRevision(input))) return
          const prepared = await warmTanstackWorkspaceChat(input, {
            transcriptLocked: true,
          })
          if (!prepared.ok) throw new Error(prepared.error)
          if (!prepared.effectiveRevision) return
          const currentTarget = await withOrgDbContext(input.orgId, () =>
            getDesiredWorkspaceRevision(input.workspaceId),
          )
          if (!currentTarget)
            throw new Error("Workspace revision is no longer available")
          revisionRecoveryNotice =
            currentTarget.sha === prepared.effectiveRevision.sha
              ? undefined
              : JSON.stringify({
                  type: "workspace_revision_conflict",
                  effectiveSha: prepared.effectiveRevision.sha,
                  desiredSha: currentTarget.sha,
                  instructions:
                    "Keep the current branch. Publishing is blocked until it is rebased onto desiredSha. Inspect Git status and saved stashes before repairing. An interrupted transition is recorded at .git/ctxpipe-revision-transition; after recovering its saved edits and resolving the rebase, remove that marker so the next turn can validate the new revision. Never discard saved edits without the user's request.",
                })
          const retainedInput = {
            ...input,
            desiredSha: prepared.effectiveRevision.sha,
          }
          const retained = await buildWorkspaceChatSandbox(retainedInput)
          if (!retained.ok) throw new Error(retained.error)
          if (retained.definition !== definition)
            throw new Error("Sandbox provider changed during revision recovery")
          // These objects belong only to this run. Resolve them before native
          // middleware captures its exact key, projection and checkpoint state.
          Object.assign(
            workspace,
            conversationSandboxWorkspace({
              modules,
              spec: retained.spec,
              input: retainedInput,
              runToken: session.runToken,
              proxyUrl: session.proxyUrl,
              modelBase: built.contract.modelBase,
            }),
          )
          Object.assign(instances, retained.instances)
        },
        onConfig(_ctx, config) {
          if (!revisionRecoveryNotice) return
          return {
            systemPrompts: [...config.systemPrompts, revisionRecoveryNotice],
          }
        },
      }),
      modules.withSandbox(definition, {
        workspace,
        instances,
        locks: postgresSandboxLocks(
          input.orgId,
          abortController,
          `workspace-sandboxes:${input.workspaceId}`,
        ),
        snapshots,
      }),
      workspaceChatCallbackMiddleware(callbackHost),
      defineChatMiddleware({
        name: "workspace-chat-permissions",
        requires: [SandboxCapability],
        setup(ctx) {
          activeSandbox = getSandbox(ctx)
        },
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
  }
}

async function resolveWorkspaceChatSession(
  input: TanstackWorkspaceChatInput,
  isolation: "docker" | "unsandboxed" | "railway",
  callbackHost?: string,
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
      ...(callbackHost ? { callbackHost } : {}),
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
  const selectedProvider = await discoverSandboxProvider()
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
    sandboxId: `${input.orgId}:${JSON.stringify(revision.data)}:chat:${selectedProvider === "docker" ? WORKSPACE_CHAT_DOCKER_SANDBOX.image : "1"}`,
    provider: selectedProvider,
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
  const effective = selectedProvider
  const definition =
    effective === "docker" || effective === "unsandboxed"
      ? CHAT_SANDBOX_DEFINITIONS[effective]
      : undefined
  if (!definition) {
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
    definition,
    contract,
    instances: postgresSandboxInstanceStore({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      revision: revision.data,
      image: effective === "docker" ? WORKSPACE_CHAT_DOCKER_SANDBOX.image : "1",
    }),
  }
}

function conversationSandboxWorkspace(input: {
  modules: Awaited<ReturnType<typeof loadTanstackChatModules>>
  spec: Extract<ReturnType<typeof workspaceChatSandboxSpec>, { ok: true }>
  input: TanstackWorkspaceChatInput
  runToken: string
  proxyUrl: string
  modelBase: string
}) {
  const { modules, spec, input: chatInput } = input
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
  return modules.defineWorkspace({
    identity: spec.id,
    transitionIdentity: JSON.stringify({
      orgId: chatInput.orgId,
      workspaceId: chatInput.workspaceId,
      generation: chatInput.desiredGeneration ?? 1,
      url: spec.source.url,
      connectionId: chatInput.githubConnectionId ?? null,
      defaultBranch: chatInput.defaultBranch ?? "main",
      image:
        spec.isolation === "docker" ? WORKSPACE_CHAT_DOCKER_SANDBOX.image : "1",
    }),
    source: modules.gitSource({
      url: spec.source.url,
      ref: chatInput.defaultBranch ?? spec.source.ref,
      commit: chatInput.desiredSha ?? undefined,
      auth: { token: secrets[WORKSPACE_CHAT_CLONE_TOKEN_SECRET] },
    }),
    setup: [...WORKSPACE_CHAT_SANDBOX_SETUP],
    threadSetup: [...WORKSPACE_CHAT_THREAD_SETUP],
    secrets,
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
