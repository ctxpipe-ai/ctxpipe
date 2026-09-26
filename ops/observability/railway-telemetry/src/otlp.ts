import { deploymentEnvironment } from "./targets"

const BYTES_PER_GB = 1024 ** 3
const USAGE = new Set(["CPU_USAGE", "MEMORY_USAGE_GB"])

// NETWORK_*_GB is the public bytes in that 60s sample, not a cumulative counter.
const MEASUREMENTS: Record<string, { name: string; unit: string; scale: number }> = {
  CPU_USAGE: { name: "railway.cpu.usage", unit: "{cpu}", scale: 1 },
  CPU_LIMIT: { name: "railway.cpu.limit", unit: "{cpu}", scale: 1 },
  MEMORY_USAGE_GB: { name: "railway.memory.usage", unit: "By", scale: BYTES_PER_GB },
  MEMORY_LIMIT_GB: { name: "railway.memory.limit", unit: "By", scale: BYTES_PER_GB },
  NETWORK_RX_GB: { name: "railway.network.rx", unit: "By", scale: BYTES_PER_GB },
  NETWORK_TX_GB: { name: "railway.network.tx", unit: "By", scale: BYTES_PER_GB },
  DISK_USAGE_GB: { name: "railway.disk.usage", unit: "By", scale: BYTES_PER_GB },
}

export type MetricWindow = { startUnix: number; endUnix: number; sampleRateSeconds: number }

/** Last 6 closed minutes: the 5-minute cron plus one minute of slack. The current minute is still open. */
export function queryWindow(nowMs: number): MetricWindow {
  const endUnix = Math.floor(nowMs / 60_000) * 60
  return { startUnix: endUnix - 6 * 60, endUnix, sampleRateSeconds: 60 }
}

export type RailwayMetricRow = {
  measurement?: string | null
  tags?: { serviceId?: string | null; region?: string | null } | null
  values?: { ts?: unknown; value?: unknown }[] | null
}

export type RailwayLogRow = {
  timestamp?: string | null
  message?: string | null
  severity?: string | null
  attributes?: { key?: string | null; value?: string | null }[] | null
  tags?: { serviceId?: string | null; deploymentId?: string | null } | null
}

type OtlpAttribute = { key: string; value: { stringValue: string } }
type OtlpMetric = { name: string; unit: string; gauge: { dataPoints: { asDouble: number; timeUnixNano: string }[] } }
type OtlpLogRecord = {
  timeUnixNano: string
  severityNumber?: number
  severityText?: string
  body: { stringValue: string }
  attributes: OtlpAttribute[]
}

export type OtlpMetricsRequest = {
  resourceMetrics: { resource: { attributes: OtlpAttribute[] }; scopeMetrics: { scope: { name: string }; metrics: OtlpMetric[] }[] }[]
}
export type OtlpLogsRequest = {
  resourceLogs: { resource: { attributes: OtlpAttribute[] }; scopeLogs: { scope: { name: string }; logRecords: OtlpLogRecord[] }[] }[]
}

const SCOPE = { name: "railway-telemetry" }

function attr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } }
}

function resourceAttributes(
  input: { projectId: string; projectName: string; environmentId: string; railwayEnvironmentName: string },
  serviceName: string,
  serviceId: string,
  region?: string | null,
): OtlpAttribute[] {
  const attributes = [
    attr("service.name", serviceName),
    attr("service.namespace", "ctxpipe"),
    attr("deployment.environment", deploymentEnvironment(input.projectId, input.railwayEnvironmentName)),
    attr("railway.project", input.projectName),
    attr("railway.project.id", input.projectId),
    attr("railway.service.id", serviceId),
    attr("railway.environment.id", input.environmentId),
  ]
  if (region) attributes.push(attr("railway.region", region))
  return attributes
}

/** Last finite integer sample at each timestamp inside [start, end). */
function samplesInWindow(
  values: { ts?: unknown; value?: unknown }[] | null | undefined,
  window: Pick<MetricWindow, "startUnix" | "endUnix">,
): Map<number, number> {
  const byTs = new Map<number, number>()
  for (const sample of values ?? []) {
    if (typeof sample.ts !== "number" || !Number.isInteger(sample.ts)) continue
    if (typeof sample.value !== "number" || !Number.isFinite(sample.value)) continue
    if (sample.ts < window.startUnix || sample.ts >= window.endUnix) continue
    byTs.set(sample.ts, sample.value)
  }
  return byTs
}

/** Regions with in-window CPU or memory. Null keeps every region (no usage signal, or usage without a region). */
function liveRegions(
  metrics: RailwayMetricRow[],
  serviceId: string,
  window: Pick<MetricWindow, "startUnix" | "endUnix">,
): Set<string> | null {
  const regions = new Set<string>()
  for (const series of metrics) {
    if (series.tags?.serviceId !== serviceId || !series.measurement || !USAGE.has(series.measurement)) continue
    if (samplesInWindow(series.values, window).size === 0) continue
    if (!series.tags.region) return null
    regions.add(series.tags.region)
  }
  return regions.size > 0 ? regions : null
}

function secondsToUnixNano(seconds: number): string {
  return (BigInt(seconds) * 1_000_000_000n).toString()
}

