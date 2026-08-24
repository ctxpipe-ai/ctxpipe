import { randomBytes } from "node:crypto"
import type { ChatMiddleware, StreamChunk } from "@tanstack/ai"
import { withOrgDbContext } from "../../db/client.js"
import { nameConversationIfUnnamed } from "../../graphs/conversationGraph/nodes/conversationNaming.js"
import { generateObjectId } from "../../lib/id.js"
import { appendConversationTurn } from "../../models/conversation-messages.js"
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
  WORKSPACE_CHAT_CLONE_TOKEN_SECRET,
  WORKSPACE_CHAT_DOCKER_SANDBOX,
  WORKSPACE_CHAT_OPENCODE_PORT,
  WORKSPACE_CHAT_SANDBOX_SETUP,
  workspaceChatCloneTokenRef,
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
} from "./opencode-chat-stream.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import {
  attachChatSandboxHandle,
  heartbeatChatSandboxes,
} from "./sandbox-registry.js"
import { loadTanstackChatModules } from "./tanstack-runtime.js"
import {
  aguiTextDelta,
  conversationRenameChunk,
  takeWorkspaceChatProducer,
  WORKSPACE_CHAT_HEARTBEAT_EVENT,
  type WorkspaceChatWireFormat,
  withWorkspaceChatHeartbeats,
  workspaceChatHttpResponse,
  workspaceChatRunError,
  workspaceChatRunStarted,
  workspaceChatWireFormat,
} from "./workspace-chat-agui.js"
import {
  createWorkspaceChatAssistantGate,
  isOpenCodePlanningHold,
} from "./workspace-chat-assistant-text.js"
import {
  getWorkspaceChatConversationRuntime,
  setWorkspaceChatConversationRuntime,
  type WorkspaceChatConversationRuntime,
} from "./workspace-chat-conversation-runtime.js"
import { startWorkspaceChatModelProxy } from "./workspace-chat-model-proxy.js"
import {
  isOpenCodeServeHealthy,
  startConversationOpenCodeServe,
  streamAttachedOpenCodeTurn,
} from "./workspace-chat-opencode-attach.js"
import {
  WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV,
  workspaceChatOpenCodeConfig,
  workspaceChatOpenCodeContract,
  workspaceChatOpenCodeHomeEnv,
} from "./workspace-chat-opencode-contract.js"
import {
  type LocalProcessOpenCodePortLease,
  leaseLocalProcessOpenCodePort,
} from "./workspace-chat-opencode-port.js"
import {
  loadWorkspaceChatOpenCodeSessionId,
  persistWorkspaceChatOpenCodeSessionId,
  type WorkspaceChatFetch,
  waitForOpenCodeAssistant,
  workspaceChatOpenCodeSessionId,
} from "./workspace-chat-opencode-session.js"
import {
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  markWorkspaceChatFirstShownToken,
} from "./workspace-chat-otel.js"
import {
  ensureChatSandboxCheckout,
  invalidateChatSandbox,
  preflightChatSandbox,
  streamSawOpenCodeSession,
} from "./workspace-chat-sandbox-health.js"
import { workspaceSnapshotFromChatInput } from "./workspace-chat-send-runtime.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"
import {
  claimWorkspaceChatTurn,
  type WorkspaceChatTurnClaim,
} from "./workspace-chat-turn-claim.js"

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
  /** Set when the user turn + lastMessageAt were already written for this Send. */
  userTurnAccepted?: boolean
  acceptedTurn?: WorkspaceChatTurnClaim
  resolveRuntime?: () => Promise<Partial<TanstackWorkspaceChatInput>>
  wireFormat?: WorkspaceChatWireFormat
  appendTurn?: (input: {
    conversationId: string
    role: "user" | "assistant"
    content: string
    orgId?: string
  }) => Promise<void>
  streamSetupMs?: number
  streamIdleMs?: number
  openCodeIdleMs?: number
  openCodeFetch?: WorkspaceChatFetch
  prepareOnly?: boolean
}

export { conversationRenameChunk } from "./workspace-chat-agui.js"

