import type { OtlpAttribute, OtlpMetric, OtlpMetricsRequest, OtlpNumberDataPoint } from "./otlp"

export type RedisDatabase = { db: string; keys: number }

export type RedisSnapshot = {
  usedMemory: number | null
  usedMemoryPeak: number | null
  connectedClients: number | null
  blockedClients: number | null
  totalCommandsProcessed: number | null
  keyspaceHits: number | null
  keyspaceMisses: number | null
  totalConnectionsReceived: number | null
  uptimeSeconds: number | null
  databases: RedisDatabase[]
}

const INT_FIELDS = {
  used_memory: "usedMemory",
  used_memory_peak: "usedMemoryPeak",
  connected_clients: "connectedClients",
  blocked_clients: "blockedClients",
  total_commands_processed: "totalCommandsProcessed",
  keyspace_hits: "keyspaceHits",
  keyspace_misses: "keyspaceMisses",
  total_connections_received: "totalConnectionsReceived",
  uptime_in_seconds: "uptimeSeconds",
} as const

type IntField = (typeof INT_FIELDS)[keyof typeof INT_FIELDS]

export function parseRedisInfo(text: string): RedisSnapshot {
  const fields = new Map<string, string>()
  const databases = new Map<string, number>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const key = line.slice(0, colon)
    const value = line.slice(colon + 1).trim()
    fields.set(key, value)
    if (!/^db\d+$/.test(key)) continue
    const keys = /(?:^|,)keys=(\d+)(?:,|$)/.exec(value)
    if (keys?.[1]) databases.set(key, Number(keys[1]))
  }

  const snapshot: RedisSnapshot = {
    usedMemory: null,
    usedMemoryPeak: null,
    connectedClients: null,
    blockedClients: null,
    totalCommandsProcessed: null,
    keyspaceHits: null,
    keyspaceMisses: null,
    totalConnectionsReceived: null,
    uptimeSeconds: null,
    databases: [...databases.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([db, keys]) => ({ db, keys })),
  }
  for (const [infoKey, field] of Object.entries(INT_FIELDS) as [string, IntField][]) {
    snapshot[field] = integerField(fields.get(infoKey))
  }
  return snapshot
}

function integerField(raw: string | undefined): number | null {
  if (raw === undefined || !/^-?\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

function stringAttr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } }
}

function point(
  value: number,
  timeUnixNano: string,
  startTimeUnixNano?: string,
  attributes?: OtlpAttribute[],
): OtlpNumberDataPoint {
  return {
    asInt: String(value),
    timeUnixNano,
    ...(startTimeUnixNano ? { startTimeUnixNano } : {}),
    ...(attributes ? { attributes } : {}),
  }
}

function counterStart(timeUnixNano: string, uptimeSeconds: number | null): string | undefined {
  if (uptimeSeconds === null || uptimeSeconds < 0) return undefined
  const start = BigInt(timeUnixNano) - BigInt(uptimeSeconds) * 1_000_000_000n
  return start < 0n ? "0" : start.toString()
}

// HyperDX charts every Sum as a counter (greatest(Value - prev, 0)). Current
// levels (clients, uptime) are gauges so they stay visible. Commands, keyspace,
// and accepted connections are real counters and stay monotonic cumulative sums.
export function redisSnapshotToOtlp(snapshot: RedisSnapshot, timeUnixNano: string): OtlpMetricsRequest {
  const start = counterStart(timeUnixNano, snapshot.uptimeSeconds)
  const metrics: OtlpMetric[] = []
  const gauge = (name: string, unit: string, value: number | null, attributes?: OtlpAttribute[]) => {
    if (value === null) return
    metrics.push({ name, unit, gauge: { dataPoints: [point(value, timeUnixNano, undefined, attributes)] } })
  }
  const sum = (name: string, unit: string, value: number | null) => {
    if (value === null) return
    metrics.push({
      name,
      unit,
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [point(value, timeUnixNano, start)],
      },
    })
  }

  gauge("redis.memory.used", "By", snapshot.usedMemory)
  gauge("redis.memory.peak", "By", snapshot.usedMemoryPeak)
  gauge("redis.clients.connected", "{client}", snapshot.connectedClients)
  gauge("redis.clients.blocked", "{client}", snapshot.blockedClients)
  sum("redis.commands.processed", "{command}", snapshot.totalCommandsProcessed)
  sum("redis.keyspace.hits", "{hit}", snapshot.keyspaceHits)
  sum("redis.keyspace.misses", "{miss}", snapshot.keyspaceMisses)
  sum("redis.connections.received", "{connection}", snapshot.totalConnectionsReceived)
  gauge("redis.uptime", "s", snapshot.uptimeSeconds)

  if (snapshot.databases.length > 0) {
    metrics.push({
      name: "redis.db.keys",
      unit: "{key}",
      gauge: {
        dataPoints: snapshot.databases.map((database) =>
          point(database.keys, timeUnixNano, undefined, [stringAttr("db", database.db)]),
        ),
      },
    })
  }

  if (metrics.length === 0) return { resourceMetrics: [] }
  metrics.sort((a, b) => a.name.localeCompare(b.name))
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            stringAttr("service.name", "redis"),
            stringAttr("service.namespace", "ctxpipe"),
            stringAttr("deployment.environment", "observability"),
          ],
        },
        scopeMetrics: [{ scope: { name: "railway-telemetry" }, metrics }],
      },
    ],
  }
}
