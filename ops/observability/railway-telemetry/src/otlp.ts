import { deploymentEnvironment } from "./targets"

const WINDOW_MS = 5 * 60 * 1000
const SAMPLE_RATE_SECONDS = 60

/** A long Redis outage must not turn one run into an unbounded Railway query. */
export const MAX_LOOKBACK_SECONDS = 60 * 60

// Railway stamps the 60s bucket at its start, and that bucket is still open
// until the next minute. The query ends on the previous closed minute.
export const METRICS_LAG_SECONDS = 60

/** Railway's `_GB` measurements match the CLI's 1024-based MB conversion. */
const BYTES_PER_GB = 1024 ** 3
const USAGE_MEASUREMENTS = new Set(["CPU_USAGE", "MEMORY_USAGE_GB"])

export function gbToBytes(gb: number): number {
  return gb * BYTES_PER_GB
}

export type MetricWindow = {
  startUnix: number
  endUnix: number
  sampleRateSeconds: number
}

/** Fixed [end-5m, end) with end floored to the 5-minute boundary. Used when Redis is unreachable. */
export function metricWindow(nowMs: number): MetricWindow {
  const endMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS
  return {
    startUnix: Math.floor((endMs - WINDOW_MS) / 1000),
    endUnix: Math.floor(endMs / 1000),
    sampleRateSeconds: SAMPLE_RATE_SECONDS,
  }
}

export type WatermarkMarks = {
  metrics: number | null
  logs: number | null
}

/** Last closed minute at least METRICS_LAG_SECONDS before now. */
export function closedEndUnix(nowMs: number): number {
  const lagged = Math.floor(nowMs / 1000) - METRICS_LAG_SECONDS
  return Math.floor(lagged / SAMPLE_RATE_SECONDS) * SAMPLE_RATE_SECONDS
}

/**
 * Half-open [start, end). Start is the second after the watermark, so samples
 * in the window are strictly newer than the mark. A missing mark exports the
 * usual 5 minutes. A mark older than the lookback cap is raised to end-60m.
 */
export function watermarkWindow(nowMs: number, watermarkUnix: number | null): MetricWindow {
  const endUnix = closedEndUnix(nowMs)
  const earliest = endUnix - MAX_LOOKBACK_SECONDS
  const inclusiveStart = watermarkUnix === null ? endUnix - WINDOW_MS / 1000 : watermarkUnix + 1
  const startUnix = Math.min(Math.max(inclusiveStart, earliest), endUnix)
  return {
    startUnix,
    endUnix,
    sampleRateSeconds: SAMPLE_RATE_SECONDS,
  }
}

/** Redis down uses the fixed window for both signals and does not advance a mark. */
export function selectWindows(
  nowMs: number,
  watermarks: WatermarkMarks | "fallback",
): { metrics: MetricWindow; logs: MetricWindow; fallback: boolean } {
  if (watermarks === "fallback") {
    const fixed = metricWindow(nowMs)
    return { metrics: fixed, logs: fixed, fallback: true }
  }
  return {
    metrics: watermarkWindow(nowMs, watermarks.metrics),
    logs: watermarkWindow(nowMs, watermarks.logs),
    fallback: false,
  }
}

/** Unix second to persist after a clean export. Null when the range is empty or already covered. */
export function watermarkToStore(window: MetricWindow, previous: number | null): number | null {
  if (window.startUnix >= window.endUnix) return null
  const covered = window.endUnix - 1
  if (previous !== null && covered <= previous) return null
  return covered
}

/** Missing key → value null. Non-integer text → ok false, so the caller can ignore that key and replace it. */
export function parseWatermark(raw: string | null): { ok: true; value: number | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null }
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value)) return { ok: false }
  return { ok: true, value }
}

export function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

export type MetricSample = { ts: number; value: number }

export type MetricSeries = {
  measurement: string
  serviceId: string | null
  region: string | null
  values: MetricSample[]
}

export type RailwayLogLine = {
  timestamp: string
  message: string
  severity: string | null
  attributes: { key: string; value: string }[]
  serviceId: string | null
  deploymentId: string | null
}

export type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }

export type OtlpAttribute = { key: string; value: OtlpAttributeValue }

