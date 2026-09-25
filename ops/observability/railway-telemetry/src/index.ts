import {
  countLogRecords,
  countMetricPoints,
  mergeLogs,
  mergeMetrics,
  mapLogsToOtlp,
  mapMetricsToOtlp,
  otlpSignalUrl,
  parseOtlpHeaders,
  railwaySkipError,
  selectWindows,
  selfHealthLog,
  unixSecondsToIso,
  watermarkToStore,
  type MetricWindow,
  type OtlpLogsRequest,
  type OtlpMetricsRequest,
} from "./otlp"
import {
  collectRedisMetrics,
  LOGS_WATERMARK_KEY,
  METRICS_WATERMARK_KEY,
  readWatermarks,
  writeWatermark,
} from "./redis"
import { LOG_LINE_CAP, RailwayClient } from "./railway"
import { includeEnvironment, OWN_SERVICE_NAME, PROJECTS } from "./targets"

async function main(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    console.error("OTEL_EXPORTER_OTLP_ENDPOINT is required")
    process.exit(1)
  }

  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const nowMs = Date.now()
  const observedUnixNano = (BigInt(nowMs) * 1_000_000n).toString()
  const redisUrl = process.env.REDIS_URL
  const windows = await loadWatermarks(redisUrl, nowMs)
  const metricPayloads: OtlpMetricsRequest[] = []
  const logPayloads: OtlpLogsRequest[] = []

  const infoWarning = await readRedis(observedUnixNano, metricPayloads)
  const redisWarning = joinWarnings(infoWarning, windows.warning)

  let environments = 0
  let logsCapped = false
  let environmentFailures = 0
  let metricsFailures = 0
  let logsFailures = 0
  let railwayError = railwaySkipError(process.env.RAILWAY_API_TOKEN)
  const skippedRailway = railwayError !== null
  if (!railwayError) {
    const collected = await collectRailway(
      process.env.RAILWAY_API_TOKEN ?? "",
      windows.metrics,
      windows.logs,
      metricPayloads,
      logPayloads,
    )
    environments = collected.environments
    logsCapped = collected.logsCapped
    environmentFailures = collected.failures.length
    metricsFailures = collected.metricsFailures
    logsFailures = collected.logsFailures
    if (environmentFailures > 0) railwayError = formatEnvFailures(collected.failures)
  }

  const metrics = mergeMetrics(metricPayloads)
  const metricPoints = countMetricPoints(metrics)
  const railwayLogs = mergeLogs(logPayloads)
  const logRecords = countLogRecords(railwayLogs)
  const logs = mergeLogs([
    railwayLogs,
    selfHealthLog({
      timeUnixNano: observedUnixNano,
      metricPoints,
      logRecords,
      environments,
      logsCapped,
      environmentFailures,
      redisWarning,
      railwayError,
      windowStartIso: unixSecondsToIso(Math.min(windows.metrics.startUnix, windows.logs.startUnix)),
      windowEndIso: unixSecondsToIso(Math.max(windows.metrics.endUnix, windows.logs.endUnix)),
    }),
  ])

  if (metricPoints > 0) {
    await pushOtlp(otlpSignalUrl(endpoint, "metrics"), metrics, headers)
  }
  // A failed signal keeps its mark so the next run retries that range. A Redis
  // fallback does not write, or it would skip the gap the fixed window missed.
  if (!skippedRailway && metricsFailures === 0) {
    await storeWatermark(redisUrl, windows, METRICS_WATERMARK_KEY, windows.metrics, windows.metricsMark)
  }
  await pushOtlp(otlpSignalUrl(endpoint, "logs"), logs, headers)
  if (!skippedRailway && logsFailures === 0) {
    await storeWatermark(redisUrl, windows, LOGS_WATERMARK_KEY, windows.logs, windows.logsMark)
  }
  console.log(
    `railway-telemetry exported metric_points=${metricPoints} log_records=${logRecords} environments=${environments} logs_capped=${logsCapped} environment_failures=${environmentFailures} redis=${redisWarning ? "warn" : "ok"} railway=${railwayError ? "error" : "ok"} watermark=${windows.fallback ? "fallback" : "redis"} metrics_window=${unixSecondsToIso(windows.metrics.startUnix)}/${unixSecondsToIso(windows.metrics.endUnix)} logs_window=${unixSecondsToIso(windows.logs.startUnix)}/${unixSecondsToIso(windows.logs.endUnix)}`,
  )
  if (railwayError) {
    console.error(railwayError)
    process.exit(1)
  }
}

