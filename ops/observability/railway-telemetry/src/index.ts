import {
  mapLogsToOtlp,
  mapMetricsToOtlp,
  queryWindow,
  type OtlpLogsRequest,
  type OtlpMetricsRequest,
} from "./otlp"
import { LOG_LINE_CAP, RailwayClient } from "./railway"
import { includeEnvironment, OBSERVABILITY_PROJECT_ID, PROJECT_IDS } from "./targets"

async function main(): Promise<void> {
  const endpoint = requiredEnv("OTEL_EXPORTER_OTLP_ENDPOINT")
  const headers = otlpHeaders(requiredEnv("OTEL_EXPORTER_OTLP_HEADERS"))
  const client = new RailwayClient(requiredEnv("RAILWAY_API_TOKEN"))
  const window = queryWindow(Date.now())
  const metricPayloads: OtlpMetricsRequest[] = []
  const logPayloads: OtlpLogsRequest[] = []
  const failures: string[] = []
  let environments = 0

  for (const projectId of PROJECT_IDS) {
    let project: Awaited<ReturnType<RailwayClient["project"]>>
    try {
      project = await client.project(projectId)
    } catch (err: unknown) {
      failures.push(`${projectId}: ${errorMessage(err)}`)
      continue
    }
    const serviceNames = Object.fromEntries(project.services.map((service) => [service.id, service.name]))
    for (const environment of project.environments) {
      if (!includeEnvironment(projectId, environment.name)) continue
      environments += 1
      const label = `${project.name}/${environment.name}`
      const mapped = {
        projectId,
        projectName: project.name,
        environmentId: environment.id,
        railwayEnvironmentName: environment.name,
        serviceNames,
        window,
      }
      try {
        metricPayloads.push(mapMetricsToOtlp({ ...mapped, metrics: await client.metrics(environment.id, window) }))
      } catch (err: unknown) {
        failures.push(`${label} metrics: ${errorMessage(err)}`)
      }
      if (projectId !== OBSERVABILITY_PROJECT_ID) continue
      try {
        const fetched = await client.environmentLogs(environment.id, window)
        if (fetched.capped) failures.push(`${label} logs capped at ${LOG_LINE_CAP}`)
        logPayloads.push(mapLogsToOtlp({ ...mapped, logs: fetched.logs }))
      } catch (err: unknown) {
        failures.push(`${label} logs: ${errorMessage(err)}`)
      }
    }
  }

  const metrics = { resourceMetrics: metricPayloads.flatMap((payload) => payload.resourceMetrics) }
  const logs = { resourceLogs: logPayloads.flatMap((payload) => payload.resourceLogs) }
  const metricPoints = countPoints(metrics)
  const logRecords = countRecords(logs)
  if (metricPoints > 0) await postOtlp(endpoint, "metrics", metrics, headers)
  if (logRecords > 0) await postOtlp(endpoint, "logs", logs, headers)
  const start = new Date(window.startUnix * 1000).toISOString()
  const end = new Date(window.endUnix * 1000).toISOString()
  console.log(
    `railway-telemetry metric_points=${metricPoints} log_records=${logRecords} environments=${environments} failures=${failures.length} window=${start}/${end}`,
  )
  if (failures.length > 0) throw new Error(failures.join("; "))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function otlpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    if (!key) continue
    const encoded = part.slice(eq + 1).trim()
    try {
      headers[key] = decodeURIComponent(encoded)
    } catch {
      headers[key] = encoded
    }
  }
  if (Object.keys(headers).length === 0) throw new Error("OTEL_EXPORTER_OTLP_HEADERS is required")
  return headers
}

async function postOtlp(
  endpoint: string,
  signal: "metrics" | "logs",
  body: unknown,
  headers: Record<string, string>,
): Promise<void> {
  const response = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/${signal}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OTLP POST /v1/${signal} failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }
}

function countPoints(payload: OtlpMetricsRequest): number {
  let count = 0
  for (const resource of payload.resourceMetrics) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) count += metric.gauge.dataPoints.length
    }
  }
  return count
}

function countRecords(payload: OtlpLogsRequest): number {
  let count = 0
  for (const resource of payload.resourceLogs) {
    for (const scope of resource.scopeLogs) count += scope.logRecords.length
  }
  return count
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(errorMessage(err))
    process.exit(1)
  })
}
