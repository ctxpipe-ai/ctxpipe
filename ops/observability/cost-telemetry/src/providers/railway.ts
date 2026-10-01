import { getJson, isRecord, requiredEnv } from "../http"
import { railwayBackupUsdPerGbMinute, railwayCpuUsdPerVcpuMinute, railwayEgressUsdPerGb, railwayMemoryUsdPerGbMinute, railwayVolumeUsdPerGbMinute } from "../rates"
import { sumRows, type CostRow } from "../rows"

type Inventory = { name: string; environments: Map<string, string>; services: Map<string, string> }

export async function rows(days: string[]): Promise<CostRow[]> {
  const token = requiredEnv("RAILWAY_API_TOKEN")
  // ctxpipe product project; same id as railway-telemetry PRODUCT_PROJECT_ID
  const productProjectId = "119e3cc3-ef73-43aa-895a-8c8ccff73ff8"
  const projectIds = [requiredEnv("RAILWAY_PROJECT_ID"), productProjectId]
  const inventories = await Promise.all(projectIds.map((id) => fetchProject(id, token)))
  const batches: CostRow[][] = []
  for (const [index, projectId] of projectIds.entries()) {
    const inventory = inventories[index]
    if (!inventory) throw new Error(`Railway project ${projectId} was not found`)
    for (const day of days) {
      batches.push(await fetchUsage(day, projectId, inventory, token))
    }
  }
  return sumRows(batches.flat())
}

async function fetchProject(id: string, token: string): Promise<Inventory> {
  const data = await railwayData(
    `query Project($id: String!) {
      project(id: $id) {
        name
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      }
    }`,
    { id },
    token,
    "Railway project",
  )
  if (!isRecord(data.project)) throw new Error(`Railway project ${id} was not found`)
  const name = data.project.name
  if (typeof name !== "string" || !name) throw new Error(`Railway project ${id} was not found`)
  return {
    name,
    environments: namedNodes(data.project.environments),
    services: namedNodes(data.project.services),
  }
}

async function fetchUsage(day: string, projectId: string, inventory: Inventory, token: string): Promise<CostRow[]> {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(start)) throw new Error(`invalid day ${day}`)
  const data = await fetchUsageData(projectId, start, token)
  if (!Array.isArray(data.usage)) throw new Error("Railway usage response was missing usage")
  const skus: Record<string, { sku: string; unit: string; rate: number }> = {
    CPU_USAGE: { sku: "cpu", unit: "vcpu_min", rate: railwayCpuUsdPerVcpuMinute },
    MEMORY_USAGE_GB: { sku: "memory", unit: "gb_min", rate: railwayMemoryUsdPerGbMinute },
    NETWORK_TX_GB: { sku: "egress", unit: "GB", rate: railwayEgressUsdPerGb },
    DISK_USAGE_GB: { sku: "volume", unit: "gb_min", rate: railwayVolumeUsdPerGbMinute },
    BACKUP_USAGE_GB: { sku: "backup", unit: "gb_min", rate: railwayBackupUsdPerGbMinute },
  }
  const mapped: CostRow[] = []
  for (const item of data.usage) {
    if (!isRecord(item)) continue
    if (typeof item.measurement !== "string") continue
    if (typeof item.value !== "number" || !Number.isFinite(item.value) || !(item.value > 0)) continue
    if (!isRecord(item.tags)) continue
    const sku = skus[item.measurement]
    if (!sku) continue
    const environmentId = typeof item.tags.environmentId === "string" && item.tags.environmentId ? item.tags.environmentId : "unknown"
    const serviceId = typeof item.tags.serviceId === "string" && item.tags.serviceId ? item.tags.serviceId : "unknown"
    mapped.push({
      day,
      provider: "railway",
      sku: sku.sku,
      scope: `${inventory.name}/${inventory.environments.get(environmentId) ?? environmentId}/${inventory.services.get(serviceId) ?? serviceId}`,
      usage: item.value,
      unit: sku.unit,
      costUsd: item.value * sku.rate,
      source: "estimated",
    })
  }
  return mapped
}

async function fetchUsageData(projectId: string, start: number, token: string): Promise<Record<string, unknown>> {
  const query = `query Usage(
      $projectId: String
      $startDate: DateTime
      $endDate: DateTime
      $groupBy: [MetricTag!]
      $measurements: [MetricMeasurement!]!
      $includeDeleted: Boolean
    ) {
      usage(
        projectId: $projectId
        startDate: $startDate
        endDate: $endDate
        groupBy: $groupBy
        measurements: $measurements
        includeDeleted: $includeDeleted
      ) {
        measurement
        tags { projectId environmentId serviceId volumeId }
        value
      }
    }`
  const variables = {
    projectId,
    startDate: new Date(start).toISOString(),
    endDate: new Date(start + 86_400_000).toISOString(),
    groupBy: ["PROJECT_ID", "ENVIRONMENT_ID", "SERVICE_ID", "VOLUME_ID"],
    measurements: ["CPU_USAGE", "MEMORY_USAGE_GB", "NETWORK_TX_GB", "DISK_USAGE_GB", "BACKUP_USAGE_GB"],
    includeDeleted: true,
  }
  try {
    return await railwayData(query, variables, token, "Railway usage")
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (!message.includes("Too many usage queries are running at once")) throw error
    const parsed = Number(/retry in (\d+) seconds/i.exec(message)?.[1])
    const seconds = Number.isFinite(parsed) ? parsed : 120
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(Math.max(seconds, 0), 120) * 1000)
    })
    return await railwayData(query, variables, token, "Railway usage")
  }
}

async function railwayData<V extends object>(query: string, variables: V, token: string, label: string): Promise<Record<string, unknown>> {
  const body = await getJson(
    "https://backboard.railway.com/graphql/v2",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    label,
  )
  if (!isRecord(body)) throw new Error(`${label} response was missing data`)
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const messages = body.errors.flatMap((error) => (isRecord(error) && typeof error.message === "string" ? [error.message] : []))
    throw new Error(messages.join("; ") || `${label} response had errors`)
  }
  if (!isRecord(body.data)) throw new Error(`${label} response was missing data`)
  return body.data
}

function namedNodes(connection: unknown): Map<string, string> {
  const names = new Map<string, string>()
  if (!isRecord(connection) || !Array.isArray(connection.edges)) return names
  for (const edge of connection.edges) {
    if (!isRecord(edge) || !isRecord(edge.node)) continue
    const id = edge.node.id
    const name = edge.node.name
    if (typeof id === "string" && id && typeof name === "string" && name) names.set(id, name)
  }
  return names
}
