/**
 * Backfill: load claims from Postgres and project them to Falkor via projectClaimsFromState.
 * Use when HAS_INSTRUCTION (or other) edges exist in Postgres but were skipped or failed in graph projection.
 *
 * Usage (repo root):
 *   pnpm --filter @ctxpipe/backend run reproject-claims-to-graph -- --org-id <uuid> [--predicate HAS_INSTRUCTION] [--repository-id <id>]
 *
 * Env: apps/backend/.env.local — DATABASE_URL, GRAPH_DB_URI, AUTH_SECRET (parseEnv).
 */

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { aliasedTable, and, eq, inArray, sql } from "drizzle-orm"
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
import { claimEvidence } from "../db/schema/claim_evidence.js"
import { claims } from "../db/schema/claims.js"
import { objects } from "../db/schema/objects.js"
import {
  createLogger,
  initEvlog,
  log,
  withLogger,
} from "../observability/logger.js"
import type { ClaimForProjection } from "../retrieval/schema/claimForProjection.js"
import { projectClaimsFromState } from "../retrieval/services/graphProjection.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

initEvlog()

function parseArgs(argv: string[]): {
  orgId: string
  predicate: string
  repositoryId: string | undefined
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    const next = i >= 0 ? argv[i + 1] : undefined
    return next !== undefined && !next.startsWith("-") ? next : undefined
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    const usage = `Usage:
  pnpm --filter @ctxpipe/backend run reproject-claims-to-graph -- --org-id <uuid> [--predicate <name>] [--repository-id <id>]

  --predicate   Defaults to HAS_INSTRUCTION
  --repository-id  When set, only claims whose object InstructionUnit has
                    deduplication_key LIKE 'inu:<repository-id>:%'
`
    log.info({
      step: "reprojectClaimsToGraph.cli",
      message: usage,
    })
    process.exit(0)
  }
  const orgId = get("--org-id")
  const predicate = get("--predicate") ?? "HAS_INSTRUCTION"
  const repositoryId = get("--repository-id")
  if (!orgId) {
    log.error({
      step: "reprojectClaimsToGraph.cli",
      message: "Missing required --org-id",
    })
    process.exit(1)
  }
  return { orgId, predicate, repositoryId }
}

async function main(): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initDb(env.DATABASE_URL)

  const { orgId, predicate, repositoryId } = parseArgs(process.argv.slice(2))

  const systemDb = getSystemDb()
  const orgRows = await systemDb
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  const orgSlug = orgRows[0]?.slug
  if (!orgSlug) {
    log.error({
      step: "reprojectClaimsToGraph.cli",
      message: `No organization found for id=${orgId}`,
      orgId,
    })
    process.exit(1)
  }

  try {
    await withOrgIdContext({ id: orgId, slug: orgSlug }, () =>
      withOrgDbContext(orgId, async () => {
        const db = getOrgDb()
        const subjectRo = aliasedTable(objects, "subject_ro")
        const objectRo = aliasedTable(objects, "object_ro")

        const repoFilter =
          repositoryId !== undefined
            ? and(
                eq(objectRo.kind, "InstructionUnit"),
                sql`${objectRo.deduplicationKey} LIKE ${`inu:${repositoryId}:%`}`,
              )
            : undefined

        const rows = await db
          .select({
            id: claims.id,
            subjectId: claims.subjectId,
            objectId: claims.objectId,
            subjectKind: subjectRo.kind,
            objectKind: objectRo.kind,
            predicate: claims.predicate,
            status: claims.status,
            aggregatedConfidence: claims.aggregatedConfidence,
            lastObservedAt: claims.lastObservedAt,
            validFrom: claims.validFrom,
            validTo: claims.validTo,
          })
          .from(claims)
          .innerJoin(subjectRo, eq(claims.subjectId, subjectRo.id))
          .innerJoin(objectRo, eq(claims.objectId, objectRo.id))
          .where(
            and(
              eq(claims.orgId, orgId),
              eq(claims.predicate, predicate),
              eq(subjectRo.orgId, orgId),
              eq(objectRo.orgId, orgId),
              ...(repoFilter !== undefined ? [repoFilter] : []),
            ),
          )

        const claimIds = rows.map((r) => r.id)
        const evidenceCounts: Record<string, number> =
          claimIds.length === 0
            ? {}
            : Object.fromEntries(
                (
                  await db
                    .select({
                      claimId: claimEvidence.claimId,
                      count: sql<number>`count(*)::int`,
                    })
                    .from(claimEvidence)
                    .where(inArray(claimEvidence.claimId, claimIds))
                    .groupBy(claimEvidence.claimId)
                ).map((r) => [r.claimId, r.count]),
              )

        const claimsForProjection: ClaimForProjection[] = rows.map((row) => ({
          id: row.id,
          subjectId: row.subjectId,
          objectId: row.objectId,
          subjectKind: row.subjectKind,
          objectKind: row.objectKind,
          predicate: row.predicate,
          status: row.status,
          aggregatedConfidence: row.aggregatedConfidence,
          sourceCount: evidenceCounts[row.id] ?? 0,
          lastObservedAt: row.lastObservedAt.toISOString(),
          validFrom: row.validFrom?.toISOString() ?? null,
          validTo: row.validTo?.toISOString() ?? null,
        }))

        const result = await withLogger(
          createLogger({ step: "reprojectClaimsToGraph", orgId }),
          () => projectClaimsFromState(claimsForProjection),
        )
        const payload = {
          ok: true as const,
          projected: result.projected,
          predicate,
          ...(repositoryId !== undefined ? { repositoryId } : {}),
        }
        log.info({
          step: "reprojectClaimsToGraph.complete",
          message: "reprojectClaimsToGraph: complete",
          ...payload,
        })
        process.stdout.write(`${JSON.stringify(payload)}\n`)
      }),
    )
  } finally {
    await closeDb()
  }
}

void main()