export function mapMetricsToOtlp(input: {
  projectId: string
  projectName: string
  environmentId: string
  railwayEnvironmentName: string
  serviceNames: Record<string, string>
  metrics: RailwayMetricRow[]
  window: Pick<MetricWindow, "startUnix" | "endUnix">
}): OtlpMetricsRequest {
  type Bucket = {
    serviceId: string
    serviceName: string
    region: string | null
    gauges: Map<string, { unit: string; points: Map<number, number> }>
  }
  const buckets = new Map<string, Bucket>()
  const regionsByService = new Map<string, Set<string> | null>()

  for (const series of input.metrics) {
    const spec = series.measurement ? MEASUREMENTS[series.measurement] : undefined
    const serviceId = series.tags?.serviceId
    if (!spec || !serviceId) continue
    const serviceName = input.serviceNames[serviceId]
    if (!serviceName) continue
    let live = regionsByService.get(serviceId)
    if (live === undefined) {
      live = liveRegions(input.metrics, serviceId, input.window)
      regionsByService.set(serviceId, live)
    }
    const region = series.tags?.region || null
    if (live && !live.has(region ?? "")) continue
    const key = `${serviceId}\0${region ?? ""}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { serviceId, serviceName, region, gauges: new Map() }
      buckets.set(key, bucket)
    }
    let gauge = bucket.gauges.get(spec.name)
    if (!gauge) {
      gauge = { unit: spec.unit, points: new Map() }
      bucket.gauges.set(spec.name, gauge)
    }
    for (const [ts, value] of samplesInWindow(series.values, input.window)) {
      gauge.points.set(ts, value * spec.scale)
    }
  }

  const resourceMetrics = [...buckets.values()]
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName) || (a.region ?? "").localeCompare(b.region ?? ""))
    .flatMap((bucket) => {
      const metrics = [...bucket.gauges.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .flatMap(([name, gauge]) => {
          const dataPoints = [...gauge.points.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([ts, value]) => ({ asDouble: value, timeUnixNano: secondsToUnixNano(ts) }))
          return dataPoints.length === 0 ? [] : [{ name, unit: gauge.unit, gauge: { dataPoints } }]
        })
      if (metrics.length === 0) return []
      return [{
        resource: { attributes: resourceAttributes(input, bucket.serviceName, bucket.serviceId, bucket.region) },
        scopeMetrics: [{ scope: SCOPE, metrics }],
      }]
    })

  return { resourceMetrics }
}

function railwaySeverity(severity: string | null | undefined): { severityNumber: number; severityText: string } | undefined {
  switch ((severity ?? "").trim().toLowerCase()) {
    case "trace":
      return { severityNumber: 1, severityText: "TRACE" }
    case "debug":
    case "dbg":
      return { severityNumber: 5, severityText: "DEBUG" }
    case "warn":
    case "warning":
    case "notice":
      return { severityNumber: 13, severityText: "WARN" }
    case "error":
    case "err":
      return { severityNumber: 17, severityText: "ERROR" }
    case "fatal":
    case "critical":
    case "panic":
      return { severityNumber: 21, severityText: "FATAL" }
    default:
      return undefined
  }
}

/** Millisecond precision. Invalid timestamps are dropped. */
function timestampUnixNano(timestamp: string): string | null {
  const ms = Date.parse(timestamp)
  if (Number.isNaN(ms)) return null
  return (BigInt(ms) * 1_000_000n).toString()
}

export function mapLogsToOtlp(input: {
  projectId: string
  projectName: string
  environmentId: string
  railwayEnvironmentName: string
  serviceNames: Record<string, string>
  logs: RailwayLogRow[]
  window: Pick<MetricWindow, "startUnix" | "endUnix">
}): OtlpLogsRequest {
  const startNano = BigInt(input.window.startUnix) * 1_000_000_000n
  const endNano = BigInt(input.window.endUnix) * 1_000_000_000n
  const grouped = new Map<string, { serviceName: string; records: OtlpLogRecord[] }>()

  for (const log of input.logs) {
    const serviceId = log.tags?.serviceId
    if (!serviceId || typeof log.message !== "string" || typeof log.timestamp !== "string") continue
    const timeUnixNano = timestampUnixNano(log.timestamp)
    if (!timeUnixNano) continue
    const nanos = BigInt(timeUnixNano)
    if (nanos < startNano || nanos >= endNano) continue
    const attributes: OtlpAttribute[] = []
    const seen = new Set<string>()
    for (const attribute of log.attributes ?? []) {
      if (!attribute.key || typeof attribute.value !== "string" || seen.has(attribute.key)) continue
      seen.add(attribute.key)
      attributes.push(attr(attribute.key, attribute.value))
    }
    const deploymentId = log.tags?.deploymentId
    if (deploymentId && !seen.has("railway.deployment.id")) {
      attributes.push(attr("railway.deployment.id", deploymentId))
    }
    let group = grouped.get(serviceId)
    if (!group) {
      group = { serviceName: input.serviceNames[serviceId] ?? serviceId, records: [] }
      grouped.set(serviceId, group)
    }
    // info and unrecognized severities stay unset so the collector transform can infer them.
    const record: OtlpLogRecord = { timeUnixNano, body: { stringValue: log.message }, attributes }
    const severity = railwaySeverity(log.severity)
    if (severity) {
      record.severityNumber = severity.severityNumber
      record.severityText = severity.severityText
    }
    group.records.push(record)
  }

  const resourceLogs = [...grouped.entries()]
    .sort((a, b) => a[1].serviceName.localeCompare(b[1].serviceName))
    .map(([serviceId, group]) => ({
      resource: { attributes: resourceAttributes(input, group.serviceName, serviceId) },
      scopeLogs: [{ scope: SCOPE, logRecords: group.records.sort((a, b) => (a.timeUnixNano < b.timeUnixNano ? -1 : 1)) }],
    }))

  return { resourceLogs }
}
