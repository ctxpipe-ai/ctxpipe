import { describe, expect, test } from "bun:test"
import { countMetricPoints } from "./otlp"
import { parseRedisInfo, redisSnapshotToOtlp } from "./redisInfo"

const INFO = [
  "# Server",
  "redis_version:7.2.4",
  "uptime_in_seconds:3600",
  "# Clients",
  "connected_clients:4",
  "blocked_clients:1",
  "# Memory",
  "used_memory:1048576",
  "used_memory_peak:2097152",
  "# Stats",
  "total_connections_received:20",
  "total_commands_processed:500",
  "keyspace_hits:30",
  "keyspace_misses:7",
  "# Keyspace",
  "db0:keys=12,expires=1,avg_ttl=100",
  "db2:keys=0,expires=0,avg_ttl=0",
  "",
].join("\r\n")

describe("parseRedisInfo", () => {
  test("reads the INFO fields the redis receiver uses", () => {
    expect(parseRedisInfo(INFO)).toEqual({
      usedMemory: 1_048_576,
      usedMemoryPeak: 2_097_152,
      connectedClients: 4,
      blockedClients: 1,
      totalCommandsProcessed: 500,
      keyspaceHits: 30,
      keyspaceMisses: 7,
      totalConnectionsReceived: 20,
      uptimeSeconds: 3600,
      databases: [
        { db: "db0", keys: 12 },
        { db: "db2", keys: 0 },
      ],
    })
  })

  test("keeps the last value and ignores comments and non-integers", () => {
    const snapshot = parseRedisInfo("used_memory:not-a-number\nused_memory:8\n# used_memory:99\n")
    expect(snapshot.usedMemory).toBe(8)
    expect(snapshot.usedMemoryPeak).toBeNull()
    expect(snapshot.databases).toEqual([])
  })
})

describe("redisSnapshotToOtlp", () => {
  test("emits one point at run time with receiver names, units, and sum kinds", () => {
    const observed = "1700000000000000000"
    const payload = redisSnapshotToOtlp(parseRedisInfo(INFO), observed)
    const resource = payload.resourceMetrics[0]
    expect(resource?.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "redis" } },
      { key: "service.namespace", value: { stringValue: "ctxpipe" } },
      { key: "deployment.environment", value: { stringValue: "observability" } },
    ])
    const metrics = resource?.scopeMetrics[0]?.metrics ?? []
    const byName = Object.fromEntries(metrics.map((metric) => [metric.name, metric]))
    expect(byName["redis.memory.used"]).toMatchObject({
      unit: "By",
      gauge: { dataPoints: [{ asInt: "1048576", timeUnixNano: observed }] },
    })
    expect(byName["redis.memory.peak"]?.unit).toBe("By")
    expect(byName["redis.commands.processed"]?.sum).toMatchObject({
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [{ asInt: "500", timeUnixNano: observed, startTimeUnixNano: String(BigInt(observed) - 3600n * 1_000_000_000n) }],
    })
    expect(byName["redis.keyspace.hits"]?.sum?.isMonotonic).toBe(true)
    expect(byName["redis.keyspace.misses"]?.sum?.isMonotonic).toBe(true)
    expect(byName["redis.connections.received"]?.sum?.isMonotonic).toBe(true)
    expect(byName["redis.connections.received"]?.unit).toBe("{connection}")
    expect(byName["redis.clients.connected"]?.sum).toMatchObject({ isMonotonic: false, aggregationTemporality: 2 })
    expect(byName["redis.clients.blocked"]?.sum?.isMonotonic).toBe(false)
    expect(byName["redis.uptime"]).toMatchObject({ unit: "s", sum: { isMonotonic: true } })
    expect(byName["redis.db.keys"]).toMatchObject({
      unit: "{key}",
      gauge: {
        dataPoints: [
          { asInt: "12", attributes: [{ key: "db", value: { stringValue: "db0" } }] },
          { asInt: "0", attributes: [{ key: "db", value: { stringValue: "db2" } }] },
        ],
      },
    })
    expect(countMetricPoints(payload)).toBe(11)
  })
})
