import { getJson, isRecord, requiredEnv } from "../http"
import {
  cloudflareR2ClassAUsdPerMillion,
  cloudflareR2ClassBUsdPerMillion,
  cloudflareR2FreeClassA,
  cloudflareR2FreeClassB,
  cloudflareR2FreeStorageGbMonth,
  cloudflareR2StorageUsdPerGbMonth,
} from "../rates"
import { sumRows, type CostRow } from "../rows"

type BucketUsage = { day: string; bucket: string; usage: number }

const classA = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
])
const classB = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
])
const freeOperations = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"])

const QUERY = `query R2Cost($accountTag: string!, $start: Date!, $end: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_ASC]) {
            max { payloadSize metadataSize }
            dimensions { date bucketName }
          }
          r2OperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_ASC]) {
            sum { requests }
            dimensions { date bucketName actionType }
          }
        }
      }
    }`

export async function rows(days: string[]): Promise<CostRow[]> {
  const token = requiredEnv("CLOUDFLARE_API_TOKEN")
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID")
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return []
  const wanted = new Set(days)
  const storage: BucketUsage[] = []
  const operations = { classA: [] as BucketUsage[], classB: [] as BucketUsage[] }
  for (const month of monthWindows(first, last)) {
    const body = await getJson(
      "https://api.cloudflare.com/client/v4/graphql",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { accountTag: accountId, start: month.start, end: month.end } }),
      },
      "Cloudflare R2",
    )
    if (!isRecord(body)) throw new Error("Cloudflare R2 response was missing data")
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const messages = body.errors.flatMap((error) => (isRecord(error) && typeof error.message === "string" ? [error.message] : []))
      throw new Error(messages.join("; ") || "Cloudflare R2 response had errors")
    }
    if (!isRecord(body.data)) throw new Error("Cloudflare R2 response was missing data")
    const accounts = isRecord(body.data.viewer) && Array.isArray(body.data.viewer.accounts) ? body.data.viewer.accounts : undefined
    if (!accounts) throw new Error("Cloudflare R2 response was missing accounts")
    const account = accounts[0]
    if (!isRecord(account)) continue
    storage.push(...storageUsage(account.r2StorageAdaptiveGroups))
    const monthOps = operationUsage(account.r2OperationsAdaptiveGroups)
    operations.classA.push(...monthOps.classA)
    operations.classB.push(...monthOps.classB)
  }
  // Free tier is account-wide. Emit per-bucket usage; cost is that day's billed excess split by the bucket's share of the day's usage.
  return sumRows([
    ...charge(storage, wanted, "r2_storage", "gb_month", cloudflareR2FreeStorageGbMonth, 1, cloudflareR2StorageUsdPerGbMonth),
    ...charge(operations.classA, wanted, "r2_class_a", "requests", cloudflareR2FreeClassA, 1_000_000, cloudflareR2ClassAUsdPerMillion),
    ...charge(operations.classB, wanted, "r2_class_b", "requests", cloudflareR2FreeClassB, 1_000_000, cloudflareR2ClassBUsdPerMillion),
  ])
}

function monthWindows(first: string, last: string): { start: string; end: string }[] {
  const windows: { start: string; end: string }[] = []
  let year = Number(first.slice(0, 4))
  let month = Number(first.slice(5, 7))
  const lastYear = Number(last.slice(0, 4))
  const lastMonth = Number(last.slice(5, 7))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(lastYear) || !Number.isFinite(lastMonth)) {
    throw new Error(`invalid day ${first}/${last}`)
  }
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const start = `${year}-${String(month).padStart(2, "0")}-01`
    const lastOfMonth = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
    windows.push({ start, end: last < lastOfMonth ? last : lastOfMonth })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return windows
}

