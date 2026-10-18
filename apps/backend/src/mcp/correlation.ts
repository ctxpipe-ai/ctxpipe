import { createHash } from "node:crypto"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import {
  context,
  type Link,
  type SpanContext,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"
import { generateObjectId } from "../lib/id.js"
import {
  type AttributionInput,
  applyAttribution,
  contextWithForkedAttributionBag,
} from "../observability/attribution.js"
import { getLogger } from "../observability/logger.js"
import { MCP_TOOL_ERROR_CODES } from "./framework/tool-errors.js"
import { TOOL_ERROR_META_KEY } from "./framework/tool-result.js"

/**
 * Correlation for one MCP tool call (ADR-051 section 9).
 *
 * The model never sends correlation ids as tool arguments. The server reads
 * them from `_meta` and from `x-ctxpipe-*` headers. Each value is a short
 * opaque token, or the server ignores it. ClickHouse derives a session and a
 * turn for each connection key when the client sends no ids
 * (`ops/observability/clickhouse/schema/mcp-call-correlation.sql`).
 */

export type CorrelationSource =
  | "meta"
  | "header"
  | "baggage"
  | "openai"
  | "codex"

export type CorrelatedId = { id: string; source: CorrelationSource }

export type McpCorrelation = {
  conversation?: CorrelatedId
  turn?: CorrelatedId
  /** Client span context from a valid `_meta.traceparent` (a span link only). */
  parent?: SpanContext
  clientName?: string
}

type Headers = Record<string, string | string[] | undefined>

const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/
const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

function opaqueId(value: unknown): string | undefined {
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : undefined
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function baggageEntries(raw: unknown): Map<string, string> {
  const entries = new Map<string, string>()
  if (typeof raw !== "string") return entries
  for (const member of raw.split(",")) {
    const [pair] = member.split(";")
    const index = pair?.indexOf("=") ?? -1
    if (!pair || index < 1) continue
    try {
      entries.set(
        pair.slice(0, index).trim(),
        decodeURIComponent(pair.slice(index + 1).trim()),
      )
    } catch {
      // A bad percent escape: ignore this member only.
    }
  }
  return entries
}

function codexTurnMetadata(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function first(
  candidates: ReadonlyArray<[unknown, CorrelationSource]>,
): CorrelatedId | undefined {
  for (const [value, source] of candidates) {
    const id = opaqueId(value)
    if (id) return { id, source }
  }
  return undefined
}

/**
 * W3C trace context from `_meta.traceparent`; `undefined` when not valid.
 * The client `tracestate` is not kept: it must not go out on our requests.
 */
export function clientSpanContext(
  traceparent: unknown,
): SpanContext | undefined {
  if (typeof traceparent !== "string") return undefined
  const match = TRACEPARENT.exec(traceparent.trim())
  if (!match) return undefined
  const [, version, traceId, spanId, flags] = match
  if (!version || !traceId || !spanId || !flags || version === "ff") {
    return undefined
  }
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined
  return {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & 1,
    isRemote: true,
  }
}

function clientName(meta: Record<string, unknown>, headers: Headers) {
  const info = meta["io.modelcontextprotocol/clientInfo"]
  const fromInfo =
    typeof info === "object" && info !== null && "name" in info
      ? info.name
      : undefined
  const fromAgent = header(headers, "user-agent")?.split(/[/\s]/)[0]
  const name = typeof fromInfo === "string" ? fromInfo : fromAgent
  const cleaned = name
    ?.replace(/[^A-Za-z0-9._ -]/g, "")
    .trim()
    .slice(0, 64)
  return cleaned || undefined
}

/** Read correlation from request `_meta` and HTTP headers. Pure. */
export function readMcpCorrelation(input: {
  meta?: Record<string, unknown>
  headers?: Headers
}): McpCorrelation {
  const meta = input.meta ?? {}
  const headers = input.headers ?? {}
  const baggage = baggageEntries(meta.baggage)
  const codex = codexTurnMetadata(header(headers, "x-codex-turn-metadata"))
  const conversation = first([
    [meta["ai.ctxpipe/conversationId"], "meta"],
    [header(headers, "x-ctxpipe-conversation-id"), "header"],
    [baggage.get("ai.ctxpipe.conversationId"), "baggage"],
    [meta["openai/session"], "openai"],
    [codex.session_id ?? codex.sessionId, "codex"],
  ])
  const turn = first([
    [meta["ai.ctxpipe/turnId"], "meta"],
    [header(headers, "x-ctxpipe-turn-id"), "header"],
    [baggage.get("ai.ctxpipe.turnId"), "baggage"],
    [codex.turn_id ?? codex.turnId, "codex"],
  ])
  const parent = clientSpanContext(meta.traceparent)
  const name = clientName(meta, headers)
  return {
    ...(conversation ? { conversation } : {}),
    ...(turn ? { turn } : {}),
    ...(parent ? { parent } : {}),
    ...(name ? { clientName: name } : {}),
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Stable key for one client of one principal: a hash of the principal id and
 * the client identity (OAuth client id, else the client name). It holds no
 * secret. The inputs are ids with low entropy, so the hash is a pseudonym, not
 * a guarantee that nobody can find the principal.
 */
export function mcpConnectionKey(input: {
  principal: string
  client: string
}): string {
  return `mck_${sha256Hex(`${input.principal}\n${input.client}`).slice(0, 32)}`
}

/**
 * Pseudonym of an org slug for spans (ADR-051 section 9). It groups the calls
 * of one org in ClickHouse (`OrgSlugHash` in the call-correlation view) with no
 * slug on the span.
 */
export function mcpOrgSlugHash(slug: string): string {
  return sha256Hex(slug).slice(0, 32)
}

/** Put the hash of the org of this call on the active span. */
export function setMcpOrgSlugHash(slug: string): void {
  trace
    .getActiveSpan()
    ?.setAttribute("ctxpipe.mcp.org.slug_hash", mcpOrgSlugHash(slug))
}

function currentPrincipal(): { principal: string; oauthClientId?: string } {
  try {
    const vars = getContext<AppEnv>().var
    const oauthClientId = vars.oauthClientId ?? undefined
    if (vars.orgApiKey) {
      return { principal: `key:${vars.orgApiKey.id}`, oauthClientId }
    }
    if (vars.user?.id) {
      return { principal: `user:${vars.user.id}`, oauthClientId }
    }
  } catch {
    // Not in a Hono request.
  }
  return { principal: "anonymous" }
}

type ToolCallExtra = {
  _meta?: Record<string, unknown>
  requestInfo?: { headers?: Headers }
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }> | unknown[]
  isError?: boolean
  _meta?: Record<string, unknown>
}

type ToolFailure = {
  content: Array<{ type: "text"; text: string }>
  isError: true
  _meta?: Record<string, unknown>
}

export type McpToolCall = {
  callId: string
  connectionKey: string
  correlation: McpCorrelation
}

/**
 * Run one MCP tool call with correlation. The tool framework calls this for
 * each `tools/call`. It starts the `mcp.tool <name>` span as a child of the
 * HTTP server span. A valid `_meta.traceparent` becomes a span link, not the
 * parent, so the client cannot turn off our sampling. It puts the correlation attributes on the span and the request
 * log, and adds `_meta["ai.ctxpipe/callId"]` to the result.
 *
 * Do not pass tool arguments here. Query text, paths and repository URLs
 * must not go on spans.
 */
export async function runMcpToolCall<R extends ToolResult>(
  input: { toolName: string; extra: ToolCallExtra },
  fn: (call: McpToolCall) => Promise<R>,
): Promise<R | ToolFailure> {
  return runMcpCall<R | ToolFailure>(
    {
      kind: "tool",
      name: input.toolName,
      extra: input.extra,
      // Same shape as the SDK tool error; `withMeta` adds the call id.
      toResult: (exception) => ({
        content: [{ type: "text", text: exception.message }],
        isError: true,
      }),
    },
    fn,
  )
}

/**
 * Run one `resources/read` with the same correlation as a tool call: the
 * `mcp.resource <name>` span, the call id, and the attribution. A resource
 * read has no tool result, so each error goes back to the SDK as it is.
 * Do not pass the URI here: it holds a path.
 */
export async function runMcpResourceRead<
  R extends { _meta?: Record<string, unknown> },
>(
  input: { resourceName: string; extra: ToolCallExtra },
  fn: (call: McpToolCall) => Promise<R>,
): Promise<R> {
  return runMcpCall(
    { kind: "resource", name: input.resourceName, extra: input.extra },
    fn,
  )
}

/** Error codes that report a bad call, not a server fault (ADR-051 section 5). */
function isUserErrorCode(code: unknown): boolean {
  return (
    typeof code === "string" &&
    code !== "internal" &&
    (MCP_TOOL_ERROR_CODES as readonly string[]).includes(code)
  )
}

/** The `code` of the machine-readable error of a result, when it has one. */
function resultErrorCode(result: {
  isError?: boolean
  _meta?: Record<string, unknown>
}): string | undefined {
  if (!result.isError) return undefined
  const error = result._meta?.[TOOL_ERROR_META_KEY]
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined
  return typeof code === "string" ? code : undefined
}

async function runMcpCall<R extends { _meta?: Record<string, unknown> }>(
  input: {
    kind: "tool" | "resource"
    name: string
    extra: ToolCallExtra
    /** Turns a thrown error into a result. Without it, the error is thrown on. */
    toResult?: (exception: Error) => R
  },
  fn: (call: McpToolCall) => Promise<R>,
): Promise<R> {
  const correlation = readMcpCorrelation({
    meta: input.extra._meta,
    headers: input.extra.requestInfo?.headers,
  })
  const { principal, oauthClientId } = currentPrincipal()
  const connectionKey = mcpConnectionKey({
    principal,
    client: oauthClientId
      ? `oauth:${oauthClientId}`
      : `name:${correlation.clientName ?? "unknown"}`,
  })
  const callId = generateObjectId("call")
  const name = input.name.slice(0, 100)
  const attributes: AttributionInput = {
    [input.kind === "tool" ? "ctxpipe.mcp.tool" : "ctxpipe.mcp.resource"]: name,
    "ctxpipe.mcp.call.id": callId,
    "ctxpipe.mcp.connection.key": connectionKey,
    "ctxpipe.mcp.client.name": correlation.clientName,
    "ctxpipe.mcp.conversation.id": correlation.conversation?.id,
    "ctxpipe.mcp.conversation.source": correlation.conversation?.source,
    "ctxpipe.mcp.turn.id": correlation.turn?.id,
    "ctxpipe.mcp.turn.source": correlation.turn?.source,
    "ctxpipe.mcp.correlation.source": correlation.conversation
      ? "client"
      : "derived",
  }

  const links: Link[] = correlation.parent
    ? [{ context: correlation.parent }]
    : []
  const callContext = contextWithForkedAttributionBag(context.active())
  const withMeta = (result: R): R => {
    const final = {
      ...result,
      _meta: { ...result._meta, "ai.ctxpipe/callId": callId },
    }
    // The size of what the client gets, and why a tool call failed.
    const bytes = Buffer.byteLength(JSON.stringify(final))
    trace.getActiveSpan()?.setAttribute("ctxpipe.mcp.result.bytes", bytes)
    getLogger().set({ "ctxpipe.mcp.result.bytes": bytes })
    applyAttribution({
      "ctxpipe.mcp.error.code": resultErrorCode(
        final as { isError?: boolean; _meta?: Record<string, unknown> },
      ),
    })
    return final
  }

  return trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan(
      `mcp.${input.kind} ${name}`,
      { links },
      callContext,
      async (span) => {
        applyAttribution(attributes)
        try {
          return withMeta(await fn({ callId, connectionKey, correlation }))
        } catch (error) {
          const exception =
            error instanceof Error ? error : new Error(String(error))
          const errorData =
            error instanceof McpError &&
            typeof error.data === "object" &&
            error.data !== null
              ? (error.data as { code?: unknown })
              : undefined
          const userError = isUserErrorCode(errorData?.code)
          if (typeof errorData?.code === "string") {
            applyAttribution({ "ctxpipe.mcp.error.code": errorData.code })
          }
          // A bad call is not a server fault, as for a tool call that
          // returns `isError`. Only an internal error marks the span.
          if (!userError) {
            span.recordException(exception)
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: exception.message,
            })
          }
          // The SDK sends an McpError as a protocol error. Keep that path,
          // and give the client the call id in the error data.
          if (error instanceof McpError) {
            throw new McpError(
              error.code,
              error.message.replace(`MCP error ${error.code}: `, ""),
              {
                ...(typeof error.data === "object" ? error.data : {}),
                "ai.ctxpipe/callId": callId,
              },
            )
          }
          if (!input.toResult) throw error
          return withMeta(input.toResult(exception))
        } finally {
          span.end()
        }
      },
    )
}
