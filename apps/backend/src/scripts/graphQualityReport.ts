/**
 * Graph quality report (ADR-033 §8). Reads join density, orphan rate,
 * evidence per claim, kind and predicate counts for one organization from
 * Postgres, or compares two saved reports.
 *
 * Usage (apps/backend):
 *   bun run src/scripts/graphQualityReport.ts --org-id <org> [--out before.json]
 *   bun run src/scripts/graphQualityReport.ts --compare before.json after.json
 *
 * Env: apps/backend/.env.local — DATABASE_URL.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { closeDb, initDb, withOrgDbContext } from "../db/client.js"
import {
  computeKnowledgeGraphQuality,
  type KnowledgeGraphQuality,
} from "../domain/knowledgeGraphQuality.js"

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
  before: KnowledgeGraphQuality,
  after: KnowledgeGraphQuality,
): string {
  const rows: Array<[string, string, string]> = [
    ["objects", String(before.totalObjects), String(after.totalObjects)],
    ["claims", String(before.totalClaims), String(after.totalClaims)],
    ["join density", pct(before.joinDensity), pct(after.joinDensity)],
    [
      "multi-source objects",
      String(before.multiSourceObjects),
      String(after.multiSourceObjects),
    ],
    ["orphan rate", pct(before.orphanRate), pct(after.orphanRate)],
    [
      "evidence rows per claim",
      before.evidenceRowsPerClaim.toFixed(2),
      after.evidenceRowsPerClaim.toFixed(2),
    ],
    [
      "connector-derived instruction units",
      String(before.connectorInstructionUnits),
      String(after.connectorInstructionUnits),
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
    ) as KnowledgeGraphQuality
    const after = JSON.parse(
      readFileSync(afterPath, "utf8"),
    ) as KnowledgeGraphQuality
    process.stdout.write(`${compare(before, after)}\n`)
    return
  }

  const orgId = flag(argv, "--org-id")
  if (!orgId)
    throw new Error("--org-id is required (or use --compare a.json b.json)")
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  try {
    const quality = await withOrgDbContext(orgId, (db) =>
      computeKnowledgeGraphQuality(db, orgId),
    )
    const json = JSON.stringify(
      { orgId, generatedAt: new Date().toISOString(), ...quality },
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
