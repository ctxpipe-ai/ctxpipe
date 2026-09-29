/**
 * Dedup store against real Postgres. The n8n ingest died on an unchunked
 * end-of-run `claims.id IN (...)` with 97k binds (Postgres max 65535).
 * This refactor projects from the prefetch and never issues that refetch.
 *
 * Requires DATABASE_URL (apps/backend/.env.local). Skipped otherwise.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../../db/client.js"
import { claimEvidence } from "../../../db/schema/claim_evidence.js"
import { claims } from "../../../db/schema/claims.js"
import { objects } from "../../../db/schema/objects.js"
import { repositories } from "../../../db/schema/repositories.js"
import { generateObjectId } from "../../../lib/id.js"
import { createLogger, withLogger } from "../../../observability/logger.js"
import type { CodeIngestionState, ExtractedClaim } from "../schemas.js"
import { deduplicateAndStore } from "./deduplicateAndStore.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../../.env.local") })

const connectionString = process.env.DATABASE_URL

const ORG_ID = `org_test_dedup_ref_${Date.now()}`
const REPO_ID = generateObjectId("repo")
/** One past Postgres's 65535 bind cap if the old IN list is not uniqued. */
const OVER_BIND_LIMIT = 66_000
const UNIQUE_TRIPLES = 600

function fileClaim(path: string): ExtractedClaim {
  return {
    subjectRef: `file:${path}`,
    subjectKind: "File",
    objectRef: `repo:${REPO_ID}`,
    objectKind: "Repository",
    predicate: "PART_OF",
    sourceId: `identifyAPIs:${path}:hash-one`,
    sourceType: "git",
    extractionMethod: "deterministic",
    confidence: 0.9,
  }
}

function state(extractedClaims: ExtractedClaim[]): CodeIngestionState {
  const files = new Set(extractedClaims.map((c) => c.subjectRef))
  return {
    repositoryId: REPO_ID,
    orgId: ORG_ID,
    targetHash: "hash-one",
    roots: ["./"],
    extractedObjects: [
      ...[...files].map((ref) => ({
        kind: "File" as const,
        deduplicationKey: ref,
        name: ref.slice("file:".length),
        summary: "file",
        payload: { path: ref.slice("file:".length) },
      })),
      {
        kind: "Repository",
        deduplicationKey: `repo:${REPO_ID}`,
        name: "demo/repo",
        summary: "repo",
        payload: { gitUrl: "https://github.com/demo/repo.git" },
      },
    ],
    extractedClaims,
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }
}

async function dedup(extractedClaims: ExtractedClaim[]) {
  return withLogger(createLogger({ test: "dedup-no-refetch" }), () =>
    withOrgIdContext({ id: ORG_ID, slug: "dedup-no-refetch" }, () =>
      withOrgDbContext(ORG_ID, () =>
        deduplicateAndStore(state(extractedClaims)),
      ),
    ),
  )
}

async function storedCounts() {
  const db = getSystemDb()
  const storedClaims = await db
    .select({ id: claims.id })
    .from(claims)
    .where(eq(claims.orgId, ORG_ID))
  const storedEvidence = await db
    .select({ id: claimEvidence.id })
    .from(claimEvidence)
    .innerJoin(claims, eq(claimEvidence.claimId, claims.id))
    .where(eq(claims.orgId, ORG_ID))
  return { claims: storedClaims.length, evidence: storedEvidence.length }
}

describe.skipIf(!connectionString)(
  "deduplicateAndStore without claim-id refetch (Postgres)",
  () => {
    beforeAll(async () => {
      if (!connectionString) return
      initDb(connectionString)
      await getSystemDb().insert(repositories).values({
        id: REPO_ID,
        orgId: ORG_ID,
        name: "demo/repo",
        gitUrl: "https://github.com/demo/repo.git",
      })
    })

    afterAll(async () => {
      if (!connectionString) return
      try {
        const db = getSystemDb()
        const claimIds = (
          await db
            .select({ id: claims.id })
            .from(claims)
            .where(eq(claims.orgId, ORG_ID))
        ).map((row) => row.id)
        if (claimIds.length > 0) {
          await db
            .delete(claimEvidence)
            .where(inArray(claimEvidence.claimId, claimIds))
        }
        await db.delete(claims).where(eq(claims.orgId, ORG_ID))
        await db.delete(objects).where(eq(objects.orgId, ORG_ID))
        await db.delete(repositories).where(eq(repositories.orgId, ORG_ID))
      } finally {
        await closeDb().catch(() => undefined)
      }
    })

    it("keeps the last sourceId when same-run observations share a logical key", async () => {
      const first = fileClaim("src/index.ts")
      first.sourceId = "identifyAPIs:src/index.ts"
      const last = fileClaim("src/index.ts")
      last.sourceId = "identifyAPIs:src/index.ts:hash-one"

      await dedup([first, last])
      const rows = await getSystemDb()
        .select({ sourceId: claimEvidence.sourceId })
        .from(claimEvidence)
        .innerJoin(claims, eq(claimEvidence.claimId, claims.id))
        .where(eq(claims.orgId, ORG_ID))

      expect(rows).toEqual([{ sourceId: "identifyAPIs:src/index.ts:hash-one" }])
    })

    it("stores 66k duplicate extracted claims as one projected claim", async () => {
      const copies = Array.from({ length: OVER_BIND_LIMIT }, () =>
        fileClaim("src/index.ts"),
      )
      const started = Date.now()
      const result = await dedup(copies)
      const elapsedMs = Date.now() - started
      const counts = await storedCounts()

      expect(counts.claims).toBe(1)
      expect(counts.evidence).toBe(1)
      expect(result.claimsForProjection).toHaveLength(1)
      expect(elapsedMs).toBeLessThan(10_000)
      console.info(
        `dedup-no-refetch 66k-dups: ${elapsedMs}ms, projection=${result.claimsForProjection?.length}`,
      )
    }, 120_000)

    it("re-observes 600 unique triples without a claim-id refetch", async () => {
      const unique = Array.from({ length: UNIQUE_TRIPLES }, (_, i) =>
        fileClaim(`src/f${i}.ts`),
      )
      await dedup(unique)
      const started = Date.now()
      const result = await dedup(unique)
      const elapsedMs = Date.now() - started
      const counts = await storedCounts()

      expect(counts.claims).toBe(UNIQUE_TRIPLES + 1)
      expect(counts.evidence).toBe(UNIQUE_TRIPLES + 1)
      expect(result.claimsForProjection).toHaveLength(UNIQUE_TRIPLES)
      expect(new Set(result.claimsForProjection?.map((c) => c.id)).size).toBe(
        UNIQUE_TRIPLES,
      )
      expect(elapsedMs).toBeLessThan(15_000)
      console.info(
        `dedup-no-refetch 600-reobserve: ${elapsedMs}ms, projection=${result.claimsForProjection?.length}`,
      )
    }, 120_000)
  },
)