async function collectRailway(
  token: string,
  metricsWindow: MetricWindow,
  logsWindow: MetricWindow,
  metricPayloads: OtlpMetricsRequest[],
  logPayloads: OtlpLogsRequest[],
): Promise<{
  environments: number
  logsCapped: boolean
  failures: { environment: string; message: string }[]
  metricsFailures: number
  logsFailures: number
}> {
  const client = new RailwayClient(token)
  let environments = 0
  let logsCapped = false
  let metricsFailures = 0
  let logsFailures = 0
  const failures: { environment: string; message: string }[] = []
  for (const project of PROJECTS) {
    let inventory: Awaited<ReturnType<RailwayClient["project"]>>
    try {
      inventory = await client.project(project.id)
    } catch (err: unknown) {
      const message = errorMessage(err)
      console.warn(`railway-telemetry: ${project.fallbackName}: ${message}`)
      failures.push({ environment: project.fallbackName, message })
      metricsFailures += 1
      if (project.collectLogs) logsFailures += 1
      continue
    }
    const projectName = inventory.name || project.fallbackName
    const serviceNames = Object.fromEntries(inventory.services.map((service) => [service.id, service.name]))
    for (const environment of inventory.environments) {
      if (!includeEnvironment(project.id, environment.name)) continue
      environments += 1
      const label = `${projectName}/${environment.name}`
      const notes: string[] = []
      if (metricsWindow.startUnix < metricsWindow.endUnix) {
        try {
          const series = await client.metrics(environment.id, metricsWindow)
          metricPayloads.push(
            mapMetricsToOtlp({
              projectId: project.id,
              projectName,
              environmentId: environment.id,
              railwayEnvironmentName: environment.name,
              serviceNames,
              series,
              window: metricsWindow,
            }),
          )
        } catch (err: unknown) {
          notes.push(`metrics: ${errorMessage(err)}`)
          metricsFailures += 1
        }
      }
      if (project.collectLogs && logsWindow.startUnix < logsWindow.endUnix) {
        try {
          const fetched = await client.environmentLogs(environment.id, logsWindow, LOG_LINE_CAP)
          if (fetched.capped) {
            logsCapped = true
            console.warn(`railway-telemetry: environment logs capped at ${LOG_LINE_CAP} for ${label} (${environment.id})`)
          }
          logPayloads.push(
            mapLogsToOtlp({
              projectId: project.id,
              projectName,
              environmentId: environment.id,
              railwayEnvironmentName: environment.name,
              serviceNames,
              logs: fetched.logs,
              window: logsWindow,
              skipServiceName: OWN_SERVICE_NAME,
            }),
          )
        } catch (err: unknown) {
          notes.push(`logs: ${errorMessage(err)}`)
          logsFailures += 1
        }
      }
      if (notes.length > 0) {
        const message = notes.join("; ")
        console.warn(`railway-telemetry: ${label}: ${message}`)
        failures.push({ environment: label, message })
      }
    }
  }
  return { environments, logsCapped, failures, metricsFailures, logsFailures }
}

type WatermarkLoad = {
  metrics: MetricWindow
  logs: MetricWindow
  fallback: boolean
  warning: string | null
  metricsMark: number | null
  logsMark: number | null
}

async function loadWatermarks(redisUrl: string | undefined, nowMs: number): Promise<WatermarkLoad> {
  if (!redisUrl) {
    const selected = selectWindows(nowMs, "fallback")
    return { ...selected, warning: null, metricsMark: null, logsMark: null }
  }
  try {
    const stored = await readWatermarks(redisUrl)
    if (stored.invalidKeys.length > 0) {
      console.warn(`railway-telemetry: ignoring invalid redis watermark: ${stored.invalidKeys.join(", ")}`)
    }
    const selected = selectWindows(nowMs, stored)
    return {
      ...selected,
      warning: null,
      metricsMark: stored.metrics,
      logsMark: stored.logs,
    }
  } catch (err: unknown) {
    const message = `redis watermark unavailable, using fixed window: ${errorMessage(err)}`
    console.warn(`railway-telemetry: ${message}`)
    const selected = selectWindows(nowMs, "fallback")
    return { ...selected, warning: message, metricsMark: null, logsMark: null }
  }
}

async function storeWatermark(
  redisUrl: string | undefined,
  loaded: WatermarkLoad,
  key: string,
  window: MetricWindow,
  previous: number | null,
): Promise<void> {
  if (!redisUrl || loaded.fallback) return
  const next = watermarkToStore(window, previous)
  if (next === null) return
  try {
    await writeWatermark(redisUrl, key, next)
  } catch (err: unknown) {
    console.warn(`railway-telemetry: redis watermark write failed: ${errorMessage(err)}`)
  }
}

function joinWarnings(left: string | null, right: string | null): string | null {
  const parts = [left, right].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join("; ") : null
}

function formatEnvFailures(failures: { environment: string; message: string }[]): string {
  const shown = failures
    .slice(0, 3)
    .map((failure) => `${failure.environment}: ${failure.message}`)
    .join("; ")
  const extra = failures.length > 3 ? `; +${failures.length - 3} more` : ""
  return `${failures.length} environment(s) failed: ${shown}${extra}`
}

async function readRedis(timeUnixNano: string, metricPayloads: OtlpMetricsRequest[]): Promise<string | null> {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    console.warn("railway-telemetry: REDIS_URL is unset")
    return "REDIS_URL is unset"
  }
  try {
    metricPayloads.push(await collectRedisMetrics(redisUrl, timeUnixNano))
    return null
  } catch (err: unknown) {
    const message = `redis INFO failed: ${errorMessage(err)}`
    console.warn(`railway-telemetry: ${message}`)
    return message
  }
}

async function pushOtlp(url: string, body: unknown, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OTLP POST ${new URL(url).pathname} failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(errorMessage(err))
    process.exit(1)
  })
}
