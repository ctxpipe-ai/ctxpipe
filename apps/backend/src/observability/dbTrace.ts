import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import type { Pool, PoolClient } from "pg"
import { dbErrorException } from "./scrubDbError.js"

/**
 * Per-query Postgres CLIENT spans for the Bun API and the Node worker.
 * `@opentelemetry/instrumentation-pg` stays disabled: its module hook does not
 * patch pg on Bun, so this wrapper is the only span source. A query is traced
 * only while a request or job span is active. Text is parameterized.
 */

type PgQuery = (...args: unknown[]) => unknown

export type TraceablePgClient = {
  query: PgQuery
  database?: string
  connectionParameters?: {
    host?: string
    port?: number | string
    database?: string
  }
  options?: {
    host?: string
    port?: number | string
    database?: string
    connectionString?: string
  }
}

const instrumentedPools = new WeakSet<object>()
const instrumentedClients = new WeakSet<object>()

function capQueryText(text: string): string {
  const limit = 2048
  return text.length <= limit ? text : text.slice(0, limit)
}

function stripLeadingSqlComments(text: string): string {
  let rest = text
  for (;;) {
    const trimmed = rest.trimStart()
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n")
      rest = newline === -1 ? "" : trimmed.slice(newline + 1)
      continue
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/")
      rest = end === -1 ? "" : trimmed.slice(end + 2)
      continue
    }
    return trimmed
  }
}

