import type { MetricWindow, RailwayLogRow, RailwayMetricRow } from "./otlp"

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

type NamedNode = { id: string; name: string }

export type ProjectInventory = {
  name: string
  environments: NamedNode[]
  services: NamedNode[]
}

export class RailwayClient {
  constructor(private readonly token: string) {}

  async project(id: string): Promise<ProjectInventory> {
    const data = await this.query<{
      project?: {
        name?: string | null
        environments?: { edges?: { node?: NamedNode | null }[] | null } | null
        services?: { edges?: { node?: NamedNode | null }[] | null } | null
      } | null
    }>(
      `query Project($id: String!) {
        project(id: $id) {
          name
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        }
      }`,
      { id },
    )
    const project = data.project
    if (!project?.name) throw new Error(`Railway project ${id} was not found`)
    return {
      name: project.name,
      environments: namedNodes(project.environments?.edges),
      services: namedNodes(project.services?.edges),
    }
  }

  async metrics(environmentId: string, window: MetricWindow): Promise<RailwayMetricRow[]> {
    const data = await this.query<{ metrics?: RailwayMetricRow[] | null }>(
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
        // One extra sample: startDate can be exclusive, and the mapper keeps [start, end).
        startDate: new Date((window.startUnix - window.sampleRateSeconds) * 1000).toISOString(),
        endDate: new Date(window.endUnix * 1000).toISOString(),
        sampleRateSeconds: window.sampleRateSeconds,
        groupBy: ["SERVICE_ID", "REGION"],
        measurements: MEASUREMENTS,
      },
    )
    return data.metrics ?? []
  }

  async environmentLogs(
    environmentId: string,
    window: MetricWindow,
    limit = LOG_LINE_CAP,
  ): Promise<{ logs: RailwayLogRow[]; capped: boolean }> {
    const data = await this.query<{ environmentLogs?: RailwayLogRow[] | null }>(
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
    const logs = data.environmentLogs ?? []
    return { logs, capped: logs.length >= limit }
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
    let body: { data?: T; errors?: { message?: string }[] }
    try {
      body = (await response.json()) as { data?: T; errors?: { message?: string }[] }
    } catch {
      throw new Error(`Railway GraphQL HTTP ${response.status}: response was not JSON`)
    }
    if (!response.ok || body.errors?.length || body.data === undefined) {
      const detail = body.errors?.flatMap((error) => (error.message ? [error.message] : [])).join("; ")
      throw new Error(detail || `Railway GraphQL HTTP ${response.status}`)
    }
    return body.data
  }
}

function namedNodes(edges: { node?: { id?: string | null; name?: string | null } | null }[] | null | undefined): NamedNode[] {
  const nodes: NamedNode[] = []
  for (const edge of edges ?? []) {
    const id = edge?.node?.id
    const name = edge?.node?.name
    if (id && name) nodes.push({ id, name })
  }
  return nodes
}
