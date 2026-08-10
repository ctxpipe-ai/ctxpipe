import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { Serialized } from "@langchain/core/load/serializable"
import { CallbackHandler } from "@langfuse/langchain"

export type LangfuseContext = {
  handler: CallbackHandler
  parentRunId?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

const langfuseStorage = new AsyncLocalStorage<LangfuseContext>()

export type LangfuseContextAttrs = {
  sessionId?: string
  userId?: string
  tags?: string[]
  /** Merged onto the root Langfuse trace (e.g. repositoryId, workflow). */
  traceMetadata?: Record<string, unknown>
}

function serializedRun(name: string): Serialized {
  return {
    lc: 1,
    type: "constructor",
    id: ["ctxpipe", name],
    kwargs: {},
  }
}

export function tryGetLangfuseHandler(): CallbackHandler | undefined {
  return langfuseStorage.getStore()?.handler
}

export function getLangfuseHandler(): CallbackHandler {
  const handler = tryGetLangfuseHandler()
  if (!handler) {
    throw new Error(
      "Langfuse handler not set. Ensure runWithLangfuseContext() wraps this call.",
    )
  }
  return handler
}

export function tryGetLangfuseParentRunId(): string | undefined {
  return langfuseStorage.getStore()?.parentRunId
}

export function runWithLangfuseContext<T>(
  attrs: LangfuseContextAttrs,
  fn: () => T | Promise<T>,
): Promise<T> {
  const current = langfuseStorage.getStore()
  const handler = current?.handler ?? new CallbackHandler(attrs)
  return langfuseStorage.run(
    {
      handler,
      parentRunId: current?.parentRunId,
      tags: attrs.tags ?? current?.tags,
      metadata: attrs.traceMetadata ?? current?.metadata,
    },
    fn,
  ) as Promise<T>
}

export async function withLangfuseObservation<T>(
  attrs: {
    name: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
    tags?: string[]
  },
  fn: () => Promise<T>,
): Promise<T> {
  const current = langfuseStorage.getStore()
  if (!current) {
    return fn()
  }

  const runId = randomUUID()
  const parentRunId = current.parentRunId
  const metadata = {
    ...current.metadata,
    ...attrs.metadata,
    observationId: runId,
    parentObservationId: parentRunId ?? null,
  }
  const tags = attrs.tags ?? current.tags

  await current.handler.handleChainStart(
    serializedRun(attrs.name),
    attrs.input ?? {},
    runId,
    parentRunId,
    tags,
    metadata,
    undefined,
    attrs.name,
  )

  return langfuseStorage.run(
    {
      ...current,
      parentRunId: runId,
      tags,
      metadata,
    },
    async () => {
      try {
        const result = await fn()
        await current.handler.handleChainEnd(
          { output: { status: "ok" } },
          runId,
          parentRunId,
        )
        return result
      } catch (err) {
        await current.handler.handleChainError(err, runId, parentRunId)
        throw err
      }
    },
  )
}

export async function withLangfuseGeneration<T>(
  attrs: {
    name: string
    model?: string
    input: Record<string, unknown>
    metadata?: Record<string, unknown>
    tags?: string[]
    summarizeOutput?: (result: T) => Record<string, unknown>
  },
  fn: () => Promise<T>,
): Promise<T> {
  const current = langfuseStorage.getStore()
  if (!current) {
    return fn()
  }

  const runId = randomUUID()
  const parentRunId = current.parentRunId
  const metadata = {
    ...current.metadata,
    ...attrs.metadata,
    observationId: runId,
    parentObservationId: parentRunId ?? null,
  }
  const tags = attrs.tags ?? current.tags

  await current.handler.handleGenerationStart(
    serializedRun(attrs.name),
    [{ role: "user", content: JSON.stringify(attrs.input) }],
    runId,
    parentRunId,
    { invocation_params: { model: attrs.model } },
    tags,
    metadata,
    attrs.name,
  )

  try {
    const result = await fn()
    const output = attrs.summarizeOutput?.(result) ?? { status: "ok" }
    await current.handler.handleLLMEnd(
      {
        generations: [[{ text: JSON.stringify(output) }]],
        llmOutput: { tokenUsage: {} },
      },
      runId,
      parentRunId,
    )
    return result
  } catch (err) {
    await current.handler.handleLLMError(err, runId, parentRunId)
    throw err
  }
}
