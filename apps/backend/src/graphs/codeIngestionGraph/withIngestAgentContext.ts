import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import {
  getLangfuseHandler,
  runWithLangfuseContext,
} from "../../observability/langfuse.js"

/**
 * Run ingestion ReAct nodes outside LangGraph while preserving Langfuse
 * callbacks (previously supplied via `graph.invoke({ callbacks })` + getConfig()).
 */
export function withIngestAgentContext<T>(
  attrs: {
    sessionId?: string
    tags?: string[]
    traceMetadata?: Record<string, unknown>
  },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithLangfuseContext(attrs, () =>
    AsyncLocalStorageProviderSingleton.runWithConfig(
      { callbacks: [getLangfuseHandler()] },
      fn,
    ),
  )
}