const TABLE =
  /(?:(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)?("[^"]+"|[A-Za-z_][\w$]*)/

function collectionName(operation: string, text: string): string | undefined {
  const pattern =
    operation === "INSERT"
      ? new RegExp(String.raw`\binsert\s+into\s+${TABLE.source}`, "i")
      : operation === "UPDATE"
        ? new RegExp(String.raw`\bupdate\s+${TABLE.source}`, "i")
        : operation === "DELETE"
          ? new RegExp(String.raw`\bdelete\s+from\s+${TABLE.source}`, "i")
          : operation === "SELECT"
            ? new RegExp(String.raw`\bfrom\s+${TABLE.source}`, "i")
            : undefined
  const raw = pattern?.exec(text)?.[1]
  if (!raw) return undefined
  const name = raw.replaceAll('"', "")
  if (!name || name.length > 128) return undefined
  return name
}

function describeSql(text: string): {
  operation: string
  collection?: string
  statement: string
} {
  const statement = stripLeadingSqlComments(text)
  const operation = (
    statement.match(/^([A-Za-z]+)/)?.[1] ?? "QUERY"
  ).toUpperCase()
  const collection = collectionName(operation, statement)
  return {
    operation,
    ...(collection ? { collection } : {}),
    statement,
  }
}

function queryTextFromArgs(args: unknown[]): string | undefined {
  const first = args[0]
  if (typeof first === "string") return first
  if (
    first &&
    typeof first === "object" &&
    "text" in first &&
    typeof (first as { text?: unknown }).text === "string"
  ) {
    return (first as { text: string }).text
  }
  return undefined
}

function safeHost(host: string | undefined): string | undefined {
  if (!host) return undefined
  if (host.includes("@") || host.includes("://") || host.includes(" ")) {
    return undefined
  }
  return host
}

function safeDatabase(database: string | undefined): string | undefined {
  if (!database) return undefined
  if (database.includes("@") || database.includes("://")) return undefined
  return database
}

function numberPort(port: number | string | undefined): number | undefined {
  if (port === undefined || port === "") return undefined
  const parsed = typeof port === "number" ? port : Number(port)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

export function serverAddressFromUrl(uri: string | undefined): {
  address?: string
  port?: number
} {
  if (!uri) return {}
  try {
    const url = new URL(uri)
    const port = numberPort(url.port)
    return {
      ...(url.hostname ? { address: url.hostname } : {}),
      ...(port !== undefined ? { port } : {}),
    }
  } catch {
    return {}
  }
}

function endpoint(client: TraceablePgClient): {
  host?: string
  port?: number | string
  database?: string
} {
  const params = client.connectionParameters
  if (params?.host || params?.database) return params
  const options = client.options
  if (!options) return {}
  if (options.host || options.database) return options
  if (!options.connectionString) return {}
  try {
    const url = new URL(options.connectionString)
    return {
      host: url.hostname,
      port: url.port,
      database:
        decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
    }
  } catch {
    return {}
  }
}

function serverAttributes(
  client: TraceablePgClient,
): Record<string, string | number> {
  const params = endpoint(client)
  const attributes: Record<string, string | number> = {}
  const host = safeHost(params.host)
  if (host) attributes["server.address"] = host
  const port = numberPort(params.port)
  if (port !== undefined) attributes["server.port"] = port
  const database = safeDatabase(client.database ?? params.database)
  if (database) attributes["db.namespace"] = database
  return attributes
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code
  if ("cause" in error) return sqlState((error as { cause?: unknown }).cause)
  return undefined
}

function recordDbFailure(span: Span, error: unknown): void {
  const code = sqlState(error)
  if (code) {
    span.setAttribute("db.response.status_code", code)
    span.setAttribute("error.type", code)
  }
  const sanitized = dbErrorException(error)
  span.recordException(sanitized)
  span.setStatus({ code: SpanStatusCode.ERROR, message: sanitized.message })
}

function querySpanName(
  operation: string,
  collection: string | undefined,
): string {
  return collection ? `${operation} ${collection}` : operation
}

function tracePromiseQuery(
  client: TraceablePgClient,
  original: PgQuery,
  args: unknown[],
  tracerName: string,
): unknown {
  if (args.some((arg) => typeof arg === "function")) {
    return original.apply(client, args)
  }
  const text = queryTextFromArgs(args)
  if (text === undefined || !trace.getActiveSpan()) {
    return original.apply(client, args)
  }
  const described = describeSql(text)
  const attributes: Record<string, string | number> = {
    "db.system.name": "postgresql",
    "db.operation.name": described.operation,
    "db.query.text": capQueryText(described.statement),
    ...serverAttributes(client),
  }
  if (described.collection) {
    attributes["db.collection.name"] = described.collection
  }
  return trace
    .getTracer(tracerName)
    .startActiveSpan(
      querySpanName(described.operation, described.collection),
      { kind: SpanKind.CLIENT, attributes },
      async (span) => {
        try {
          return await original.apply(client, args)
        } catch (error) {
          recordDbFailure(span, error)
          throw error
        } finally {
          span.end()
        }
      },
    )
}

/** One CLIENT span per promise-API query, parented to the active span. */
export function instrumentPgClient(
  client: TraceablePgClient,
  tracerName = "ctxpipe-backend",
): void {
  if (instrumentedClients.has(client)) return
  instrumentedClients.add(client)
  const original = client.query
  client.query = ((...args: unknown[]) =>
    tracePromiseQuery(client, original, args, tracerName)) as PgQuery
}

/**
 * Trace `pool.query` and clients checked out with the promise API.
 * Drizzle uses both. Callback queries are left alone.
 */
export function instrumentPgPool(
  pool: Pool,
  options?: { tracerName?: string },
): void {
  if (instrumentedPools.has(pool)) return
  instrumentedPools.add(pool)
  const tracerName = options?.tracerName ?? "ctxpipe-backend"
  instrumentPgClient(pool as unknown as TraceablePgClient, tracerName)
  const originalConnect = pool.connect.bind(pool) as Pool["connect"]
  pool.connect = ((
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ) => {
    if (callback) return originalConnect(callback)
    return originalConnect().then((client) => {
      instrumentPgClient(client as unknown as TraceablePgClient, tracerName)
      return client
    })
  }) as Pool["connect"]
}

function describeCypher(query: string): {
  operation: string
  collection?: string
} {
  const statement = query.trim()
  const operation = (
    statement.match(/^([A-Za-z]+)/)?.[1] ?? "QUERY"
  ).toUpperCase()
  const label = statement.match(/\(\s*[A-Za-z0-9_]*\s*:\s*([A-Za-z_][\w]*)/)
  const collection = label?.[1]
  return {
    operation,
    ...(collection && collection.length <= 128 ? { collection } : {}),
  }
}

/** CLIENT span for one graph query. Skipped when no request or job span is active. */
export function traceGraphQuery<T>(
  input: {
    system: string
    query: string
    namespace?: string
    serverAddress?: string
    serverPort?: number
    tracerName?: string
  },
  run: () => Promise<T>,
): Promise<T> {
  if (!trace.getActiveSpan()) return run()
  const described = describeCypher(input.query)
  const attributes: Record<string, string | number> = {
    "db.system.name": input.system,
    "db.operation.name": described.operation,
    "db.query.text": capQueryText(input.query),
  }
  if (described.collection) {
    attributes["db.collection.name"] = described.collection
  }
  if (input.namespace && !input.namespace.includes("://")) {
    attributes["db.namespace"] = input.namespace
  }
  if (input.serverAddress) attributes["server.address"] = input.serverAddress
  if (input.serverPort !== undefined) {
    attributes["server.port"] = input.serverPort
  }
  return trace
    .getTracer(input.tracerName ?? "ctxpipe-backend")
    .startActiveSpan(
      querySpanName(described.operation, described.collection),
      { kind: SpanKind.CLIENT, attributes },
      async (span) => {
        try {
          return await run()
        } catch (error) {
          recordDbFailure(span, error)
          throw error
        } finally {
          span.end()
        }
      },
    )
}
