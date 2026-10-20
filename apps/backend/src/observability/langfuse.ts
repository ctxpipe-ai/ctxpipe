import { propagateAttributes, startActiveObservation } from "@langfuse/tracing"
import { readAttribution } from "./attribution.js"
import { otelDeploymentEnvironment } from "./otel.js"

type LangfuseContextAttrs = {
  sessionId?: string
  userId?: string
  tags?: string[]
  /** Merged onto the Langfuse trace (e.g. repositoryId, workflow). */
  traceMetadata?: Record<string, unknown>
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

/**
 * Langfuse trace attributes from `attrs` and the active attribution: the
 * user, the session, the `org:` and `env:` tags, and the org metadata.
 */
export function langfusePropagation(
  attrs: LangfuseContextAttrs,
): Parameters<typeof propagateAttributes>[0] {
  const bag = readAttribution()
  const userId =
    bag["ctxpipe.actor.type"] === "org_api_key"
      ? undefined
      : (attrs.userId ?? bag["enduser.id"])
  const sessionId = attrs.sessionId ?? bag["ctxpipe.conversation.id"]
  const orgSlug = bag["ctxpipe.org.slug"]
  const environment = otelDeploymentEnvironment()
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
  return {
    ...(userId ? { userId } : {}),
    ...(sessionId ? { sessionId } : {}),
    tags,
    ...(metadata ? { metadata } : {}),
  }
}

export function runWithLangfuseContext<T>(
  attrs: LangfuseContextAttrs,
  fn: () => T | Promise<T>,
): Promise<T> {
  return Promise.resolve(propagateAttributes(langfusePropagation(attrs), fn))
}

export function withLangfuseObservation<T>(
  attrs: {
    name: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
  },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithLangfuseContext({}, () =>
    startActiveObservation(
      attrs.name,
      async (span) => {
        span.update({
          ...(attrs.input !== undefined ? { input: attrs.input } : {}),
          metadata: {
            ...attrs.metadata,
          },
        })
        return fn()
      },
      { asType: "span" },
    ),
  )
}

export type LangfuseUsageDetails = {
  input?: number
  output?: number
  total?: number
}

function usageDetailsOrUndefined(
  usage: LangfuseUsageDetails | undefined,
): LangfuseUsageDetails | undefined {
  if (!usage) return undefined
  const details: LangfuseUsageDetails = {}
  if (usage.input !== undefined) details.input = usage.input
  if (usage.output !== undefined) details.output = usage.output
  if (usage.total !== undefined) details.total = usage.total
  return Object.keys(details).length > 0 ? details : undefined
}

export function withLangfuseGeneration<T>(
  attrs: {
    name: string
    model?: string
    input: Record<string, unknown>
    metadata?: Record<string, unknown>
    summarizeOutput?: (result: T) => Record<string, unknown>
    usageFromResult?: (result: T) => LangfuseUsageDetails | undefined
  },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithLangfuseContext({}, () =>
    startActiveObservation(
      attrs.name,
      async (generation) => {
        generation.update({
          input: attrs.input,
          ...(attrs.model ? { model: attrs.model } : {}),
          metadata: {
            ...attrs.metadata,
          },
        })
        try {
          const result = await fn()
          const usageDetails = usageDetailsOrUndefined(
            attrs.usageFromResult?.(result),
          )
          generation.update({
            output: attrs.summarizeOutput?.(result) ?? { status: "ok" },
            ...(usageDetails ? { usageDetails } : {}),
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
    ),
  )
}
