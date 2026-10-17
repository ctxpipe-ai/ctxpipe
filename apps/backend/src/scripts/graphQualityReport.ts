/**
 * Graph quality report (ADR-033 §8). Reads join density, orphan rate,
 * sourced-claim rate, kind and predicate counts for one Workspace's active
 * projection from Postgres, or compares two saved reports.
 *
 * Usage (apps/backend):
 *   bun run src/scripts/graphQualityReport.ts --org-id <org> --workspace-id <ws> [--out before.json]
 *   bun run src/scripts/graphQualityReport.ts --compare before.json after.json
 *
 * Env: apps/backend/.env.local — DATABASE_URL.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { hydrateUnitsToProjectionClaims } from "../domain/workspaces/hydrate.js"
import {
  computeWorkspaceGraphQuality,
  type WorkspaceGraphQuality,
} from "../domain/workspaces/workspace-graph.js"
import { getWorkspaceProjectionSnapshot } from "../models/workspaces.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function compare(
  before: WorkspaceGraphQuality,
  after: WorkspaceGraphQuality,
): string {
  const rows: Array<[string, string, string]> = [
    ["units", String(before.totalUnits), String(after.totalUnits)],
    ["claims", String(before.totalClaims), String(after.totalClaims)],
    ["join density", pct(before.joinDensity), pct(after.joinDensity)],
    [
      "multi-source units",
      String(before.multiSourceUnits),
      String(after.multiSourceUnits),
    ],
    ["orphan rate", pct(before.orphanRate), pct(after.orphanRate)],
    [
      "sourced claims",
      pct(before.sourcedClaimRate),
      pct(after.sourcedClaimRate),
    ],
  ]
  const kinds = new Set([
    ...Object.keys(before.kinds),
    ...Object.keys(after.kinds),
  ])
  const predicates = new Set([
    ...Object.keys(before.predicates),
    ...Object.keys(after.predicates),
  ])
  const lines = [
    "| Metric | Before | After |",
    "| --- | --- | --- |",
    ...rows.map(([name, b, a]) => `| ${name} | ${b} | ${a} |`),
    "",
    "| Kind | Before | After |",
    "| --- | --- | --- |",
    ...[...kinds]
      .sort()
      .map(
        (kind) =>
          `| ${kind} | ${before.kinds[kind] ?? 0} | ${after.kinds[kind] ?? 0} |`,
      ),
    "",
    "| Predicate | Before | After |",
    "| --- | --- | --- |",
    ...[...predicates]
      .sort()
      .map(
        (p) =>
          `| ${p} | ${before.predicates[p] ?? 0} | ${after.predicates[p] ?? 0} |`,
      ),
  ]
  return lines.join("\n")
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--compare")) {
    const index = argv.indexOf("--compare")
    const [beforePath, afterPath] = [argv[index + 1], argv[index + 2]]
    if (!beforePath || !afterPath)
      throw new Error("--compare needs two report paths")
    const before = JSON.parse(
      readFileSync(beforePath, "utf8"),
    ) as WorkspaceGraphQuality
    const after = JSON.parse(
      readFileSync(afterPath, "utf8"),
    ) as WorkspaceGraphQuality
    process.stdout.write(`${compare(before, after)}\n`)
    return
  }

  const orgId = flag(argv, "--org-id")
  const workspaceId = flag(argv, "--workspace-id")
  if (!orgId || !workspaceId)
    throw new Error(
      "--org-id and --workspace-id are required (or use --compare a.json b.json)",
    )
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  try {
    const [org] = await getSystemDb()
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
    if (!org) throw new Error(`Organization ${orgId} not found`)
    const { units } = await withOrgIdContext(
      { id: orgId, slug: org.slug },
      () => getWorkspaceProjectionSnapshot(workspaceId),
    )
    const quality = computeWorkspaceGraphQuality(
      units,
      hydrateUnitsToProjectionClaims(units),
    )
    const json = JSON.stringify(
      { orgId, workspaceId, generatedAt: new Date().toISOString(), ...quality },
      null,
      2,
    )
    const out = flag(argv, "--out")
    if (out) writeFileSync(out, `${json}\n`)
    process.stdout.write(`${json}\n`)
  } finally {
    await closeDb()
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
