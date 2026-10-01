import { getJson, isRecord, requiredEnv } from "../http"
import { neonRates, type NeonPlan } from "../rates"
import { sumRows, type CostRow } from "../rows"

export async function rows(days: string[]): Promise<CostRow[]> {
  const key = requiredEnv("NEON_API_KEY")
  const orgId = requiredEnv("NEON_ORG_ID")
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return []
  const fromMs = Date.parse(`${first.slice(0, 8)}01T00:00:00.000Z`)
  const toMs = Date.parse(`${last}T00:00:00.000Z`)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error(`invalid day ${first}/${last}`)
  const wanted = new Set(days)
  const mapped: CostRow[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const projects = await fetchPage(key, orgId, new Date(fromMs).toISOString(), new Date(toMs + 86_400_000).toISOString(), cursor)
    let added = 0
    for (const project of projects.items) {
      if (!isRecord(project)) continue
      if (typeof project.project_id !== "string" || !project.project_id) continue
      if (seen.has(project.project_id)) continue
      seen.add(project.project_id)
      added += 1
      mapped.push(...projectRows(project, wanted))
    }
    if (added === 0 || !projects.cursor) break
    cursor = projects.cursor
  }
  return sumRows(mapped)
}

async function fetchPage(
  key: string,
  orgId: string,
  from: string,
  to: string,
  cursor: string | undefined,
): Promise<{ items: unknown[]; cursor: string | undefined }> {
  const url = new URL("https://console.neon.tech/api/v2/consumption_history/v2/projects")
  url.searchParams.set("org_id", orgId)
  url.searchParams.set("from", from)
  url.searchParams.set("to", to)
  url.searchParams.set("granularity", "daily")
  url.searchParams.set(
    "metrics",
    "compute_unit_seconds,root_branch_bytes_month,child_branch_bytes_month,instant_restore_bytes_month,snapshot_storage_bytes_month,public_network_transfer_bytes,private_network_transfer_bytes,extra_branches_month",
  )
  url.searchParams.set("limit", "100")
  if (cursor) url.searchParams.set("cursor", cursor)
  const body = await getJson(url.toString(), { headers: { Authorization: `Bearer ${key}` } }, "Neon consumption")
  if (!isRecord(body) || !Array.isArray(body.projects)) throw new Error("Neon consumption response was missing projects")
  const pagination = isRecord(body.pagination) && typeof body.pagination.cursor === "string" && body.pagination.cursor ? body.pagination.cursor : undefined
  return { items: body.projects, cursor: pagination }
}

function projectRows(project: Record<string, unknown>, wanted: Set<string>): CostRow[] {
  const scope = typeof project.name === "string" && project.name ? project.name : project.project_id
  if (typeof scope !== "string") return []
  if (!Array.isArray(project.periods)) return []
  const buckets: { day: string; plan: NeonPlan; metrics: unknown[] }[] = []
  for (const period of project.periods) {
    if (!isRecord(period) || !Array.isArray(period.consumption)) continue
    if (period.period_plan !== "launch" && period.period_plan !== "scale" && period.period_plan !== "agent") {
      throw new Error(`unknown Neon period_plan: ${String(period.period_plan)}`)
    }
    const plan = period.period_plan
    for (const bucket of period.consumption) {
      if (!isRecord(bucket) || typeof bucket.timeframe_start !== "string") continue
      if (!Array.isArray(bucket.metrics)) continue
      buckets.push({ day: bucket.timeframe_start.slice(0, 10), plan, metrics: bucket.metrics })
    }
  }
  buckets.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const mapped: CostRow[] = []
  let month = ""
  let remainingPublicGb = 0
  for (const bucket of buckets) {
    const rates = neonRates[bucket.plan]
    const bucketMonth = bucket.day.slice(0, 7)
    if (bucketMonth !== month) {
      month = bucketMonth
      remainingPublicGb = rates.publicTransferGbPerProjectMonth
    }
    for (const metric of bucket.metrics) {
      if (!isRecord(metric)) continue
      if (typeof metric.metric_name !== "string" || typeof metric.value !== "number" || !Number.isFinite(metric.value) || !(metric.value > 0)) continue
      if (metric.metric_name === "public_network_transfer_bytes") {
        const usageGb = bytesToGb(metric.value)
        const billed = Math.max(0, usageGb - remainingPublicGb)
        remainingPublicGb = Math.max(0, remainingPublicGb - usageGb)
        if (wanted.has(bucket.day) && billed > 0) {
          mapped.push(estimated({ day: bucket.day, scope, sku: "egress", usage: billed, unit: "GB", costUsd: billed * rates.publicTransferUsdPerGb }))
        }
        continue
      }
      if (!wanted.has(bucket.day)) continue
      const row = metricRow(bucket.day, scope, metric.metric_name, metric.value, rates)
      if (row) mapped.push(row)
    }
  }
  return mapped
}

function metricRow(
  day: string,
  scope: string,
  name: string,
  value: number,
  rates: (typeof neonRates)[NeonPlan],
): CostRow | undefined {
  const skus: Record<string, { sku: string; unit: string; usage: number; rate: number }> = {
    compute_unit_seconds: { sku: "compute", unit: "cu_hour", usage: value / 3600, rate: rates.computeUsdPerCuHour },
    root_branch_bytes_month: { sku: "storage_root", unit: "gb_month", usage: bytesToGb(value), rate: rates.storageUsdPerGbMonth },
    child_branch_bytes_month: { sku: "storage_child", unit: "gb_month", usage: bytesToGb(value), rate: rates.storageUsdPerGbMonth },
    instant_restore_bytes_month: { sku: "instant_restore", unit: "gb_month", usage: bytesToGb(value), rate: rates.instantRestoreUsdPerGbMonth },
    snapshot_storage_bytes_month: { sku: "snapshot", unit: "gb_month", usage: bytesToGb(value), rate: rates.snapshotUsdPerGbMonth },
    private_network_transfer_bytes: { sku: "egress_private", unit: "GB", usage: bytesToGb(value), rate: rates.privateTransferUsdPerGb },
    extra_branches_month: {
      sku: "extra_branches",
      unit: "branch_month",
      usage: Math.max(0, value - rates.includedChildBranches * 24) / 744,
      rate: rates.extraBranchUsdPerMonth,
    },
  }
  const sku = skus[name]
  if (!sku || !(sku.usage > 0)) return
  return estimated({ day, scope, sku: sku.sku, usage: sku.usage, unit: sku.unit, costUsd: sku.usage * sku.rate })
}

function estimated(row: Pick<CostRow, "day" | "scope" | "sku" | "usage" | "unit" | "costUsd">): CostRow {
  return { ...row, provider: "neon", source: "estimated" }
}

function bytesToGb(value: number): number {
  return value / 1_000_000_000
}
