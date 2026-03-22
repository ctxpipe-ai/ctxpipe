import { AsyncLocalStorage } from "node:async_hooks"
import { CallbackHandler } from "@langfuse/langchain"

export type LangfuseContext = {
  handler: CallbackHandler
}

const langfuseStorage = new AsyncLocalStorage<LangfuseContext>()

export function getLangfuseHandler(): CallbackHandler {
  const handler = langfuseStorage.getStore()?.handler
  if (!handler) {
    throw new Error(
      "Langfuse handler not set. Ensure runWithLangfuseContext() wraps this call.",
    )
  }
  return handler
}

export function runWithLangfuseContext<T>(
  attrs: {
    sessionId?: string
    userId?: string
    tags?: string[]
    /** Merged onto the root Langfuse trace (e.g. repositoryId, workflow). */
    traceMetadata?: Record<string, unknown>
  },
  fn: () => T | Promise<T>,
): Promise<T> {
  const handler = new CallbackHandler(attrs)
  return langfuseStorage.run({ handler }, fn) as Promise<T>
}
