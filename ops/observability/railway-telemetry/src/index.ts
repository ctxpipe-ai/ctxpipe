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
  railwaySkipError,
  selfHealthLog,
  unixSecondsToIso,
  type MetricWindow,
  type OtlpLogsRequest,
  type OtlpMetricsRequest,
} from "./otlp"
import { collectRedisMetrics } from "./redis"
import { LOG_LINE_CAP, RailwayClient } from "./railway"
import { includeEnvironment, OWN_SERVICE_NAME, PROJECTS } from "./targets"

async function main(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    console.error("OTEL_EXPORTER_OTLP_ENDPOINT is required")
    process.exit(1)
  }

  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const window = metricWindow(Date.now())
  const observedUnixNano = (BigInt(Date.now()) * 1_000_000n).toString()
  const metricPayloads: OtlpMetricsRequest[] = []
  const logPayloads: OtlpLogsRequest[] = []

  const redisWarning = await readRedis(observedUnixNano, metricPayloads)

  let environments = 0
  let logsCapped = false
  let environmentFailures = 0
  let railwayError = railwaySkipError(process.env.RAILWAY_API_TOKEN)
  if (!railwayError) {
    const collected = await collectRailway(process.env.RAILWAY_API_TOKEN ?? "", window, metricPayloads, logPayloads)
    environments = collected.environments
    logsCapped = collected.logsCapped
    environmentFailures = collected.failures.length
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
      windowStartIso: unixSecondsToIso(window.startUnix),
      windowEndIso: unixSecondsToIso(window.endUnix),
    }),
  ])

  if (metricPoints > 0) {
    await pushOtlp(otlpSignalUrl(endpoint, "metrics"), metrics, headers)
  }
  await pushOtlp(otlpSignalUrl(endpoint, "logs"), logs, headers)
  console.log(
    `railway-telemetry exported metric_points=${metricPoints} log_records=${logRecords} environments=${environments} logs_capped=${logsCapped} environment_failures=${environmentFailures} redis=${redisWarning ? "warn" : "ok"} railway=${railwayError ? "error" : "ok"}`,
  )
  if (railwayError) {
    console.error(railwayError)
    process.exit(1)
  }
}

async function collectRailway(
  token: string,
  window: MetricWindow,
  metricPayloads: OtlpMetricsRequest[],
  logPayloads: OtlpLogsRequest[],
): Promise<{ environments: number; logsCapped: boolean; failures: { environment: string; message: string }[] }> {
  const client = new RailwayClient(token)
  let environments = 0
  let logsCapped = false
  const failures: { environment: string; message: string }[] = []
  for (const project of PROJECTS) {
    let inventory: Awaited<ReturnType<RailwayClient["project"]>>
    try {
      inventory = await client.project(project.id)
    } catch (err: unknown) {
      const message = errorMessage(err)
      console.warn(`railway-telemetry: ${project.fallbackName}: ${message}`)
      failures.push({ environment: project.fallbackName, message })
      continue
    }
    const projectName = inventory.name || project.fallbackName
    const serviceNames = Object.fromEntries(inventory.services.map((service) => [service.id, service.name]))
    for (const environment of inventory.environments) {
      if (!includeEnvironment(project.id, environment.name)) continue
      environments += 1
      const label = `${projectName}/${environment.name}`
      const notes: string[] = []
      try {
        const series = await client.metrics(environment.id, window)
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
      } catch (err: unknown) {
        notes.push(`metrics: ${errorMessage(err)}`)
      }
      if (project.collectLogs) {
        try {
          const fetched = await client.environmentLogs(environment.id, window, LOG_LINE_CAP)
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
              window,
              skipServiceName: OWN_SERVICE_NAME,
            }),
          )
        } catch (err: unknown) {
          notes.push(`logs: ${errorMessage(err)}`)
        }
      }
      if (notes.length > 0) {
        const message = notes.join("; ")
        console.warn(`railway-telemetry: ${label}: ${message}`)
        failures.push({ environment: label, message })
      }
    }
  }
  return { environments, logsCapped, failures }
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