export type OtlpNumberDataPoint = {
  asDouble?: number
  asInt?: string
  timeUnixNano: string
  startTimeUnixNano?: string
  attributes?: OtlpAttribute[]
}

export type OtlpMetric = {
  name: string
  unit: string
  gauge?: { dataPoints: OtlpNumberDataPoint[] }
  sum?: {
    aggregationTemporality: 2
    isMonotonic: boolean
    dataPoints: OtlpNumberDataPoint[]
  }
}

export type OtlpMetricsRequest = {
  resourceMetrics: {
    resource: { attributes: OtlpAttribute[] }
    scopeMetrics: { scope: { name: string }; metrics: OtlpMetric[] }[]
  }[]
}

type OtlpLogRecord = {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: OtlpAttribute[]
}

export type OtlpLogsRequest = {
  resourceLogs: {
    resource: { attributes: OtlpAttribute[] }
    scopeLogs: { scope: { name: string }; logRecords: OtlpLogRecord[] }[]
  }[]
}

const SCOPE = { name: "railway-telemetry" }

// NETWORK_*_GB is a per-sample gauge, not a cumulative counter. Railway's
// Metric type only documents `value` at unix-second `ts`, and the official CLI
// summarizes NETWORK_*_GB with current/avg/max the same way it summarizes CPU
// and memory. Each sample is the traffic in that sampleRateSeconds bucket, so
// convert GB to bytes in place instead of differencing consecutive samples.
const MEASUREMENTS: Record<string, { name: string; unit: string; bytes: boolean }> = {
  CPU_USAGE: { name: "railway.cpu.usage", unit: "{cpu}", bytes: false },
  CPU_LIMIT: { name: "railway.cpu.limit", unit: "{cpu}", bytes: false },
  MEMORY_USAGE_GB: { name: "railway.memory.usage", unit: "By", bytes: true },
  MEMORY_LIMIT_GB: { name: "railway.memory.limit", unit: "By", bytes: true },
  NETWORK_RX_GB: { name: "railway.network.rx", unit: "By", bytes: true },
  NETWORK_TX_GB: { name: "railway.network.tx", unit: "By", bytes: true },
  DISK_USAGE_GB: { name: "railway.disk.usage", unit: "By", bytes: true },
}

function stringAttr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } }
}

function resourceAttributes(input: {
  serviceName: string
  deploymentEnvironment: string
  projectName?: string
  projectId?: string
  serviceId?: string
  environmentId?: string
  region?: string | null
}): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = [
    stringAttr("service.name", input.serviceName),
    stringAttr("service.namespace", "ctxpipe"),
    stringAttr("deployment.environment", input.deploymentEnvironment),
  ]
  if (input.projectName) attributes.push(stringAttr("railway.project", input.projectName))
  if (input.projectId) attributes.push(stringAttr("railway.project.id", input.projectId))
  if (input.serviceId) attributes.push(stringAttr("railway.service.id", input.serviceId))
  if (input.environmentId) attributes.push(stringAttr("railway.environment.id", input.environmentId))
  if (input.region) attributes.push(stringAttr("railway.region", input.region))
  return attributes
}

function secondsToUnixNano(seconds: number): string {
  return (BigInt(seconds) * 1_000_000_000n).toString()
}

/** Last sample at a timestamp wins. Points outside [start, end) are dropped. */
export function dedupeSamples(
  values: MetricSample[],
  window: Pick<MetricWindow, "startUnix" | "endUnix">,
): MetricSample[] {
  const byTs = new Map<number, number>()
  for (const sample of values) {
    if (!Number.isInteger(sample.ts) || !Number.isFinite(sample.value)) continue
    if (sample.ts < window.startUnix || sample.ts >= window.endUnix) continue
    byTs.set(sample.ts, sample.value)
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, value]) => ({ ts, value }))
}

const LEVEL_TOKENS = new Set(["warn", "warning", "error", "err", "fatal", "panic", "critical"])

/** Railway stores structured attribute values as JSON text (`"info"`, objects). Strings become plain text; objects stay JSON. */
export function plainLogAttributeValue(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return value
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return String(parsed)
  } catch {
    return value
  }
  return value
}

