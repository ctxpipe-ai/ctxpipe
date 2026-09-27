import { usdAudRate } from "./fx"
import { requiredEnv } from "./http"
import { rows as awsRows } from "./providers/aws"
import { rows as blacksmithRows } from "./providers/blacksmith"
import { rows as cloudflareRows } from "./providers/cloudflare"
import { rows as githubRows } from "./providers/github"
import { rows as neonRows } from "./providers/neon"
import { rows as openRouterRows } from "./providers/openrouter"
import { rows as railwayRows } from "./providers/railway"
import { mapRowsToOtlp, utcDays, type CostRow, type OtlpMetricsRequest } from "./rows"

const PROVIDERS: { name: string; rows: (days: string[]) => Promise<CostRow[]> }[] = [
  { name: "openrouter", rows: openRouterRows },
  { name: "github", rows: githubRows },
  { name: "railway", rows: railwayRows },
  ...(process.env.NEON_API_KEY ? [{ name: "neon", rows: neonRows }] : []),
  { name: "blacksmith", rows: blacksmithRows },
  { name: "cloudflare", rows: cloudflareRows },
  { name: "aws", rows: awsRows },
]

async function main(): Promise<void> {
  const endpoint = requiredEnv("OTEL_EXPORTER_OTLP_ENDPOINT")
  const headers = otlpHeaders(requiredEnv("OTEL_EXPORTER_OTLP_HEADERS"))
  const days = utcDays(Date.now(), 3)
  const failures: string[] = []
  const rows: CostRow[] = []

  const [providerResults, fxResult] = await Promise.all([
    Promise.allSettled(PROVIDERS.map((provider) => provider.rows(days))),
    usdAudRate().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
  ])

  let providersOk = 0
  for (const [index, provider] of PROVIDERS.entries()) {
    const result = providerResults[index]
    if (!result) continue
    if (result.status === "fulfilled") {
      rows.push(...result.value)
      providersOk += 1
    } else {
      failures.push(`${provider.name}: ${errorMessage(result.reason)}`)
    }
  }

  let fxLog = "failed"
  let fx: { rate: number; timeUnixNano: string } | undefined
  if (fxResult.status === "fulfilled") {
    fx = { rate: fxResult.value, timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString() }
    fxLog = String(fx.rate)
  } else {
    failures.push(`fx: ${errorMessage(fxResult.reason)}`)
  }

  const payload = mapRowsToOtlp(rows, fx)
  if (payload.resourceMetrics.length > 0) await postOtlp(endpoint, payload, headers)
  console.log(
    `cost-telemetry rows=${rows.length} providers=${providersOk}/${PROVIDERS.length} fx=${fxLog} failures=${failures.length} days=${days[0]}/${days[days.length - 1]}`,
  )
  if (failures.length > 0) throw new Error(failures.join("; "))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

async function postOtlp(endpoint: string, body: OtlpMetricsRequest, headers: Record<string, string>): Promise<void> {
  const response = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/metrics`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OTLP POST /v1/metrics failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(errorMessage(err))
    process.exit(1)
  })
}
