import type { LLMResult } from "@langchain/core/outputs"
import { CallbackHandler } from "@langfuse/langchain"
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing"
import { readAttribution } from "./attribution.js"

export type LangfuseContextAttrs = {
  sessionId?: string
  userId?: string
  tags?: string[]
  /** Merged onto the Langfuse trace (e.g. repositoryId, workflow). */
  traceMetadata?: Record<string, unknown>
}

/**
 * `@langchain/core` 1.2.1 `_mergeDicts` concatenates `model_name` across
 * stream chunks. `id`, `name`, `output_version`, and `model_provider` are
 * the only protected string keys.
 */
export class CtxpipeCallbackHandler extends CallbackHandler {
  // LangChain runs handlers on a background queue by default, which drops the
  // active OTel span. Inline so generations parent to that span and inherit
  // propagateAttributes.
  awaitHandlers = true

  override async handleLLMEnd(
    output: LLMResult,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    for (const group of output.generations) {
      for (const generation of group) {
        const meta = (
          generation as {
            message?: { response_metadata?: { model_name?: unknown } }
          }
        ).message?.response_metadata
        const name = meta?.model_name
        const unit =
          typeof name === "string" ? /^(.+?)\1+$/.exec(name)?.[1] : undefined
        if (meta && unit) meta.model_name = unit
      }
    }
    return super.handleLLMEnd(output, runId, parentRunId)
  }
}

export function getLangfuseHandler(): CallbackHandler {
  return new CtxpipeCallbackHandler()
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) => tag.length > 0))]
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
  return Object.keys(out).length > 0 ? out : undefined
}

export function runWithLangfuseContext<T>(
  attrs: LangfuseContextAttrs,
  fn: () => T | Promise<T>,
): Promise<T> {
  const bag = readAttribution()
  const userId =
    bag["ctxpipe.actor.type"] === "org_api_key"
      ? undefined
      : (attrs.userId ?? bag["enduser.id"])
  const sessionId = attrs.sessionId ?? bag["ctxpipe.conversation.id"]
  const orgSlug = bag["ctxpipe.org.slug"]
  const environment = deploymentEnvironment()
  const tags = uniqueTags([
    ...(attrs.tags ?? []),
    orgSlug ? `org:${orgSlug}` : "",
    `env:${environment}`,
  ])
  const metadata = stringMetadata({
    ...attrs.traceMetadata,
    ...(bag["ctxpipe.org.id"] ? { orgId: bag["ctxpipe.org.id"] } : {}),
    ...(orgSlug ? { orgSlug } : {}),
    ...(bag["request.id"] ? { requestId: bag["request.id"] } : {}),
    environment,
  })
  return Promise.resolve(
    propagateAttributes(
      {
        ...(userId ? { userId } : {}),
        ...(sessionId ? { sessionId } : {}),
        tags,
        ...(metadata ? { metadata } : {}),
      },
      fn,
    ),
  )
}

export function withLangfuseObservation<T>(
  attrs: {
    name: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
    tags?: string[]
  },
  fn: () => Promise<T>,
): Promise<T> {
  return startActiveObservation(
    attrs.name,
    async (span) => {
      span.update({
        ...(attrs.input !== undefined ? { input: attrs.input } : {}),
        metadata: {
          ...attrs.metadata,
          ...(attrs.tags ? { tags: attrs.tags } : {}),
        },
      })
      return fn()
    },
    { asType: "span" },
  )
}

export function withLangfuseGeneration<T>(
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
  return startActiveObservation(
    attrs.name,
    async (generation) => {
      generation.update({
        input: attrs.input,
        ...(attrs.model ? { model: attrs.model } : {}),
        metadata: {
          ...attrs.metadata,
          ...(attrs.tags ? { tags: attrs.tags } : {}),
        },
      })
      try {
        const result = await fn()
        generation.update({
          output: attrs.summarizeOutput?.(result) ?? { status: "ok" },
        })
        return result
      } catch (err) {
        generation.update({
          level: "ERROR",
          statusMessage: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
    { asType: "generation" },
  )
}