function severityFromMessage(message: string): { severityNumber: number; severityText: string } | null {
  const trimmed = message.trim()
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        const level = record.level ?? record.severity
        if (typeof level === "string") return mapSeverity(level)
      }
    } catch {
      // Not a JSON line. Fall through to a prefixed level token.
    }
  }
  const fields = trimmed.includes("\t") ? trimmed.split("\t") : trimmed.split(/\s+/).slice(0, 1)
  for (const field of fields) {
    const token = field.trim().toLowerCase().replace(/:$/, "")
    if (LEVEL_TOKENS.has(token)) return mapSeverity(token)
  }
  return null
}

/** Railway often labels collector lines info. A JSON level or a warn/error field overrides that. */
export function resolveLogSeverity(
  railwaySeverity: string | null | undefined,
  message: string,
): { severityNumber: number; severityText: string } {
  const fromRailway = mapSeverity(railwaySeverity)
  if (fromRailway.severityText !== "INFO") return fromRailway
  const fromMessage = severityFromMessage(message)
  if (!fromMessage || fromMessage.severityText === "INFO") return fromRailway
  return fromMessage
}

export function mapSeverity(severity: string | null | undefined): {
  severityNumber: number
  severityText: string
} {
  switch ((severity ?? "").trim().toLowerCase()) {
    case "trace":
      return { severityNumber: 1, severityText: "TRACE" }
    case "debug":
    case "dbg":
      return { severityNumber: 5, severityText: "DEBUG" }
    case "warn":
    case "warning":
      return { severityNumber: 13, severityText: "WARN" }
    case "error":
    case "err":
      return { severityNumber: 17, severityText: "ERROR" }
    case "fatal":
    case "critical":
    case "panic":
      return { severityNumber: 21, severityText: "FATAL" }
    default:
      return { severityNumber: 9, severityText: "INFO" }
  }
}

export function rfc3339ToUnixNano(timestamp: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    timestamp.trim(),
  )
  if (!match) return null
  const base = match[1]
  const zone = match[3]
  if (!base || !zone) return null
  const ms = Date.parse(`${base}${zone}`)
  if (Number.isNaN(ms)) return null
  const frac = (match[2] ?? "").padEnd(9, "0")
  return (BigInt(Math.floor(ms / 1000)) * 1_000_000_000n + BigInt(frac)).toString()
}

