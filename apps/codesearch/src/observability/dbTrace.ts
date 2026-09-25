import {
  context,
  type Context,
  SpanKind,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import type { Pool, PoolClient } from "pg"
import { dbErrorException, scrubDrizzleParams } from "./scrubDbError.js"

/**
 * `@opentelemetry/instrumentation-pg` is disabled in `nodeAutoInstrumentationConfig`.
 * When its hook is installed before `pg` loads it emits `pg.query:*` spans beside
 * these. This wrapper is the only Postgres span source.
 */

type SqlBoundary =
  | "begin"
  | "commit"
  | "rollback"
  | "savepoint"
  | "release"
  | "rollback_to"
  | "statement"

type PgQuery = (...args: unknown[]) => unknown

export type TraceablePgClient = {
  query: PgQuery
  database?: string
  connectionParameters?: {
    host?: string
    port?: number | string
    database?: string
    password?: string
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

function sqlBoundary(text: string): SqlBoundary {
  const statement = stripLeadingSqlComments(text).toLowerCase()
  if (/^rollback\s+to\s+savepoint\b/.test(statement)) return "rollback_to"
  if (/^rollback\b/.test(statement)) return "rollback"
  if (/^release\s+savepoint\b/.test(statement)) return "release"
  if (/^savepoint\b/.test(statement)) return "savepoint"
  if (/^begin\b/.test(statement) || /^start\s+transaction\b/.test(statement)) {
    return "begin"
  }
  if (/^commit\b/.test(statement)) return "commit"
  return "statement"
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
  boundary: SqlBoundary
} {
  const statement = stripLeadingSqlComments(text)
  const operation = (statement.match(/^([A-Za-z]+)/)?.[1] ?? "QUERY").toUpperCase()
  const collection = collectionName(operation, statement)
  return {
    operation,
    ...(collection ? { collection } : {}),
    boundary: sqlBoundary(statement),
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

function serverAttributes(
  client: TraceablePgClient,
): Record<string, string | number> {
  const params = client.connectionParameters
  const attributes: Record<string, string | number> = {}
  const host = safeHost(params?.host)
  if (host) attributes["server.address"] = host
  const port = numberPort(params?.port)
  if (port !== undefined) attributes["server.port"] = port
  const database = safeDatabase(client.database ?? params?.database)
  if (database) attributes["db.namespace"] = database
  return attributes
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

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code
  if ("cause" in error) return sqlState((error as { cause?: unknown }).cause)
  return undefined
}

function sanitizedDbError(error: unknown): Error {
  const sanitized = dbErrorException(error)
  if (sanitized.stack) {
    sanitized.stack = scrubDrizzleParams(sanitized.stack)
  }
  return sanitized
}

function recordDbFailure(span: Span, error: unknown): void {
  const code = sqlState(error)
  if (code) {
    span.setAttribute("db.response.status_code", code)
    span.setAttribute("error.type", code)
  }
  const sanitized = sanitizedDbError(error)
  span.recordException(sanitized)
  span.setStatus({ code: SpanStatusCode.ERROR, message: sanitized.message })
}

function querySpanName(operation: string, collection: string | undefined): string {
  return collection ? `${operation} ${collection}` : operation
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

function parentContext(txStack: Span[]): Context | undefined {
  const current = txStack[txStack.length - 1]
  if (current) return trace.setSpan(context.active(), current)
  if (trace.getActiveSpan()) return context.active()
  return undefined
}

function endTransaction(
  txStack: Span[],
  error: unknown | undefined,
  failed: boolean,
): void {
  const txSpan = txStack.pop()
  if (!txSpan) return
  try {
    if (failed) {
      if (error) recordDbFailure(txSpan, error)
      else txSpan.setStatus({ code: SpanStatusCode.ERROR })
    }
  } finally {
    txSpan.end()
  }
}

function traceCall(
  original: PgQuery,
  client: TraceablePgClient,
  args: unknown[],
  onSettle: (error: unknown | undefined) => void,
): unknown {
  let settled = false
  const settle = (error: unknown | undefined) => {
    if (settled) return
    settled = true
    onSettle(error)
  }
  const last = args[args.length - 1]
  if (typeof last === "function") {
    const callback = last as (error: unknown, result?: unknown) => void
    const next = args.slice(0, -1)
    next.push((error: unknown, result?: unknown) => {
      settle(error ?? undefined)
      callback(error, result)
    })
    try {
      return original.apply(client, next)
    } catch (error) {
      settle(error)
      throw error
    }
  }
  try {
    const result = original.apply(client, args)
    if (!isThenable(result)) {
      settle(undefined)
      return result
    }
    return result.then(
      (value) => {
        settle(undefined)
        return value
      },
      (error: unknown) => {
        settle(error)
        throw error
      },
    )
  } catch (error) {
    settle(error)
    throw error
  }
}

function runStatement(
  client: TraceablePgClient,
  original: PgQuery,
  args: unknown[],
  text: string,
  parent: Context,
  tracerName: string,
  after?: (error: unknown | undefined) => void,
): unknown {
  const described = describeSql(text)
  const span = trace.getTracer(tracerName).startSpan(
    querySpanName(described.operation, described.collection),
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system.name": "postgresql",
        "db.operation.name": described.operation,
        ...(described.collection
          ? { "db.collection.name": described.collection }
          : {}),
        "db.query.text": capQueryText(text),
        ...serverAttributes(client),
      },
    },
    parent,
  )
  return traceCall(original, client, args, (error) => {
    try {
      if (error) recordDbFailure(span, error)
    } finally {
      span.end()
      after?.(error)
    }
  })
}

function startTransactionSpan(
  client: TraceablePgClient,
  boundary: "begin" | "savepoint",
  parent: Context,
  tracerName: string,
): Span {
  const nested = boundary === "savepoint"
  return trace.getTracer(tracerName).startSpan(
    nested ? "postgresql savepoint" : "postgresql transaction",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system.name": "postgresql",
        "db.operation.name": nested ? "SAVEPOINT" : "BEGIN",
        ...serverAttributes(client),
      },
    },
    parent,
  )
}

function tracePgQuery(
  client: TraceablePgClient,
  original: PgQuery,
  txStack: Span[],
  args: unknown[],
  tracerName: string,
): unknown {
  const text = queryTextFromArgs(args)
  if (text === undefined) return original.apply(client, args)
  const boundary = sqlBoundary(text)

  if (boundary === "begin" || boundary === "savepoint") {
    if (boundary === "begin" && txStack.length > 0) {
      while (txStack.length > 0) txStack.pop()?.end()
    }
    const parent = parentContext(txStack)
    if (!parent) return original.apply(client, args)
    const txSpan = startTransactionSpan(client, boundary, parent, tracerName)
    txStack.push(txSpan)
    return runStatement(
      client,
      original,
      args,
      text,
      trace.setSpan(context.active(), txSpan),
      tracerName,
      (error) => {
        if (error) endTransaction(txStack, error, true)
      },
    )
  }

  const parent = parentContext(txStack)
  if (!parent) return original.apply(client, args)
  const closing =
    boundary === "commit" ||
    boundary === "release" ||
    boundary === "rollback" ||
    boundary === "rollback_to"
  return runStatement(client, original, args, text, parent, tracerName, (error) => {
    if (!closing) return
    const failed =
      error != null || boundary === "rollback" || boundary === "rollback_to"
    endTransaction(txStack, error, failed)
  })
}

/** One client span per query. Transaction boundaries parent the queries inside them. */
export function instrumentPgClient(
  client: TraceablePgClient,
  tracerName = "ctxpipe-backend",
): void {
  if (instrumentedClients.has(client)) return
  instrumentedClients.add(client)
  const original = client.query
  const txStack: Span[] = []
  client.query = ((...args: unknown[]) =>
    tracePgQuery(client, original, txStack, args, tracerName)) as PgQuery
}

/**
 * Trace queries on clients this pool checks out.
 * No span is created unless a server or job span is already active, so idle
 * pool traffic cannot become a root trace.
 */
export function instrumentPgPool(
  pool: Pool,
  options?: { tracerName?: string },
): void {
  if (instrumentedPools.has(pool)) return
  instrumentedPools.add(pool)
  const tracerName = options?.tracerName ?? "ctxpipe-backend"
  const originalConnect = pool.connect.bind(pool) as Pool["connect"]
  pool.connect = ((
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ) => {
    if (callback) {
      return originalConnect((err, client, done) => {
        if (client) {
          instrumentPgClient(client as unknown as TraceablePgClient, tracerName)
        }
        callback(err, client, done)
      })
    }
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
  const operation = (statement.match(/^([A-Za-z]+)/)?.[1] ?? "QUERY").toUpperCase()
  const label = statement.match(/\(\s*[A-Za-z0-9_]*\s*:\s*([A-Za-z_][\w]*)/)
  const collection = label?.[1]
  return {
    operation,
    ...(collection && collection.length <= 128 ? { collection } : {}),
  }
}

/** Client span for one graph query. Skipped when no server or job span is active. */
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
  if (input.serverPort !== undefined) attributes["server.port"] = input.serverPort
  const span = trace
    .getTracer(input.tracerName ?? "ctxpipe-backend")
    .startSpan(querySpanName(described.operation, described.collection), {
      kind: SpanKind.CLIENT,
      attributes,
    })
  return Promise.resolve()
    .then(run)
    .then((value) => {
      span.end()
      return value
    })
    .catch((error: unknown) => {
      recordDbFailure(span, error)
      span.end()
      throw error
    })
}