type PreparedChatTurn = {
  stream: AsyncIterable<object>
  isolation: "docker" | "local_process"
  servePort: number
  handle: { current: TanstackLikeHandle | null }
  portStuck: { current: boolean }
}

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
    const gate = createWorkspaceChatAssistantGate(input.prompt)
    for await (const chunk of prepared.stream) {
      for (const next of gate.take(chunk)) {
        const delta = aguiTextDelta(next)
        if (delta) await input.onDelta?.(delta)
      }
    }
    for (const next of gate.flush()) {
      const delta = aguiTextDelta(next)
      if (delta) await input.onDelta?.(delta)
    }
    const text = gate.assistant()
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
  yield workspaceChatRunStarted({
    conversationId: input.conversationId,
    runId: input.runId,
  })
  yield {
    type: "CUSTOM",
    name: WORKSPACE_CHAT_HEARTBEAT_EVENT,
    value: { at: Date.now() },
    timestamp: Date.now(),
  } as StreamChunk
  let claim: WorkspaceChatTurnClaim | null = input.acceptedTurn ?? null
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    yield* streamClaimedTanstackWorkspaceChat(input, {
      takeClaim(next) {
        claim = next
      },
      setHeartbeat(next) {
        heartbeat = next
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await input.onError?.()
    yield workspaceChatRunError(message)
  } finally {
    claim?.release()
    if (heartbeat) clearInterval(heartbeat)
  }
}

async function* streamClaimedTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
  hold: {
    takeClaim: (claim: WorkspaceChatTurnClaim) => void
    setHeartbeat: (heartbeat: ReturnType<typeof setInterval>) => void
  },
): AsyncGenerator<StreamChunk> {
  const resolved = input.resolveRuntime ? await input.resolveRuntime() : {}
  const turn: TanstackWorkspaceChatInput = { ...input, ...resolved }
  const claim = turn.acceptedTurn ?? claimWorkspaceChatTurn(turn.conversationId)
  if (!claim) {
    await turn.onError?.()
    yield workspaceChatRunError("conversation_busy")
    return
  }
  hold.takeClaim(claim)
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
  hold.setHeartbeat(heartbeat)

  const startedAt = Date.now()
  const chatAttemptFields = (error?: unknown) =>
    opencodeChatStreamEvent({
      conversationId: turn.conversationId,
      workspaceId: turn.workspaceId,
      error,
      provider: runtime.provider,
      opencodePort: prepared.servePort,
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

  const gate = createWorkspaceChatAssistantGate(turn.prompt)
  let finished = false
  let sawSession = false
  let streamError: Error | null = null
  let sessionId: string | null = null
  let lateAssistant = ""
  try {
    for await (const chunk of takeWorkspaceChatProducer(prepared.stream, {
      setupMs: turn.streamSetupMs,
      idleMs: turn.streamIdleMs,
      afterTerminal: async () => {
        const early = gate.assistant()
        if (early.trim() && !isOpenCodePlanningHold(early)) return
        if (!sessionId) return
        lateAssistant = await waitForOpenCodeAssistant({
          port: prepared.servePort,
          sessionId,
          prompt: turn.prompt,
          timeoutMs: turn.openCodeIdleMs,
          fetch: turn.openCodeFetch,
        })
      },
    })) {
      sessionId = sessionId ?? workspaceChatOpenCodeSessionId(chunk)
      if (sessionId) {
        persistWorkspaceChatOpenCodeSessionId(turn.conversationId, sessionId)
      }
      if (streamSawOpenCodeSession(chunk)) sawSession = true
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
        if (typed.type === "TEXT_MESSAGE_CONTENT") {
          markWorkspaceChatFirstShownToken(turn.conversationId)
        }
        yield typed
      }
    }
    for (const next of gate.flush()) {
      const typed = next as StreamChunk
      if (typed.type === "RUN_FINISHED") finished = true
      if (typed.type === "RUN_ERROR") {
        streamError = new Error(
          "message" in typed && typeof typed.message === "string"
            ? typed.message
            : "OpenCode chat stream failed",
        )
      }
    }
    let assistant = gate.assistant()
    if (
      lateAssistant.trim() &&
      (!assistant.trim() || isOpenCodePlanningHold(assistant))
    ) {
      assistant = lateAssistant.trim()
      const messageId = generateObjectId("msg")
      yield {
        type: "TEXT_MESSAGE_START",
        messageId,
        timestamp: Date.now(),
      } as StreamChunk
      markWorkspaceChatFirstShownToken(turn.conversationId)
      yield {
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: assistant,
        timestamp: Date.now(),
      } as StreamChunk
      yield {
        type: "TEXT_MESSAGE_END",
        messageId,
        timestamp: Date.now(),
      } as StreamChunk
    }
    const failed =
      streamError != null ||
      prepared.portStuck.current ||
      !assistant.trim() ||
      shouldFailEmptyChatTurn({
        assistant,
        error: streamError,
      })
    if (failed) {
      const error =
        streamError ??
        (prepared.portStuck.current
          ? new Error(`port ${prepared.servePort} still bound`)
          : new Error("workspace chat produced no assistant reply"))
      if (!sawSession || prepared.portStuck.current) {
        await invalidateChatSandbox({
          handle: prepared.handle.current,
          orgId: turn.orgId,
          conversationId: turn.conversationId,
        })
      }
      const { message } = recordChatAttempt(error)
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
    yield { type: "RUN_FINISHED" } as StreamChunk
  } catch (error) {
    if (!sawSession) {
      await invalidateChatSandbox({
        handle: prepared.handle.current,
        orgId: turn.orgId,
        conversationId: turn.conversationId,
      })
    }
    const { message } = recordChatAttempt(error)
    await turn.onError?.()
    yield workspaceChatRunError(message)
  } finally {
    claim.release()
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
  | ({ ok: true } & PreparedChatTurn)
  | { ok: false; status: number; error: string }
> {
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
  })
  const contract = workspaceChatOpenCodeContract(process.env)
  if (contract.ok) {
    log.info({
      step: "workspace-chat-model",
      tier: contract.tier,
      modelSpec: contract.modelSpec,
      modelBase: contract.modelBase,
      conversationId: input.conversationId,
    })
  }
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
    ref: input.desiredSha ?? input.ref,
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
  const resumeSessionId = loadWorkspaceChatOpenCodeSessionId(
    input.conversationId,
  )

  const existingRuntime = getWorkspaceChatConversationRuntime(
    input.conversationId,
  )
  const runToken = existingRuntime?.runToken ?? randomBytes(32).toString("hex")
  const prepareStarted = Date.now()
  let proxyLease: LocalProcessOpenCodePortLease | null =
    existingRuntime?.proxyLease ?? null
  let proxy: Awaited<ReturnType<typeof startWorkspaceChatModelProxy>>
  let tools: Awaited<ReturnType<typeof workspaceChatTools>>
  try {
    if (existingRuntime) {
      proxy = existingRuntime.proxy
      tools = existingRuntime.tools
      log.info({
        step: "workspace-chat-timing",
        phase: "proxy-and-tools",
        message: "workspace chat timing proxy-and-tools 0ms",
        ms: 0,
        reused: true,
        conversationId: input.conversationId,
      })
    } else {
      if (spec.isolation === "local_process") {
        proxyLease = await leaseLocalProcessOpenCodePort()
      }
      const proxyAndToolsStarted = Date.now()
      ;[proxy, tools] = await Promise.all([
        startWorkspaceChatModelProxy({
          runToken,
          conversationId: input.conversationId,
          upstreamBaseUrl: contract.upstreamBaseUrl,
          upstreamApiKey: contract.apiKey,
          modelBase: contract.modelBase,
          modelParams: contract.modelParams,
          listenHost: "0.0.0.0",
          advertisedHost:
            spec.isolation === "docker" ? "host.docker.internal" : "127.0.0.1",
          ...(proxyLease ? { port: proxyLease.port } : {}),
        }),
        (async () => {
          const activeProjectionSha = await withOrgDbContext(
            input.orgId,
            async () => {
              const workspace = await getWorkspaceById(input.workspaceId)
              return workspace?.activeProjectionSha ?? null
            },
          ).catch(() => null)
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
        })(),
      ])
      log.info({
        step: "workspace-chat-timing",
        phase: "proxy-and-tools",
        message: `workspace chat timing proxy-and-tools ${Date.now() - proxyAndToolsStarted}ms`,
        ms: Date.now() - proxyAndToolsStarted,
        conversationId: input.conversationId,
      })
    }
  } catch (error) {
    if (!existingRuntime) await proxyLease?.release().catch(() => undefined)
    throw error
  }
  const opencodeConfig = workspaceChatOpenCodeConfig({
    modelBase: contract.modelBase,
  })

  let portLease: LocalProcessOpenCodePortLease | null =
    existingRuntime?.servePortLease ?? null
  const handle = { current: null as TanstackLikeHandle | null }
  const portStuck = { current: false }
  try {
    if (spec.isolation === "local_process" && !portLease) {
      const reserved = [
        ...new Set(
          [proxyLease?.port, tcpPortFromUrl(proxy.baseUrl)].filter(
            (port): port is number => port != null,
          ),
        ),
      ]
      portLease = await leaseLocalProcessOpenCodePort(
        reserved.length > 0 ? { reserved } : undefined,
      )
    }
    const servePort =
      portLease?.port ??
      existingRuntime?.servePort ??
      WORKSPACE_CHAT_OPENCODE_PORT
    log.info({
      step: "workspace-chat-ports",
      conversationId: input.conversationId,
      proxyUrl: proxy.baseUrl,
      servePort,
    })
    const secrets = modules.createSecrets({
      CTXPIPE_OPENCODE_RUN_TOKEN: runToken,
      CTXPIPE_MODEL_PROXY_URL: `${proxy.baseUrl}/v1`,
      ...(spec.isolation === "local_process"
        ? workspaceChatOpenCodeHomeEnv(input.conversationId)
        : {}),
      ...(input.cloneToken
        ? { [WORKSPACE_CHAT_CLONE_TOKEN_SECRET]: input.cloneToken }
        : {}),
    })
    const definition = modules.defineSandbox({
      id: spec.id,
      provider,
      workspace: modules.defineWorkspace({
        source: modules.gitSource(
          workspaceChatGitSource({
            url: spec.source.url,
            ref: input.defaultBranch ?? spec.source.ref,
            token: workspaceChatCloneTokenRef(
              secrets as Record<string, unknown>,
              input.cloneToken,
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
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            orgId: input.orgId,
            desiredUrl: input.desiredUrl,
            desiredGeneration: input.desiredGeneration,
            desiredSha: input.desiredSha,
            defaultBranch: input.defaultBranch,
            handle: adaptTanstackHandle(ready),
            destroy: () => ready.destroy(),
          }).catch((error) => {
            getLogger().error(
              error instanceof Error ? error : new Error(String(error)),
              { step: "attach-chat-sandbox-handle" },
            )
          })
          const checkoutStarted = Date.now()
          await ensureChatSandboxCheckout({
            handle: ready,
            repoUrl: input.desiredUrl,
            defaultBranch: input.defaultBranch ?? "main",
            desiredSha: input.desiredSha,
          })
          log.info({
            step: "workspace-chat-timing",
            phase: "sandbox-checkout",
            message: `workspace chat timing sandbox-checkout ${Date.now() - checkoutStarted}ms`,
            ms: Date.now() - checkoutStarted,
            conversationId: input.conversationId,
          })
          await preflightChatSandbox({
            handle: ready,
            isolation: spec.isolation,
            proxyUrl: proxy.baseUrl,
            stalePort:
              spec.isolation === "docker"
                ? WORKSPACE_CHAT_OPENCODE_PORT
                : undefined,
          })
        },
      },
    })
    if (input.prepareOnly && typeof definition.ensure === "function") {
      const ready = (await definition.ensure({
        threadId: input.conversationId,
        runId: input.runId ?? `prepare-${input.conversationId}`,
        store: postgresSandboxInstanceStore({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
        }),
        tenant: { orgId: input.orgId },
        adapterName: "opencode",
      })) as TanstackLikeHandle
      handle.current = ready
      await definition.hooks?.onReady?.(
        ready as Parameters<NonNullable<typeof definition.hooks.onReady>>[0],
      )
      const serve = await startConversationOpenCodeServe({
        handle: ready,
        port: servePort,
        isolation: spec.isolation,
      })
      rememberConversationRuntime({
        conversationId: input.conversationId,
        runToken,
        proxy,
        proxyLease,
        servePort,
        servePortLease: portLease,
        tools,
        serve,
        workspace: workspaceSnapshotFromChatInput(input),
      })
      log.info({
        step: "workspace-chat-timing",
        phase: "prepare",
        message: `workspace chat timing prepare ${Date.now() - prepareStarted}ms`,
        ms: Date.now() - prepareStarted,
        conversationId: input.conversationId,
        attached: false,
        served: Boolean(serve),
      })
      return {
        ok: true,
        stream: emptyChatStream(),
        isolation: spec.isolation,
        servePort,
        handle,
        portStuck,
      }
    }
    let conversationRuntime = rememberConversationRuntime({
      conversationId: input.conversationId,
      runToken,
      proxy,
      proxyLease,
      servePort,
      servePortLease: portLease,
      tools,
      serve: existingRuntime?.serve ?? null,
      workspace: workspaceSnapshotFromChatInput(input),
    })
    if (conversationRuntime.serve) {
      const healthy = await isOpenCodeServeHealthy(
        conversationRuntime.serve.baseUrl,
        conversationRuntime.serve.headers,
      )
      if (!healthy) {
        conversationRuntime = setWorkspaceChatConversationRuntime({
          ...conversationRuntime,
          serve: null,
        })
      }
    }
    const chatStarted = Date.now()
    const attached = conversationRuntime.serve
      ? streamAttachedOpenCodeTurn({
          baseUrl: conversationRuntime.serve.baseUrl,
          ...(conversationRuntime.serve.headers
            ? { headers: conversationRuntime.serve.headers }
            : {}),
          model: contract.opencodeModel,
          prompt: input.prompt,
          sessionId: resumeSessionId,
          threadId: input.conversationId,
          runId: input.runId,
          onPermissionRequest: runtime.onPermissionRequest,
        })
      : null
    const result =
      attached ??
      (await modules.chat({
        adapter: modules.opencodeText(contract.opencodeModel, {
          port: servePort,
          permissionMode: runtime.permissionMode,
          onPermissionRequest: runtime.onPermissionRequest,
        }),
        threadId: input.conversationId,
        runId: input.runId,
        messages,
        ...(resumeSessionId
          ? { modelOptions: { sessionId: resumeSessionId } }
          : {}),
        tools,
        middleware: [
          ...(await workspaceChatOtelMiddleware()),
          modules.withSandbox(definition, {
            instances: postgresSandboxInstanceStore({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
            }),
          }),
        ],
      }))
    log.info({
      step: "workspace-chat-timing",
      phase: "chat-create",
      message: `workspace chat timing chat-create ${Date.now() - chatStarted}ms`,
      ms: Date.now() - chatStarted,
      attached: Boolean(attached),
      conversationId: input.conversationId,
    })
    log.info({
      step: "workspace-chat-timing",
      phase: "prepare",
      message: `workspace chat timing prepare ${Date.now() - prepareStarted}ms`,
      ms: Date.now() - prepareStarted,
      conversationId: input.conversationId,
    })
    return {
      ok: true,
      stream: keepConversationRuntimeAfterStream(result, {
        conversationId: input.conversationId,
        handle,
        isolation: spec.isolation,
        servePort,
        portStuck,
      }),
      isolation: spec.isolation,
      servePort,
      handle,
      portStuck,
    }
  } catch (error) {
    if (!existingRuntime) {
      await proxy.close().catch(() => undefined)
      await proxyLease?.release().catch(() => undefined)
      await portLease?.release().catch(() => undefined)
    }
    throw error
  }
}

export async function warmTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const existing = getWorkspaceChatConversationRuntime(input.conversationId)
  if (existing?.serve) return { ok: true }
  const prepared = await prepareTanstackWorkspaceChat({
    ...input,
    prepareOnly: true,
    prompt: input.prompt || "prepare",
  })
  if (!prepared.ok) return prepared
  try {
    for await (const _chunk of prepared.stream) {
      void _chunk
    }
  } catch {
    if (getWorkspaceChatConversationRuntime(input.conversationId)?.serve) {
      return { ok: true }
    }
    return { ok: false, status: 503, error: "workspace chat prepare failed" }
  }
  return { ok: true }
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

function tcpPortFromUrl(url: string): number | null {
  try {
    const port = Number(new URL(url).port)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

async function* emptyChatStream(): AsyncGenerator<object> {}

function rememberConversationRuntime(
  runtime: Omit<WorkspaceChatConversationRuntime, "lastUsedAt" | "serve"> & {
    serve: WorkspaceChatConversationRuntime["serve"]
    workspace?: WorkspaceChatConversationRuntime["workspace"]
  },
): WorkspaceChatConversationRuntime {
  const existing = getWorkspaceChatConversationRuntime(runtime.conversationId)
  return setWorkspaceChatConversationRuntime({
    ...runtime,
    workspace: runtime.workspace ?? existing?.workspace,
  })
}

async function workspaceChatOtelMiddleware(): Promise<ChatMiddleware[]> {
  try {
    const [{ otelMiddleware }, { trace }] = await Promise.all([
      import("@tanstack/ai/middlewares/otel"),
      import("@opentelemetry/api"),
    ])
    return [
      otelMiddleware({
        tracer: trace.getTracer("ctxpipe-workspace-chat"),
      }),
    ]
  } catch {
    return []
  }
}

async function* keepConversationRuntimeAfterStream(
  stream: AsyncIterable<object>,
  input: {
    conversationId: string
    handle: { current: TanstackLikeHandle | null }
    isolation: "docker" | "local_process"
    servePort: number
    portStuck: { current: boolean }
  },
): AsyncGenerator<object> {
  try {
    yield* stream
  } finally {
    const runtime = getWorkspaceChatConversationRuntime(input.conversationId)
    if (runtime && !runtime.serve && input.handle.current) {
      const serve = await startConversationOpenCodeServe({
        handle: input.handle.current,
        port: input.servePort,
        isolation: input.isolation,
        attempts: 1,
        timeoutMs: 4_000,
      })
      if (serve) {
        setWorkspaceChatConversationRuntime({
          ...runtime,
          serve,
        })
      }
    }
    void input.portStuck
  }
}
