import "@langchain/core/callbacks/dispatch"
import { CallbackManager } from "@langchain/core/callbacks/manager"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import { getLangfuseHandler } from "../../observability/langfuse.js"

/**
 * Run ingestion ReAct nodes outside LangGraph with the Langfuse callback
 * handler on the LangChain config. Generations parent to the active OTel span.
 */
export function withIngestAgentContext<T>(
  attrs: {
    runName?: string
    metadata?: Record<string, unknown>
    tags?: string[]
  },
  fn: () => Promise<T>,
): Promise<T> {
  const handler = getLangfuseHandler()
  return AsyncLocalStorageProviderSingleton.runWithConfig(
    {
      callbacks: new CallbackManager(undefined, {
        handlers: [handler],
        inheritableHandlers: [handler],
        inheritableTags: attrs.tags,
        inheritableMetadata: attrs.metadata,
      }),
      runName: attrs.runName,
      tags: attrs.tags,
      metadata: attrs.metadata,
    },
    fn,
  )
}
