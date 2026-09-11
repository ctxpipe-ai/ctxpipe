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
  tryGetLangfuseParentRunId,
} from "../../observability/langfuse.js"

/**
 * Run ingestion ReAct nodes outside LangGraph while preserving Langfuse
 * callbacks (previously supplied via `graph.invoke({ callbacks })` + getConfig()).
 */
export function withIngestAgentContext<T>(
  attrs: LangfuseContextAttrs & {
    source?: RepositorySourceRevision
    runName?: string
    metadata?: Record<string, unknown>
  },
  fn: () => Promise<T>,
): Promise<T> {
  return withRepositorySourceRevision(attrs.source, () =>
    runWithLangfuseContext(attrs, () => {
      const handler = getLangfuseHandler()
      const parentObservationId = tryGetLangfuseParentRunId()
      const metadata = {
        ...attrs.traceMetadata,
        ...attrs.metadata,
        parentObservationId: parentObservationId ?? null,
      }
      return AsyncLocalStorageProviderSingleton.runWithConfig(
        {
          callbacks: new CallbackManager(parentObservationId, {
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
