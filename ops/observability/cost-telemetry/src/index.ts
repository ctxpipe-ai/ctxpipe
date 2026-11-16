import { usdAudRate } from "./fx"
import { errorClass, httpClass, ProviderError, requiredEnv } from "./http"
import { due as awsDue, rows as awsRows } from "./providers/aws"
import { rows as blacksmithRows } from "./providers/blacksmith"
import { rows as cloudflareRows } from "./providers/cloudflare"
import {
  planRows as githubPlanRows,
  rows as githubRows,
} from "./providers/github"
import { rows as linearRows } from "./providers/linear"
import { rows as openRouterRows } from "./providers/openrouter"
import {
  mapRowsToOtlp,
  utcDays,
  type CostRow,
  type OtlpMetricsRequest,
  type ProviderStatus,
} from "./rows"
import { forgetProviderInputs, loadProviderInputs } from "./secrets"

// Each name is the `billing.provider` of the entry's `billing.provider_status` point. An entry that is not `due` in
// a run is not called and sends no status point.
const PROVIDERS: {
  name: string
  rows: (days: string[]) => Promise<CostRow[]>
  due?: (now: Date) => boolean
}[] = [
  { name: "openrouter", rows: openRouterRows },
  { name: "github", rows: githubRows },
  // Its own entry: a token that cannot see the plan fails only the plan rows.
  { name: "github-plan", rows: githubPlanRows },
  { name: "blacksmith", rows: blacksmithRows },
  { name: "cloudflare", rows: cloudflareRows },
  { name: "aws", rows: awsRows, due: awsDue },
  { name: "linear", rows: linearRows },
]

/**
 * One run: each due provider entry and the FX rate, then one OTLP export. The exit code is 0 when the export
 * succeeds, also when providers failed (their `billing.provider_status` points carry the failure); 1 when the export
 * fails or cannot start.
 */
export async function run(): Promise<number> {
  const now = new Date()
  const days = utcDays(now.getTime(), 3)
  const entries = PROVIDERS.filter((provider) => provider.due?.(now) ?? true)
  const inputFailures = await loadProviderInputs()
  const [[fxResult], results] = await Promise.all([
    Promise.allSettled([usdAudRate()]),
    Promise.allSettled(entries.map((provider) => provider.rows(days))),
  ]).finally(forgetProviderInputs)

  const rows: CostRow[] = []
  const statuses: ProviderStatus[] = []
  for (const [index, provider] of entries.entries()) {
    const result = results[index]
    if (result?.status === "fulfilled") {
      rows.push(...result.value)
      statuses.push({ provider: provider.name })
    } else {
      statuses.push({
        provider: provider.name,
        error: errorClass(result?.reason),
      })
    }
  }
  let fx: { rate: number; timeUnixNano: string } | undefined
  if (fxResult?.status === "fulfilled") {
    fx = {
      rate: fxResult.value,
      timeUnixNano: (BigInt(now.getTime()) * 1_000_000n).toString(),
    }
    statuses.push({ provider: "fx" })
  } else {
    statuses.push({ provider: "fx", error: errorClass(fxResult?.reason) })
  }

  // Only the class of each failure (and the variable name of an input that could not be read): a message can hold a
  // response body.
  const failures = statuses.flatMap((status) =>
    status.error === undefined ? [] : [`${status.provider}:${status.error}`],
  )
  console.log(
    `cost-telemetry rows=${rows.length} providers=${statuses.length - failures.length}/${statuses.length} fx=${fx?.rate ?? "failed"} failures=${failures.join(",") || "none"} inputs=${inputFailures.join(",") || "ok"} days=${days[0]}/${days[days.length - 1]}`,
  )
  try {
    const endpoint = requiredEnv("OTEL_EXPORTER_OTLP_ENDPOINT")
    // In the VPC the collector takes no headers; a collector behind Cloudflare Access takes them from this variable.
    await postOtlp(
      endpoint,
      mapRowsToOtlp(rows, fx, statuses, now.getTime()),
      otlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS ?? ""),
    )
  } catch (err) {
    console.error(`cost-telemetry OTLP export failed: ${errorClass(err)}`)
    return 1
  }
  return 0
}

export function otlpHeaders(raw: string): Record<string, string> {
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
  return headers
}

async function postOtlp(
  endpoint: string,
  body: OtlpMetricsRequest,
  headers: Record<string, string>,
): Promise<void> {
  const response = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/metrics`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new ProviderError(
      httpClass(response.status),
      `OTLP POST /v1/metrics failed: HTTP ${response.status} ${text.slice(0, 500)}`,
    )
  }
}

if (import.meta.main) process.exit(await run())
