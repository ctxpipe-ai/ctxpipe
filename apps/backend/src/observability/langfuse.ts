import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { Serialized } from "@langchain/core/load/serializable"
import { CallbackHandler } from "@langfuse/langchain"
import { trace } from "@opentelemetry/api"
import { readAttribution } from "./attribution.js"
import { collapseRepeatedModelName } from "./collapseRepeatedModelName.js"
import { otelDeploymentEnvironment } from "./otel.js"

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

function collapseGenerationModelNames(output: unknown): void {
  if (!output || typeof output !== "object") return
  const generations = (output as { generations?: unknown }).generations
  if (!Array.isArray(generations)) return
  for (const group of generations) {
    if (!Array.isArray(group)) continue
    for (const generation of group) {
      if (!generation || typeof generation !== "object") continue
      const message = (
        generation as {
          message?: { response_metadata?: Record<string, unknown> }
        }
      ).message
      const modelName = message?.response_metadata?.model_name
      if (typeof modelName === "string" && message?.response_metadata) {
        message.response_metadata.model_name =
          collapseRepeatedModelName(modelName)
      }
    }
  }
}

function instrumentHandler(handler: CallbackHandler): CallbackHandler {
  const marked = handler as CallbackHandler & { ctxpipeModelFix?: boolean }
  if (marked.ctxpipeModelFix) return handler
  marked.ctxpipeModelFix = true
  const llmEnd = handler.handleLLMEnd.bind(handler)
  handler.handleLLMEnd = async (output, runId, parentRunId) => {
    collapseGenerationModelNames(output)
    return llmEnd(output, runId, parentRunId)
  }
  const generationStart = handler.handleGenerationStart.bind(handler)
  handler.handleGenerationStart = async (
    llm,
    messages,
    runId,
    parentRunId,
    extraParams,
    tags,
    metadata,
    name,
  ) => {
    const invocation = extraParams?.invocation_params
    if (
      invocation &&
      typeof invocation === "object" &&
      "model" in invocation &&
      typeof invocation.model === "string"
    ) {
      invocation.model = collapseRepeatedModelName(invocation.model)
    }
    return generationStart(
      llm,
      messages,
      runId,
      parentRunId,
      extraParams,
      tags,
      metadata,
      name,
    )
  }
  return handler
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (value == null) continue
    out[key] = typeof value === "string" ? value : JSON.stringify(value)
  }
  return out
}

export function runWithLangfuseContext<T>(
  attrs: LangfuseContextAttrs,
  fn: () => T | Promise<T>,
): Promise<T> {
  const current = langfuseStorage.getStore()
  const bag = readAttribution()
  const actor = bag["ctxpipe.actor.type"]
  const userId =
    actor === "org_api_key" ? undefined : (attrs.userId ?? bag["enduser.id"])
  const sessionId = attrs.sessionId ?? bag["ctxpipe.conversation.id"]
  const orgSlug = bag["ctxpipe.org.slug"]
  const envTag = `env:${otelDeploymentEnvironment()}`
  const orgTag = orgSlug ? `org:${orgSlug}` : ""
  const tags = uniqueTags([
    ...(attrs.tags ?? current?.tags ?? []),
    orgTag,
    envTag,
  ])
  const traceMetadata = {
    ...stringMetadata(current?.metadata),
    ...stringMetadata(attrs.traceMetadata),
    ...(bag["ctxpipe.org.id"] ? { orgId: bag["ctxpipe.org.id"] } : {}),
    ...(orgSlug ? { orgSlug } : {}),
    ...(bag["request.id"] ? { requestId: bag["request.id"] } : {}),
    ...(trace.getActiveSpan()?.spanContext().traceId
      ? { otelTraceId: trace.getActiveSpan()?.spanContext().traceId }
      : {}),
    environment: otelDeploymentEnvironment(),
  }
  const handler =
    current?.handler ??
    instrumentHandler(
      new CallbackHandler({
        ...(userId ? { userId } : {}),
        ...(sessionId ? { sessionId } : {}),
        tags,
        traceMetadata,
      }),
    )
  return langfuseStorage.run(
    {
      handler,
      parentRunId: current?.parentRunId,
      tags,
      metadata: traceMetadata,
    },
    fn,
  ) as Promise<T>
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) => tag.length > 0))]
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
