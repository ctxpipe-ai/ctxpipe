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
  workspaceChatGitSource,
  workspaceChatRuntimeConfig,
  workspaceChatSandboxId,
  workspaceChatSandboxSpec,
} from "./chat-runtime.js"
import { adaptTanstackHandle, type TanstackLikeHandle } from "./job-sandbox.js"
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

function providerFactoryForStoredChat(
  modules: Awaited<ReturnType<typeof loadTanstackChatModules>>,
  storedProvider: string,
) {
  if (storedProvider === "sbx") return modules.sbxSandbox?.()
  if (storedProvider === "docker") {
    return modules.dockerSandbox?.({ image: "node:22" })
  }
  if (
    storedProvider === "local-process" ||
    storedProvider === "local_process"
  ) {
    return modules.localProcessSandbox?.()
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
  const readable = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      let lastHeartbeatAt: Date | null = null
      let assistant = ""
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
      try {
        lastHeartbeatAt = new Date()
        heartbeatChatSandboxes(input.conversationId, lastHeartbeatAt)
        void input.onHeartbeat?.()
        let finished = false
        const completeTurn = async () => {
          await persistCompletedTurns(input, {
            persistUser: prepared.persistUserAfterSuccess,
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
        for await (const chunk of uiChunks) {
          if (chunk.type === "text-delta") assistant += chunk.delta
          if (chunk.type === "finish") {
            finished = true
            await completeTurn()
          }
          controller.enqueue(chunk)
        }
        if (!finished) await completeTurn()
        controller.close()
      } catch (error) {
        getLogger().error(
          error instanceof Error ? error : new Error(String(error)),
          { step: "tanstack-workspace-chat" },
        )
        await input.onError?.()
        controller.error(error)
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
    }
  | { ok: false; status: number; error: string }
> {
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
  })
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
      ? modules.dockerSandbox?.({ image: "node:22" })
      : modules.localProcessSandbox?.()
  if (
    !storedProvider &&
    !provider &&
    locked !== "docker" &&
    locked !== "railway"
  ) {
    provider = modules.localProcessSandbox?.()
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

  const model =
    process.env.MODEL_FAST_NAME?.trim() || "anthropic/claude-sonnet-4-5"
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
  const stream = modules.chat({
    adapter: modules.opencodeText(model, {
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
  })
  return {
    ok: true,
    stream,
    persistUserAfterSuccess,
  }
}

async function defaultWorkspaceChatRetrieval(
  query: string,
  input: { orgId: string; workspaceId: string },
): Promise<string> {
  return withOrgDbContext(input.orgId, async () => {
    const workspace = await getWorkspaceById(input.workspaceId)
    if (!workspace?.activeProjectionSha) return ""
    const units = await listWorkspaceKnowledgeUnitsForChat(input.workspaceId)
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
      activeProjectionSha: workspace.activeProjectionSha,
      hits: workspaceChatHybridHits({
        query,
        activeProjectionSha: workspace.activeProjectionSha,
        units,
        embedding,
        objectHits,
      }),
    })
  })
}
