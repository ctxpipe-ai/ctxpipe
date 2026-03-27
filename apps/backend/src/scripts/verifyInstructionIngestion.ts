/**
 * Report InstructionUnit + HAS_INSTRUCTION coverage in Postgres and FalkorDB for a repository.
 *
 * Usage (repo root):
 *   pnpm --filter @ctxpipe/backend run verify-instruction-ingestion -- --org-id <uuid> --repository-id <id>
 *
 * Env: apps/backend/.env.local — DATABASE_URL, GRAPH_DB_URI (optional for graph counts).
 */

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { and, eq, sql } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import {
  closeDb,
  getOrgDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { claims } from "../db/schema/claims.js"
import { retrievalObjects } from "../db/schema/retrieval_objects.js"
import { getGraphClient, withGraphClient } from "../platform/graph/client.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

function parseArgs(argv: string[]): { orgId: string; repositoryId: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    const next = i >= 0 ? argv[i + 1] : undefined
    return next !== undefined && !next.startsWith("-") ? next : undefined
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage:
  pnpm --filter @ctxpipe/backend run verify-instruction-ingestion -- --org-id <uuid> --repository-id <id>
`)
    process.exit(0)
  }
  const orgId = get("--org-id")
  const repositoryId = get("--repository-id")
  if (!orgId || !repositoryId) {
    console.error("Missing --org-id and --repository-id")
    process.exit(1)
  }
  return { orgId, repositoryId }
}

async function main(): Promise<void> {
  const { orgId, repositoryId } = parseArgs(process.argv.slice(2))
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initDb(env.DATABASE_URL)

  const systemDb = getSystemDb()
  const orgRows = await systemDb
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  const orgSlug = orgRows[0]?.slug
  if (!orgSlug) {
    console.error(`No organization found for id=${orgId}`)
    process.exit(1)
  }

  const dedupPrefix = `inu:${repositoryId}:`

  await withOrgIdContext({ id: orgId, slug: orgSlug }, async () =>
    withOrgDbContext(orgId, async () => {
      const db = getOrgDb()

      const unitPrefix = `${dedupPrefix}%`
      const skillPrefix = `skl:${repositoryId}:%`

      const [unitRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(retrievalObjects)
        .where(
          and(
            eq(retrievalObjects.orgId, orgId),
            eq(retrievalObjects.kind, "InstructionUnit"),
            sql`${retrievalObjects.deduplicationKey} LIKE ${unitPrefix}`,
          ),
        )

      const [skillRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(retrievalObjects)
        .where(
          and(
            eq(retrievalObjects.orgId, orgId),
            eq(retrievalObjects.kind, "Skill"),
            sql`${retrievalObjects.deduplicationKey} LIKE ${skillPrefix}`,
          ),
        )

      const [hasInstrRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(claims)
        .innerJoin(retrievalObjects, eq(claims.objectId, retrievalObjects.id))
        .where(
          and(
            eq(claims.orgId, orgId),
            eq(claims.predicate, "HAS_INSTRUCTION"),
            eq(retrievalObjects.kind, "InstructionUnit"),
            sql`${retrievalObjects.deduplicationKey} LIKE ${unitPrefix}`,
          ),
        )

      console.log(
        "Postgres (org-scoped, repository filter via deduplication_key prefix)",
      )
      console.log({
        instructionUnits: unitRow?.c ?? 0,
        hasInstructionClaims: hasInstrRow?.c ?? 0,
        skillsDerived: skillRow?.c ?? 0,
        repositoryId,
      })

      if (!process.env.GRAPH_DB_URI) {
        console.log("GRAPH_DB_URI unset — skipping FalkorDB counts")
        return
      }

      await withGraphClient({ orgId, orgSlug }, async () => {
        const driver = getGraphClient()
        const iu = await driver.executeQuery(
          `MATCH (u:InstructionUnit { orgId: $orgId })
           RETURN count(u) AS c`,
          { orgId },
        )
        const iuCount = Number(iu.records[0]?.get("c") ?? 0)

        const hi = await driver.executeQuery(
          `MATCH (s:Service { orgId: $orgId })-[r:HAS_INSTRUCTION]->(u:InstructionUnit { orgId: $orgId })
           RETURN count(r) AS c`,
          { orgId },
        )
        const hiCount = Number(hi.records[0]?.get("c") ?? 0)

        console.log(
          "FalkorDB (org-wide; not split by repository id on graph nodes)",
        )
        console.log({
          instructionUnitNodes: iuCount,
          hasInstructionEdges: hiCount,
        })
      })
    }),
  )

  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
