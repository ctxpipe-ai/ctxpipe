import {
  countLogRecords,
  countMetricPoints,
  mergeLogs,
  mergeMetrics,
  mapLogsToOtlp,
  mapMetricsToOtlp,
  metricWindow,
  otlpSignalUrl,
  parseOtlpHeaders,
  selfHealthLog,
  unixSecondsToIso,
  type OtlpLogsRequest,
  type OtlpMetricsRequest,
} from "./otlp"
import { collectRedisMetrics } from "./redis"
import { LOG_LINE_CAP, RailwayClient } from "./railway"
import { includeEnvironment, OWN_SERVICE_NAME, PROJECTS } from "./targets"

async function main(): Promise<void> {
  const token = process.env.RAILWAY_API_TOKEN
  if (!token) {
    console.error(
      "RAILWAY_API_TOKEN is required (Railway workspace token that can read the observability and product projects)",
    )
    process.exit(1)
  }
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    console.error("OTEL_EXPORTER_OTLP_ENDPOINT is required")
    process.exit(1)
  }

  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const window = metricWindow(Date.now())
  const client = new RailwayClient(token)
  const metricPayloads: OtlpMetricsRequest[] = []
  const logPayloads: OtlpLogsRequest[] = []
  let environments = 0
  let logsCapped = false

  for (const project of PROJECTS) {
    const inventory = await client.project(project.id)
    const projectName = inventory.name || project.fallbackName
    const serviceNames = Object.fromEntries(inventory.services.map((service) => [service.id, service.name]))
    for (const environment of inventory.environments) {
      if (!includeEnvironment(project.id, environment.name)) continue
      environments += 1
      const series = await client.metrics(environment.id, window).catch((err: unknown) => {
        throw new Error(`metrics ${projectName}/${environment.name}: ${errorMessage(err)}`)
      })
      metricPayloads.push(
        mapMetricsToOtlp({
          projectId: project.id,
          projectName,
          environmentId: environment.id,
          railwayEnvironmentName: environment.name,
          serviceNames,
          series,
          window,
        }),
      )
      if (!project.collectLogs) continue
      const fetched = await client.environmentLogs(environment.id, window, LOG_LINE_CAP).catch((err: unknown) => {
        throw new Error(`logs ${projectName}/${environment.name}: ${errorMessage(err)}`)
      })
      if (fetched.capped) {
        logsCapped = true
        console.warn(
          `railway-telemetry: environment logs capped at ${LOG_LINE_CAP} for ${projectName}/${environment.name} (${environment.id})`,
        )
      }
      logPayloads.push(
        mapLogsToOtlp({
          projectId: project.id,
          projectName,
          environmentId: environment.id,
          railwayEnvironmentName: environment.name,
          serviceNames,
          logs: fetched.logs,
          window,
          skipServiceName: OWN_SERVICE_NAME,
        }),
      )
    }
  }

  const observedUnixNano = (BigInt(Date.now()) * 1_000_000n).toString()
  const redisWarning = await readRedis(observedUnixNano, metricPayloads)
  const metrics = mergeMetrics(metricPayloads)
  const metricPoints = countMetricPoints(metrics)
  const logRecords = countLogRecords(mergeLogs(logPayloads))
  const logs = mergeLogs([
    ...logPayloads,
    selfHealthLog({
      timeUnixNano: observedUnixNano,
      metricPoints,
      logRecords,
      environments,
      logsCapped,
      redisWarning,
      windowStartIso: unixSecondsToIso(window.startUnix),
      windowEndIso: unixSecondsToIso(window.endUnix),
    }),
  ])

  if (metricPoints > 0) {
    await pushOtlp(otlpSignalUrl(endpoint, "metrics"), metrics, headers)
  }
  await pushOtlp(otlpSignalUrl(endpoint, "logs"), logs, headers)
  console.log(
    `railway-telemetry ok metric_points=${metricPoints} log_records=${logRecords} environments=${environments} logs_capped=${logsCapped} redis=${redisWarning ? "warn" : "ok"}`,
  )
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