export function mapMetricsToOtlp(input: {
  projectId: string
  projectName: string
  environmentId: string
  railwayEnvironmentName: string
  serviceNames: Record<string, string>
  series: MetricSeries[]
  window: Pick<MetricWindow, "startUnix" | "endUnix">
}): OtlpMetricsRequest {
  const env = deploymentEnvironment(input.projectId, input.railwayEnvironmentName)
  type Bucket = {
    serviceId: string
    serviceName: string
    region: string | null
    gauges: Map<string, { unit: string; points: Map<number, number> }>
  }
  const buckets = new Map<string, Bucket>()
  const liveRegions = new Map<string, Set<string> | null>()

  for (const series of input.series) {
    const spec = MEASUREMENTS[series.measurement]
    if (!spec || !series.serviceId) continue
    const serviceName = input.serviceNames[series.serviceId]
    if (!serviceName) continue
    const region = series.region || null
    let live = liveRegions.get(series.serviceId)
    if (live === undefined) {
      live = usageRegions(input.series, series.serviceId, input.window)
      liveRegions.set(series.serviceId, live)
    }
    if (live && !live.has(region ?? "")) continue
    const key = `${series.serviceId}\0${region ?? ""}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        serviceId: series.serviceId,
        serviceName,
        region,
        gauges: new Map(),
      }
      buckets.set(key, bucket)
    }
    let gauge = bucket.gauges.get(spec.name)
    if (!gauge) {
      gauge = { unit: spec.unit, points: new Map() }
      bucket.gauges.set(spec.name, gauge)
    }
    for (const sample of dedupeSamples(series.values, input.window)) {
      const value = spec.bytes ? gbToBytes(sample.value) : sample.value
      gauge.points.set(sample.ts, value)
    }
  }

  const resourceMetrics = [...buckets.values()]
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName) || a.serviceId.localeCompare(b.serviceId))
    .flatMap((bucket) => {
      const metrics: OtlpMetric[] = [...bucket.gauges.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .flatMap(([name, gauge]) => {
          const dataPoints = [...gauge.points.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([ts, value]) => ({ asDouble: value, timeUnixNano: secondsToUnixNano(ts) }))
          if (dataPoints.length === 0) return []
          return [{ name, unit: gauge.unit, gauge: { dataPoints } }]
        })
      if (metrics.length === 0) return []
      return [
        {
          resource: {
            attributes: resourceAttributes({
              serviceName: bucket.serviceName,
              deploymentEnvironment: env,
              projectName: input.projectName,
              projectId: input.projectId,
              serviceId: bucket.serviceId,
              environmentId: input.environmentId,
              region: bucket.region,
            }),
          },
          scopeMetrics: [{ scope: SCOPE, metrics }],
        },
      ]
    })

  return { resourceMetrics }
}

/** Regions with in-window CPU or memory usage. Null means there is no usage signal, so other measurements are kept. */
function usageRegions(
  series: MetricSeries[],
  serviceId: string,
  window: Pick<MetricWindow, "startUnix" | "endUnix">,
): Set<string> | null {
  const regions = new Set<string>()
  for (const item of series) {
    if (item.serviceId !== serviceId || !item.measurement || !USAGE_MEASUREMENTS.has(item.measurement)) continue
    if (dedupeSamples(item.values, window).length === 0) continue
    if (!item.region) return null
    regions.add(item.region)
  }
  return regions.size > 0 ? regions : null
}

export function mapLogsToOtlp(input: {
  projectId: string
  projectName: string
  environmentId: string
  railwayEnvironmentName: string
  serviceNames: Record<string, string>
  logs: RailwayLogLine[]
  window: Pick<MetricWindow, "startUnix" | "endUnix">
  skipServiceName: string
}): OtlpLogsRequest {
  const env = deploymentEnvironment(input.projectId, input.railwayEnvironmentName)
  const startNano = BigInt(input.window.startUnix) * 1_000_000_000n
  const endNano = BigInt(input.window.endUnix) * 1_000_000_000n
  const grouped = new Map<string, { serviceName: string; records: OtlpLogRecord[] }>()

  for (const log of input.logs) {
    if (!log.serviceId) continue
    const serviceName = input.serviceNames[log.serviceId] ?? log.serviceId
    if (serviceName === input.skipServiceName) continue
    const timeUnixNano = rfc3339ToUnixNano(log.timestamp)
    if (!timeUnixNano) continue
    const nanos = BigInt(timeUnixNano)
    if (nanos < startNano || nanos >= endNano) continue
    const severity = resolveLogSeverity(log.severity, log.message)
    const attributes: OtlpAttribute[] = []
    const seen = new Set<string>()
    for (const attribute of log.attributes) {
      if (!attribute.key || seen.has(attribute.key)) continue
      seen.add(attribute.key)
      attributes.push(stringAttr(attribute.key, plainLogAttributeValue(attribute.value)))
    }
    if (log.deploymentId && !seen.has("railway.deployment.id")) {
      attributes.push(stringAttr("railway.deployment.id", log.deploymentId))
    }
    let group = grouped.get(log.serviceId)
    if (!group) {
      group = { serviceName, records: [] }
      grouped.set(log.serviceId, group)
    }
    group.records.push({
      timeUnixNano,
      severityNumber: severity.severityNumber,
      severityText: severity.severityText,
      body: { stringValue: log.message },
      attributes,
    })
  }

  const resourceLogs = [...grouped.entries()]
    .sort((a, b) => a[1].serviceName.localeCompare(b[1].serviceName))
    .map(([serviceId, group]) => ({
      resource: {
        attributes: resourceAttributes({
          serviceName: group.serviceName,
          deploymentEnvironment: env,
          projectName: input.projectName,
          projectId: input.projectId,
          serviceId,
          environmentId: input.environmentId,
        }),
      },
      scopeLogs: [
        {
          scope: SCOPE,
          logRecords: group.records.sort((a, b) => (a.timeUnixNano < b.timeUnixNano ? -1 : 1)),
        },
      ],
    }))

  return { resourceLogs }
}

export const RAILWAY_TOKEN_REQUIRED =
  "RAILWAY_API_TOKEN is required (Railway workspace token that can read the observability and product projects)"

/** Missing token skips the Railway API read. Redis export and the self log still run. */
export function railwaySkipError(token: string | undefined): string | null {
  if (token?.trim()) return null
  return RAILWAY_TOKEN_REQUIRED
}

export function selfHealthLog(input: {
  timeUnixNano: string
  metricPoints: number
  logRecords: number
  environments: number
  logsCapped: boolean
  environmentFailures: number
  redisWarning: string | null
  railwayError: string | null
  windowStartIso: string
  windowEndIso: string
}): OtlpLogsRequest {
  const redisOk = input.redisWarning === null
  const railwayOk = input.railwayError === null && input.environmentFailures === 0
  const attributes: OtlpAttribute[] = [
    { key: "railway.telemetry.metric_points", value: { intValue: String(input.metricPoints) } },
    { key: "railway.telemetry.log_records", value: { intValue: String(input.logRecords) } },
    { key: "railway.telemetry.environments", value: { intValue: String(input.environments) } },
    { key: "railway.telemetry.logs_capped", value: { boolValue: input.logsCapped } },
    { key: "railway.telemetry.environment_failures", value: { intValue: String(input.environmentFailures) } },
    { key: "railway.telemetry.redis_ok", value: { boolValue: redisOk } },
    stringAttr("railway.telemetry.window_start", input.windowStartIso),
    stringAttr("railway.telemetry.window_end", input.windowEndIso),
  ]
  if (input.redisWarning) attributes.push(stringAttr("railway.telemetry.redis_error", input.redisWarning))
  if (input.railwayError) attributes.push(stringAttr("railway.telemetry.railway_error", input.railwayError))
  const redisStatus = redisOk ? "redis=ok" : `redis_error=${input.redisWarning}`
  const railwayStatus = railwayOk ? "railway=ok" : `railway_error=${input.railwayError ?? "environment failures"}`
  const healthy = redisOk && railwayOk
  return {
    resourceLogs: [
      {
        resource: {
          attributes: resourceAttributes({
            serviceName: "railway-telemetry",
            deploymentEnvironment: "observability",
          }),
        },
        scopeLogs: [
          {
            scope: SCOPE,
            logRecords: [
              {
                timeUnixNano: input.timeUnixNano,
                severityNumber: healthy ? 9 : 13,
                severityText: healthy ? "INFO" : "WARN",
                body: {
                  stringValue: `railway-telemetry window ${input.windowStartIso}/${input.windowEndIso} metric_points=${input.metricPoints} log_records=${input.logRecords} environments=${input.environments} logs_capped=${input.logsCapped} environment_failures=${input.environmentFailures} ${redisStatus} ${railwayStatus}`,
                },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  }
}

export function countMetricPoints(payload: OtlpMetricsRequest): number {
  let count = 0
  for (const resource of payload.resourceMetrics) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        count += metric.gauge?.dataPoints.length ?? 0
        count += metric.sum?.dataPoints.length ?? 0
      }
    }
  }
  return count
}

export function countLogRecords(payload: OtlpLogsRequest): number {
  let count = 0
  for (const resource of payload.resourceLogs) {
    for (const scope of resource.scopeLogs) count += scope.logRecords.length
  }
  return count
}

export function mergeMetrics(payloads: OtlpMetricsRequest[]): OtlpMetricsRequest {
  return { resourceMetrics: payloads.flatMap((payload) => payload.resourceMetrics) }
}

export function mergeLogs(payloads: OtlpLogsRequest[]): OtlpLogsRequest {
  return { resourceLogs: payloads.flatMap((payload) => payload.resourceLogs) }
}

/** OTEL_EXPORTER_OTLP_HEADERS is a comma-separated W3C baggage list. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {}
  const headers: Record<string, string> = {}
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const encoded = trimmed.slice(eq + 1).trim()
    try {
      headers[key] = decodeURIComponent(encoded)
    } catch {
      headers[key] = encoded
    }
  }
  return headers
}

export function otlpSignalUrl(endpoint: string, signal: "metrics" | "logs"): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/${signal}`
}
