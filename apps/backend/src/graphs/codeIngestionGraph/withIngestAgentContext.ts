import "@langchain/core/callbacks/dispatch"
import { CallbackManager } from "@langchain/core/callbacks/manager"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import {
  type RepositorySourceRevision,
  withRepositorySourceRevision,
} from "../../domain/codeIngestion/source-revision-context.js"
import {
  getLangfuseHandler,
  type LangfuseContextAttrs,
  runWithLangfuseContext,
} from "../../observability/langfuse.js"

/**
 * Run ingestion ReAct nodes outside LangGraph with the Langfuse callback
 * handler on the LangChain config. Generations parent to the active OTel span.
 */
export function withIngestAgentContext<T>(
  attrs: LangfuseContextAttrs & {
    source?: RepositorySourceRevision
    runName?: string
    metadata?: Record<string, unknown>
    tags?: string[]
  },
  fn: () => Promise<T>,
): Promise<T> {
  return withRepositorySourceRevision(attrs.source, () =>
    runWithLangfuseContext(attrs, () => {
      const handler = getLangfuseHandler()
      const metadata = {
        ...attrs.traceMetadata,
        ...attrs.metadata,
      }
      return AsyncLocalStorageProviderSingleton.runWithConfig(
        {
          callbacks: new CallbackManager(undefined, {
            handlers: [handler],
            inheritableHandlers: [handler],
            inheritableTags: attrs.tags,
            inheritableMetadata: metadata,
          }),
          runName: attrs.runName,
          tags: attrs.tags,
          metadata,
        },
        fn,
      )
    }),
  )
}
