import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai"
import { withOrgDbContext } from "../../db/client.js"
import { nameConversationIfUnnamed } from "../../graphs/conversationGraph/nodes/conversationNaming.js"
import { generateObjectId } from "../../lib/id.js"
import {
  appendConversationTurn,
  type ConversationTurn,
  loadConversationTurns,
} from "../../models/conversation-messages.js"
import {
  getWorkspaceById,
  listSandboxInstances,
  listWorkspaceKnowledgeUnitsForChat,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { hybridSearch } from "../../retrieval/index.js"
import { generateEmbedding } from "../../retrieval/services/modelProvider.js"
import { aguiIterableToUiMessageChunks } from "./agui-to-ui-message.js"
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
import { startWorkspaceChatModelProxy } from "./workspace-chat-model-proxy.js"
import {
  WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV,
  workspaceChatOpenCodeConfig,
  workspaceChatOpenCodeContract,
} from "./workspace-chat-opencode-contract.js"
import {
  formatWorkspaceChatHits,
  workspaceChatHybridHits,
} from "./workspace-chat-retrieval.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"

export type TanstackWorkspaceChatInput = {
  conversationId: string
  prompt: string
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
  onDelta?: (delta: string) => Promise<void> | void
  loadTurns?: (conversationId: string) => Promise<ConversationTurn[]>
  appendTurn?: (input: {
    conversationId: string
    role: "user" | "assistant"
    content: string
    orgId?: string
  }) => Promise<void>
  retrieveContext?: (query: string) => Promise<string>
}

export function conversationRenameChunk(name: string): UIMessageChunk {
  return {
    type: "data-rename-conversation",
    data: { name },
  } as UIMessageChunk
}

function aguiTextDelta(chunk: object): string {
  const record = chunk as Record<string, unknown>
  if (
    record.type === "TEXT_MESSAGE_CONTENT" &&
    typeof record.delta === "string"
  ) {
    return record.delta
  }
  return ""
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
    let text = ""
    for await (const chunk of prepared.stream) {
      const delta = aguiTextDelta(chunk)
      if (delta) {
        text += delta
        await input.onDelta?.(delta)
      }
    }
    await persistCompletedTurns(input, {
      persistUser: prepared.persistUserAfterSuccess,
      assistant: text,
    })
    return { ok: true, text }
  } catch (error) {
    await input.onError?.()
    throw error
  }
}

export async function runTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<Response> {
  const prepared = await prepareTanstackWorkspaceChat(input)
  if (!prepared.ok) {
    return Response.json({ error: prepared.error }, { status: prepared.status })
  }
  const textId = generateObjectId("txt")
  const uiChunks = aguiIterableToUiMessageChunks(prepared.stream, textId)
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
  })
  const readable = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      let lastHeartbeatAt: Date | null = null
      let assistant = ""
      const startedAt = Date.now()
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
        heartbeatChatSandboxes(input.conversationId, now)
        void input.onHeartbeat?.()
      }, CHAT_HEARTBEAT_INTERVAL_MS)
      const chatAttemptFields = (error?: unknown) =>
        opencodeChatStreamEvent({
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          error,
          provider: runtime.provider,
          opencodePort: WORKSPACE_CHAT_OPENCODE_PORT,
          durationMs: Date.now() - startedAt,
        })
      const recordChatAttempt = (error?: unknown) => {
        const fields = chatAttemptFields(error)
        const message = String(fields.message ?? "OpenCode chat stream failed")
        const logged =
          error == null
            ? null
            : error instanceof Error
              ? error
              : new Error(message)
        emitOpencodeChatAttempt(fields, logged)
        return { fields, logged, message }
      }
      const failTurn = async (error: unknown) => {
        const { logged, message } = recordChatAttempt(error)
        await input.onError?.()
        controller.error(logged ?? new Error(message))
      }
      try {
        lastHeartbeatAt = new Date()
        heartbeatChatSandboxes(input.conversationId, lastHeartbeatAt)
        void input.onHeartbeat?.()
        if (prepared.persistUserAfterSuccess) {
          await persistCompletedTurns(input, {
            persistUser: true,
            assistant: "",
          })
        }
        let finished = false
        const completeTurn = async () => {
          await persistCompletedTurns(input, {
            persistUser: false,
            assistant,
          })
          const name = await nameConversationIfUnnamed({
            conversationId: input.conversationId,
            prompt: input.prompt,
          }).catch(() => null)
          if (name) {
            controller.enqueue(conversationRenameChunk(name))
          }
          if (input.onFinish) await input.onFinish()
        }
        const captured = await withTanstackConsoleCapture(async () => {
          for await (const chunk of uiChunks) {
            if (chunk.type === "text-delta") assistant += chunk.delta
            if (chunk.type === "finish") finished = true
            controller.enqueue(chunk)
          }
        })
        const streamFatal = captured.fatal ?? prepared.constructFatal
        if (
          shouldFailEmptyChatTurn({
            assistant,
            error: streamFatal,
          })
        ) {
          await failTurn(streamFatal)
          return
        }
        if (finished || assistant.trim()) await completeTurn()
        recordChatAttempt()
        controller.close()
      } catch (error) {
        await failTurn(error)
      } finally {
        clearInterval(heartbeat)
      }
    },
  })
  return createUIMessageStreamResponse({ stream: readable })
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
      persistUserAfterSuccess: boolean
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

  const loadTurns = input.loadTurns ?? loadConversationTurns
  const append = input.appendTurn ?? appendConversationTurn
  const history = await loadTurns(input.conversationId)
  const persistUserAfterSuccess = history.length === 0
  if (!persistUserAfterSuccess) {
    await append({
      conversationId: input.conversationId,
      role: "user",
      content: input.prompt,
      orgId: input.orgId,
    })
  }
  const retrieval = input.retrieveContext
    ? await input.retrieveContext(input.prompt).catch(() => "")
    : await defaultWorkspaceChatRetrieval(input.prompt, {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      }).catch(() => "")
  const messages = [
    ...(retrieval ? [{ role: "user" as const, content: retrieval }] : []),
    ...history,
    { role: "user" as const, content: input.prompt },
  ]

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
        threadId: input.conversationId,
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
      persistUserAfterSuccess,
      constructFatal: constructed.fatal,
    }
  } catch (error) {
    await proxy.close().catch(() => undefined)
    throw error
  }
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

async function defaultWorkspaceChatRetrieval(
  query: string,
  input: { orgId: string; workspaceId: string },
): Promise<string> {
  const loaded = await withOrgDbContext(input.orgId, async () => {
    const workspace = await getWorkspaceById(input.workspaceId)
    if (!workspace?.activeProjectionSha) return null
    const units = await listWorkspaceKnowledgeUnitsForChat(input.workspaceId)
    return {
      activeProjectionSha: workspace.activeProjectionSha,
      units,
    }
  })
  if (!loaded) return ""
  let embedding: number[] | null = null
  let objectHits: Array<{ objectId: string }> = []
  try {
    embedding = await generateEmbedding(query)
    objectHits = await hybridSearch(
      input.orgId,
      { embedding, query },
      { limit: 20 },
    )
  } catch {
    embedding = null
    objectHits = []
  }
  return formatWorkspaceChatHits({
    activeProjectionSha: loaded.activeProjectionSha,
    hits: workspaceChatHybridHits({
      query,
      activeProjectionSha: loaded.activeProjectionSha,
      units: loaded.units,
      embedding,
      objectHits,
    }),
  })
}
