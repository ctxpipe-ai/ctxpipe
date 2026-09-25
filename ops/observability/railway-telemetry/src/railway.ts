import type { MetricSeries, MetricWindow, RailwayLogLine } from "./otlp"

const ENDPOINT = "https://backboard.railway.com/graphql/v2"

const MEASUREMENTS = [
  "CPU_USAGE",
  "CPU_LIMIT",
  "MEMORY_USAGE_GB",
  "MEMORY_LIMIT_GB",
  "NETWORK_RX_GB",
  "NETWORK_TX_GB",
  "DISK_USAGE_GB",
] as const

export const LOG_LINE_CAP = 5000

/** Region is a MetricTag, so each service/region pair is its own series. */
export const METRIC_GROUP_BY = ["SERVICE_ID", "REGION"] as const

export type ProjectInventory = {
  id: string
  name: string
  environments: { id: string; name: string }[]
  services: { id: string; name: string }[]
}

type GraphQLError = { message?: string }

type Connection<T> = {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  edges?: ({ node?: T | null } | null)[] | null
}

export class RailwayClient {
  constructor(
    private readonly token: string,
    private readonly endpoint = ENDPOINT,
  ) {}

  async project(id: string): Promise<ProjectInventory> {
    let name = ""
    const environments = await this.pages<{ id: string; name: string }>(id, "environments", (project) => {
      if (project.name) name = project.name
      return project.environments
    })
    const services = await this.pages<{ id: string; name: string }>(id, "services", (project) => {
      if (project.name) name = project.name
      return project.services
    })
    return { id, name, environments, services }
  }

  async metrics(environmentId: string, window: MetricWindow): Promise<MetricSeries[]> {
    const data = await this.query<{
      metrics: {
        measurement?: string | null
        tags?: { serviceId?: string | null; region?: string | null } | null
        values?: { ts?: unknown; value?: unknown }[] | null
      }[] | null
    }>(
      `query Metrics(
        $environmentId: String!
        $startDate: DateTime!
        $endDate: DateTime!
        $sampleRateSeconds: Int!
        $groupBy: [MetricTag!]
        $measurements: [MetricMeasurement!]!
      ) {
        metrics(
          environmentId: $environmentId
          startDate: $startDate
          endDate: $endDate
          sampleRateSeconds: $sampleRateSeconds
          groupBy: $groupBy
          measurements: $measurements
        ) {
          measurement
          tags { serviceId region }
          values { ts value }
        }
      }`,
      {
        environmentId,
        // Ask for one extra sample. The mapper keeps [start, end) so a point on
        // the boundary is not dropped when Railway treats startDate as exclusive.
        startDate: new Date((window.startUnix - window.sampleRateSeconds) * 1000).toISOString(),
        endDate: new Date(window.endUnix * 1000).toISOString(),
        sampleRateSeconds: window.sampleRateSeconds,
        groupBy: METRIC_GROUP_BY,
        measurements: MEASUREMENTS,
      },
    )
    return (data.metrics ?? []).map((series) => ({
      measurement: series.measurement ?? "",
      serviceId: series.tags?.serviceId || null,
      region: series.tags?.region || null,
      values: (series.values ?? []).flatMap((sample) => {
        const ts = unixSeconds(sample.ts)
        if (ts === null || typeof sample.value !== "number" || !Number.isFinite(sample.value)) return []
        return [{ ts, value: sample.value }]
      }),
    }))
  }

  // environmentLogs is anchored: beforeDate is the oldest instant and anchorDate
  // is the newest. Build logs stay out unless a snapshot filter is set. This
  // read does not start the service. deploymentLogs would need one deployment
  // id per service.
  async environmentLogs(
    environmentId: string,
    window: MetricWindow,
    limit = LOG_LINE_CAP,
  ): Promise<{ logs: RailwayLogLine[]; capped: boolean }> {
    const data = await this.query<{
      environmentLogs: {
        timestamp?: string | null
        message?: string | null
        severity?: string | null
        attributes?: { key?: string | null; value?: string | null }[] | null
        tags?: { serviceId?: string | null; deploymentId?: string | null } | null
      }[] | null
    }>(
      `query EnvironmentLogs(
        $environmentId: String!
        $anchorDate: String!
        $beforeDate: String!
        $beforeLimit: Int!
      ) {
        environmentLogs(
          environmentId: $environmentId
          anchorDate: $anchorDate
          beforeDate: $beforeDate
          beforeLimit: $beforeLimit
        ) {
          timestamp
          message
          severity
          attributes { key value }
          tags { serviceId deploymentId }
        }
      }`,
      {
        environmentId,
        anchorDate: new Date(window.endUnix * 1000).toISOString(),
        beforeDate: new Date(window.startUnix * 1000).toISOString(),
        beforeLimit: limit,
      },
    )
    const logs = (data.environmentLogs ?? []).map((log) => ({
      timestamp: log.timestamp ?? "",
      message: log.message ?? "",
      severity: log.severity ?? null,
      attributes: (log.attributes ?? []).flatMap((attribute) =>
        attribute.key ? [{ key: attribute.key, value: attribute.value ?? "" }] : [],
      ),
      serviceId: log.tags?.serviceId || null,
      deploymentId: log.tags?.deploymentId || null,
    }))
    return { logs, capped: logs.length >= limit }
  }

  private async pages<T extends { id: string; name: string }>(
    projectId: string,
    field: "environments" | "services",
    select: (project: {
      name?: string | null
      environments?: Connection<T> | null
      services?: Connection<T> | null
    }) => Connection<T> | null | undefined,
  ): Promise<T[]> {
    const out: T[] = []
    let after: string | null = null
    for (let page = 0; page < 50; page++) {
      const data = await this.query<{
        project: {
          name?: string | null
          environments?: Connection<T> | null
          services?: Connection<T> | null
        } | null
      }>(
        `query Project($id: String!, $after: String) {
          project(id: $id) {
            id
            name
            ${field}(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { id name } }
            }
          }
        }`,
        { id: projectId, after },
      )
      if (!data.project) throw new Error(`Railway project ${projectId} was not found`)
      const connection = select(data.project)
      for (const edge of connection?.edges ?? []) {
        if (edge?.node?.id && edge.node.name) out.push(edge.node)
      }
      if (!connection?.pageInfo?.hasNextPage) return out
      const next = connection.pageInfo.endCursor ?? null
      if (!next || next === after) throw new Error(`Railway ${field} pagination cursor did not advance`)
      after = next
    }
    throw new Error(`Railway ${field} pagination exceeded 50 pages`)
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let body: { data?: T; errors?: GraphQLError[] }
    try {
      body = JSON.parse(text) as { data?: T; errors?: GraphQLError[] }
    } catch {
      throw new Error(`Railway GraphQL HTTP ${response.status}: response was not JSON`)
    }
    if (!response.ok) {
      const message = body.errors?.map((error) => error.message).filter(Boolean).join("; ")
      throw new Error(`Railway GraphQL HTTP ${response.status}: ${message || text.slice(0, 300)}`)
    }
    if (body.errors?.length) {
      throw new Error(
        `Railway GraphQL error: ${body.errors.map((error) => error.message ?? "unknown error").join("; ")}`,
      )
    }
    if (body.data === undefined) throw new Error("Railway GraphQL returned no data")
    return body.data
  }
}

function unixSeconds(ts: unknown): number | null {
  if (typeof ts === "number" && Number.isInteger(ts)) return ts
  if (typeof ts === "string" && /^[0-9]+$/.test(ts)) {
    const parsed = Number(ts)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return null
}
