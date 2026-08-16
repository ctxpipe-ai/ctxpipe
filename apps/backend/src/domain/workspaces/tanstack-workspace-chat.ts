import { createUIMessageStreamResponse, type UIMessageChunk } from "ai"
import { generateObjectId } from "../../lib/id.js"
import { getLogger } from "../../observability/logger.js"
import { aguiIterableToUiMessageChunks } from "./agui-to-ui-message.js"
import {
  workspaceChatRuntimeConfig,
  workspaceChatSandboxId,
  workspaceChatSandboxSpec,
} from "./chat-runtime.js"

export type TanstackWorkspaceChatInput = {
  conversationId: string
  prompt: string
  orgId: string
  workspaceId: string
  desiredUrl: string
  desiredSha: string | null
  ref: string
  writeStatus: string
  onFinish?: () => Promise<void> | void
}

type ChatFn = (input: {
  adapter: unknown
  threadId: string
  messages: Array<{ role: "user"; content: string }>
  middleware: unknown[]
}) => AsyncIterable<{ type?: string; delta?: string }>

type SandboxModules = {
  chat: ChatFn
  opencodeText: (
    model: string,
    opts: { permissionMode: "acceptEdits"; onPermissionRequest?: unknown },
  ) => unknown
  defineSandbox: (input: Record<string, unknown>) => unknown
  defineWorkspace: (input: Record<string, unknown>) => unknown
  gitSource: (input: { url: string; ref: string }) => unknown
  withSandbox: (definition: unknown) => unknown
  dockerSandbox?: (input: { image: string }) => unknown
  localProcessSandbox?: () => unknown
}

async function loadTanstackModules(): Promise<SandboxModules> {
  const [{ chat }, { opencodeText }, sandbox, docker, local] =
    await Promise.all([
      import("@tanstack/ai"),
      import("@tanstack/ai-opencode"),
      import("@tanstack/ai-sandbox"),
      import("@tanstack/ai-sandbox-docker").catch(() => null),
      import("@tanstack/ai-sandbox-local-process").catch(() => null),
    ])
  return {
    chat: chat as ChatFn,
    opencodeText: opencodeText as SandboxModules["opencodeText"],
    defineSandbox: sandbox.defineSandbox,
    defineWorkspace: sandbox.defineWorkspace,
    gitSource: sandbox.gitSource,
    withSandbox: sandbox.withSandbox,
    dockerSandbox: docker?.dockerSandbox,
    localProcessSandbox: local?.localProcessSandbox,
  }
}

export async function runTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<Response> {
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
  })
  const sandboxId = workspaceChatSandboxId({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    desiredUrl: input.desiredUrl,
    desiredSha: input.desiredSha,
    image: "chat:1",
  })
  if (!sandboxId) {
    return Response.json(
      { error: "Workspace chat needs a stored desired SHA" },
      { status: 409 },
    )
  }
  const spec = workspaceChatSandboxSpec({
    sandboxId,
    provider: runtime.provider,
    gitUrl: input.desiredUrl,
    ref: input.ref,
  })
  if (!spec.ok) {
    return Response.json(
      {
        error:
          "Workspace chat requires an isolated TanStack sandbox provider. Host OpenCode is not a fallback.",
      },
      { status: 503 },
    )
  }

  const modules = await loadTanstackModules()
  const provider =
    spec.isolation === "docker"
      ? modules.dockerSandbox?.({ image: "node:22" })
      : modules.localProcessSandbox?.()
  if (!provider) {
    return Response.json(
      { error: "TanStack sandbox provider is not installed" },
      { status: 503 },
    )
  }

  const model =
    process.env.MODEL_FAST_NAME?.trim() || "anthropic/claude-sonnet-4-5"
  const definition = modules.defineSandbox({
    id: spec.id,
    provider,
    workspace: modules.defineWorkspace({
      source: modules.gitSource(spec.source),
    }),
    lifecycle: spec.lifecycle,
  })
  const stream = modules.chat({
    adapter: modules.opencodeText(model, {
      permissionMode: runtime.permissionMode,
      onPermissionRequest: runtime.onPermissionRequest,
    }),
    threadId: input.conversationId,
    messages: [{ role: "user", content: input.prompt }],
    middleware: [modules.withSandbox(definition)],
  })

  const textId = generateObjectId("txt")
  const uiChunks = aguiIterableToUiMessageChunks(stream, textId)
  const readable = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        for await (const chunk of uiChunks) {
          controller.enqueue(chunk)
        }
        if (input.onFinish) await input.onFinish()
        controller.close()
      } catch (error) {
        getLogger().error(
          error instanceof Error ? error : new Error(String(error)),
          { step: "tanstack-workspace-chat" },
        )
        controller.error(error)
      }
    },
  })
  return createUIMessageStreamResponse({ stream: readable })
}
