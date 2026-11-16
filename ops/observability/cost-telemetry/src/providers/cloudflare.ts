import { getJson, isRecord, requiredEnv, throwGraphqlErrors } from "../http"
import { sumRows, type CostRow } from "../rows"

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

/**
 * Cloudflare spend and R2 usage.
 *
 * - Cost: the account billing history (GET /accounts/{account_id}/billing/history,
 *   https://developers.cloudflare.com/api/resources/billing/subresources/history/methods/list).
 *   It has no date filter, so the run reads every page (page, result_info) and keeps the
 *   items of type `charge` whose occurred_at falls on a window day (the API documents no
 *   other type, so a refund or a credit is not counted): one row per charge,
 *   sku = description, scope = the billing item id, source `reported`. A charge in another
 *   currency than USD throws.
 * - R2: usage only (cost 0), from the GraphQL analytics, so the R2 part of a charge is not
 *   counted twice. Storage is the day's share of a GB-month (bytes / 1e9 / 30).
 */
export async function rows(days: string[]): Promise<CostRow[]> {
  const token = requiredEnv("CLOUDFLARE_API_TOKEN")
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID")
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return []
  const wanted = new Set(days)
  const headers = { Authorization: `Bearer ${token}` }
  const [charges, usage] = await Promise.all([
    chargeRows(accountId, headers, wanted),
    r2Rows(accountId, headers, first, last, wanted),
  ])
  return [...charges, ...usage]
}

async function chargeRows(accountId: string, headers: Record<string, string>, wanted: Set<string>): Promise<CostRow[]> {
  const mapped: CostRow[] = []
  for (let page = 1; ; page += 1) {
    if (page > 100) throw new Error("Cloudflare billing history has more than 100 pages")
    const body = await getJson(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/billing/history?page=${page}`,
      { headers },
      "Cloudflare billing history",
    )
    if (!isRecord(body) || !Array.isArray(body.result)) throw new Error("Cloudflare billing history response was missing result")
    for (const item of body.result) {
      if (!isRecord(item) || item.type !== "charge") continue
      if (typeof item.id !== "string" || typeof item.occurred_at !== "string") continue
      if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) continue
      const day = item.occurred_at.slice(0, 10)
      if (!wanted.has(day)) continue
      if (item.currency !== "USD") throw new Error(`Cloudflare charge ${item.id} is in ${String(item.currency)}, not USD`)
      const label = [item.description, item.action].find((value) => typeof value === "string" && value)
      mapped.push({
        day,
        provider: "cloudflare",
        sku: typeof label === "string" ? label : "charge",
        scope: item.id,
        usage: 1,
        unit: "charge",
        costUsd: item.amount,
        source: "reported",
      })
    }
    const info = body.result_info
    const lastPage =
      body.result.length === 0 ||
      (isRecord(info) &&
        typeof info.per_page === "number" &&
        typeof info.total_count === "number" &&
        page * info.per_page >= info.total_count)
    if (lastPage) return mapped
  }
}

async function r2Rows(
  accountId: string,
  headers: Record<string, string>,
  start: string,
  end: string,
  wanted: Set<string>,
): Promise<CostRow[]> {
  const body = await getJson(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { accountTag: accountId, start, end } }),
    },
    "Cloudflare R2",
  )
  if (!isRecord(body)) throw new Error("Cloudflare R2 response was missing data")
  throwGraphqlErrors(body, "Cloudflare R2")
  if (!isRecord(body.data)) throw new Error("Cloudflare R2 response was missing data")
  const accounts = isRecord(body.data.viewer) && Array.isArray(body.data.viewer.accounts) ? body.data.viewer.accounts : undefined
  if (!accounts) throw new Error("Cloudflare R2 response was missing accounts")
  const account = accounts[0]
  if (!isRecord(account)) return []
  return sumRows(
    [...storageUsage(account.r2StorageAdaptiveGroups), ...operationUsage(account.r2OperationsAdaptiveGroups)].filter((row) =>
      wanted.has(row.day),
    ),
  )
}

function storageUsage(groups: unknown): CostRow[] {
  if (groups === undefined) return []
  if (!Array.isArray(groups)) throw new Error("Cloudflare R2 response was missing r2StorageAdaptiveGroups")
  const mapped: CostRow[] = []
  for (const item of groups) {
    if (!isRecord(item) || !isRecord(item.max) || !isRecord(item.dimensions)) continue
    if (typeof item.dimensions.date !== "string") continue
    if (typeof item.max.payloadSize !== "number" || !Number.isFinite(item.max.payloadSize)) continue
    if (typeof item.max.metadataSize !== "number" || !Number.isFinite(item.max.metadataSize)) continue
    const bytes = item.max.payloadSize + item.max.metadataSize
    if (!(bytes > 0)) continue
    mapped.push(usageRow(item.dimensions.date, item.dimensions.bucketName, "r2_storage", bytes / 1_000_000_000 / 30, "gb_month"))
  }
  return mapped
}

function operationUsage(groups: unknown): CostRow[] {
  if (groups === undefined) return []
  if (!Array.isArray(groups)) throw new Error("Cloudflare R2 response was missing r2OperationsAdaptiveGroups")
  const mapped: CostRow[] = []
  for (const item of groups) {
    if (!isRecord(item) || !isRecord(item.sum) || !isRecord(item.dimensions)) continue
    if (typeof item.dimensions.date !== "string" || typeof item.dimensions.actionType !== "string") continue
    if (typeof item.sum.requests !== "number" || !Number.isFinite(item.sum.requests) || !(item.sum.requests > 0)) continue
    const actionType = item.dimensions.actionType
    if (freeOperations.has(actionType)) continue
    const sku = classA.has(actionType) ? "r2_class_a" : classB.has(actionType) ? "r2_class_b" : undefined
    if (!sku) throw new Error(`unknown Cloudflare R2 actionType: ${actionType}`)
    mapped.push(usageRow(item.dimensions.date, item.dimensions.bucketName, sku, item.sum.requests, "requests"))
  }
  return mapped
}

function usageRow(date: string, bucketName: unknown, sku: string, usage: number, unit: string): CostRow {
  return {
    day: date.slice(0, 10),
    provider: "cloudflare",
    sku,
    scope: typeof bucketName === "string" && bucketName ? bucketName : "account",
    usage,
    unit,
    costUsd: 0,
    source: "reported",
  }
}
