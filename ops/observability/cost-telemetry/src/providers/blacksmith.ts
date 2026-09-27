import { isRecord, requiredEnv } from "../http"
import { sumRows, type CostRow } from "../rows"

const ORG = "ctxpipe-ai"

/**
 * Blacksmith CLI v0.4.61 `usage` JSON, verified against an authenticated run.
 * `daily` contains reported Actions cost and billable minutes. The separate
 * runner/workflow breakdowns cannot be joined to a day, so use org-level rows.
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
  const items = body.daily
  if (!Array.isArray(items)) throw new Error("blacksmith usage response was missing daily")
  const mapped: CostRow[] = []
  let mappable = 0
  for (const item of items) {
    const row = usageRow(item)
    if (!row) continue
    mappable += 1
    if (!wanted.has(row.day)) continue
    mapped.push(row)
  }
  if (items.length > 0 && mappable === 0) throw new Error("blacksmith usage daily had no mappable rows")
  return mapped
}

function usageRow(item: unknown): CostRow | undefined {
  if (!isRecord(item)) return undefined
  if (typeof item.date !== "string" || !item.date) return undefined
  if (typeof item.billable_minutes !== "number" || !Number.isFinite(item.billable_minutes)) return undefined
  if (typeof item.cost_usd !== "number" || !Number.isFinite(item.cost_usd)) return undefined
  return {
    day: item.date.slice(0, 10),
    provider: "blacksmith",
    sku: "actions",
    scope: "org",
    usage: item.billable_minutes,
    unit: "minutes",
    costUsd: item.cost_usd,
    source: "reported",
  }
}