function storageUsage(groups: unknown): BucketUsage[] {
  if (groups === undefined) return []
  if (!Array.isArray(groups)) throw new Error("Cloudflare R2 response was missing r2StorageAdaptiveGroups")
  const mapped: BucketUsage[] = []
  for (const item of groups) {
    if (!isRecord(item) || !isRecord(item.max) || !isRecord(item.dimensions)) continue
    if (typeof item.dimensions.date !== "string") continue
    if (typeof item.max.payloadSize !== "number" || !Number.isFinite(item.max.payloadSize)) continue
    if (typeof item.max.metadataSize !== "number" || !Number.isFinite(item.max.metadataSize)) continue
    const bytes = item.max.payloadSize + item.max.metadataSize
    if (!(bytes > 0)) continue
    mapped.push({
      day: item.dimensions.date.slice(0, 10),
      bucket: bucketScope(item.dimensions.bucketName),
      usage: bytes / 1_000_000_000 / 30,
    })
  }
  return mapped
}

function operationUsage(groups: unknown): { classA: BucketUsage[]; classB: BucketUsage[] } {
  if (groups === undefined) return { classA: [], classB: [] }
  if (!Array.isArray(groups)) throw new Error("Cloudflare R2 response was missing r2OperationsAdaptiveGroups")
  const classAUsage: BucketUsage[] = []
  const classBUsage: BucketUsage[] = []
  for (const item of groups) {
    if (!isRecord(item) || !isRecord(item.sum) || !isRecord(item.dimensions)) continue
    if (typeof item.dimensions.date !== "string" || typeof item.dimensions.actionType !== "string") continue
    if (typeof item.sum.requests !== "number" || !Number.isFinite(item.sum.requests) || !(item.sum.requests > 0)) continue
    const actionType = item.dimensions.actionType
    if (freeOperations.has(actionType)) continue
    const usage = {
      day: item.dimensions.date.slice(0, 10),
      bucket: bucketScope(item.dimensions.bucketName),
      usage: item.sum.requests,
    }
    if (classA.has(actionType)) classAUsage.push(usage)
    else if (classB.has(actionType)) classBUsage.push(usage)
    else throw new Error(`unknown Cloudflare R2 actionType: ${actionType}`)
  }
  return { classA: classAUsage, classB: classBUsage }
}

function bucketScope(value: unknown): string {
  return typeof value === "string" && value ? value : "account"
}

function charge(
  items: BucketUsage[],
  wanted: Set<string>,
  sku: string,
  unit: string,
  allowance: number,
  billableUnit: number,
  unitPrice: number,
): CostRow[] {
  const byDay = new Map<string, BucketUsage[]>()
  for (const item of items) {
    const existing = byDay.get(item.day)
    if (existing) existing.push(item)
    else byDay.set(item.day, [item])
  }
  const mapped: CostRow[] = []
  let month = ""
  let mtdUsage = 0
  let prevCost = 0
  for (const day of [...byDay.keys()].sort()) {
    const bucketMonth = day.slice(0, 7)
    if (bucketMonth !== month) {
      month = bucketMonth
      mtdUsage = 0
      prevCost = 0
    }
    const entries = byDay.get(day)
    if (!entries) continue
    const total = entries.reduce((sum, item) => sum + item.usage, 0)
    const billed = Math.max(0, mtdUsage + total - allowance) - Math.max(0, mtdUsage - allowance)
    mtdUsage += total
    const mtdCost = Math.ceil(Math.max(0, mtdUsage - allowance) / billableUnit) * unitPrice
    const dayCost = mtdCost - prevCost
    prevCost = mtdCost
    if (!wanted.has(day) || !(dayCost > 0) || !(total > 0)) continue
    const byBucket = new Map<string, number>()
    for (const item of entries) byBucket.set(item.bucket, (byBucket.get(item.bucket) ?? 0) + item.usage)
    for (const [bucket, usage] of byBucket) {
      const share = usage / total
      const billedShare = share * billed
      if (!(billedShare > 0)) continue
      mapped.push({
        day,
        provider: "cloudflare",
        sku,
        scope: bucket,
        usage: billedShare,
        unit,
        costUsd: share * dayCost,
        source: "estimated",
      })
    }
  }
  return mapped
}
