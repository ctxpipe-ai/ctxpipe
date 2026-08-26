import type { TanstackLikeHandle } from "./job-sandbox.js"

export type WorkspaceChatSandboxHandleBox = {
  current: TanstackLikeHandle | null
}

type ConversationSandboxEntry<T> = {
  specId: string
  isolation: string
  definition: T
  handle: WorkspaceChatSandboxHandleBox
}

const providers = new Map<string, unknown>()
const definitions = new Map<string, ConversationSandboxEntry<unknown>>()

/** One process-wide provider factory. Do not cache a missing factory. */
export function memoizedChatProvider<T>(
  key: string,
  create: () => T | undefined,
): T | undefined {
  if (providers.has(key)) return providers.get(key) as T
  const created = create()
  if (created === undefined) return undefined
  providers.set(key, created)
  return created
}

/**
 * One `defineSandbox` object per conversation while spec + isolation match.
 * TanStack resume needs that same object on later `ensure()` / `chat()` turns.
 */
export function memoizedConversationSandbox<T>(input: {
  conversationId: string
  specId: string
  isolation: string
  create: (handle: WorkspaceChatSandboxHandleBox) => T
}): { definition: T; handle: WorkspaceChatSandboxHandleBox } {
  const existing = definitions.get(input.conversationId)
  if (
    existing &&
    existing.specId === input.specId &&
    existing.isolation === input.isolation
  ) {
    return {
      definition: existing.definition as T,
      handle: existing.handle,
    }
  }
  const handle: WorkspaceChatSandboxHandleBox = { current: null }
  const definition = input.create(handle)
  definitions.set(input.conversationId, {
    specId: input.specId,
    isolation: input.isolation,
    definition,
    handle,
  })
  return { definition, handle }
}

export function memoizedConversationSandboxHandle(
  conversationId: string,
): TanstackLikeHandle | null {
  return definitions.get(conversationId)?.handle.current ?? null
}

export function forgetConversationSandboxDefinition(
  conversationId: string,
): void {
  definitions.delete(conversationId)
}

export function resetWorkspaceChatSandboxMemos(): void {
  providers.clear()
  definitions.clear()
}
