import { isRecord, requiredEnv } from "../http"
import { sumRows, type CostRow } from "../rows"

const ORG = "ctxpipe-ai"
const BREAKDOWN = "day,runner_type,workflow"

/**
 * Blacksmith CLI v0.4.61 `usage` JSON.
 *
 * Official docs list flags and minute/cost columns, not the JSON envelope.
 * Pinned-binary tags include `summary`, `days`, `breakdowns`, `day`,
 * `runner_type`, `workflow`, `repo`, `billable_minutes`, `estimated_cost_usd`.
 * This parser requires `breakdowns["day,runner_type,workflow"]` — the
 * `--breakdown-by` CSV we send. That keying is unverified against a live
 * authenticated run. A missing/wrong envelope throws instead of emitting $0.
 */
export async function rows(days: string[]): Promise<CostRow[]> {
  const token = requiredEnv("BLACKSMITH_TOKEN")
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return []
  const wanted = new Set(days)
  const start = `${first}T00:00:00Z`
  const end = `${last}T23:59:59Z`
  // usage has no token flag; the documented non-interactive auth is auth login --api-token.
  await run(
    ["blacksmith", "auth", "login", "--api-token", "-", "--non-interactive", "--organization", ORG],
    token,
  )
  const stdout = await run([
    "blacksmith",
    "usage",
    "--start-time",
    start,
    "--end-time",
    end,
    "--breakdown-by",
    BREAKDOWN,
    "--format",
    "json",
    "--limit",
    "1000",
    "--org",
    ORG,
  ])
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    throw new Error(`blacksmith usage stdout was not JSON: ${stdout.slice(0, 500)}`)
  }
  return sumRows(mapUsage(parsed, wanted))
}

async function run(argv: string[], stdin?: string): Promise<string> {
  const subprocess = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    env: { ...process.env, BLACKSMITH_DISABLE_AUTO_UPDATE: "1" },
  })
  const timer = setTimeout(() => subprocess.kill(), 60_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
    if (exitCode !== 0) throw new Error(`blacksmith ${argv[1]} failed: ${stderr.slice(0, 500)}`)
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

function mapUsage(body: unknown, wanted: Set<string>): CostRow[] {
  if (!isRecord(body)) throw new Error("blacksmith usage response was not an object")
  if (!isRecord(body.breakdowns)) throw new Error("blacksmith usage response was missing breakdowns")
  const items = body.breakdowns[BREAKDOWN]
  if (!Array.isArray(items)) throw new Error(`blacksmith usage response was missing breakdowns[${BREAKDOWN}]`)
  const mapped: CostRow[] = []
  let mappable = 0
  for (const item of items) {
    const row = usageRow(item)
    if (!row) continue
    mappable += 1
    if (!wanted.has(row.day)) continue
    mapped.push(row)
  }
  if (items.length > 0 && mappable === 0) throw new Error("blacksmith usage breakdown had no mappable rows")
  return mapped
}

function usageRow(item: unknown): CostRow | undefined {
  if (!isRecord(item)) return undefined
  if (typeof item.day !== "string" || !item.day) return undefined
  if (typeof item.runner_type !== "string" || !item.runner_type) return undefined
  if (typeof item.billable_minutes !== "number" || !Number.isFinite(item.billable_minutes)) return undefined
  if (typeof item.estimated_cost_usd !== "number" || !Number.isFinite(item.estimated_cost_usd)) return undefined
  const day = item.day.slice(0, 10)
  const scope = typeof item.workflow === "string" && item.workflow ? item.workflow : typeof item.repo === "string" && item.repo ? item.repo : "org"
  return {
    day,
    provider: "blacksmith",
    sku: item.runner_type,
    scope,
    usage: item.billable_minutes,
    unit: "minutes",
    costUsd: item.estimated_cost_usd,
    source: "reported",
  }
}
