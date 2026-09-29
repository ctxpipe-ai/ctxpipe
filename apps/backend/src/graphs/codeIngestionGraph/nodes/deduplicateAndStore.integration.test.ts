/**
 * Dedup store against real Postgres. The n8n ingest died on an unchunked
 * `claims.id IN (...)` with 97k binds (Postgres max 65535).
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

const ORG_ID = `org_test_dedup_in_${Date.now()}`
const REPO_ID = generateObjectId("repo")
/** One past Postgres's 65535 bind cap if the IN list is not uniqued. */
const OVER_BIND_LIMIT = 66_000

function extractedClaim(): ExtractedClaim {
  return {
    subjectRef: "file:src/index.ts",
    subjectKind: "File",
    objectRef: `repo:${REPO_ID}`,
    objectKind: "Repository",
    predicate: "PART_OF",
    sourceId: "identifyAPIs:src/index.ts:hash-one",
    sourceType: "git",
    extractionMethod: "deterministic",
    confidence: 0.9,
  }
}

function state(extractedClaims: ExtractedClaim[]): CodeIngestionState {
  return {
    repositoryId: REPO_ID,
    orgId: ORG_ID,
    targetHash: "hash-one",
    roots: ["./"],
    extractedObjects: [
      {
        kind: "File",
        deduplicationKey: "file:src/index.ts",
        name: "index.ts",
        summary: "entry",
        payload: { path: "src/index.ts" },
      },
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
  return withLogger(createLogger({ test: "dedup-in-chunk" }), () =>
    withOrgIdContext({ id: ORG_ID, slug: "dedup-in-chunk" }, () =>
      withOrgDbContext(ORG_ID, () =>
        deduplicateAndStore(state(extractedClaims)),
      ),
    ),
  )
}

describe.skipIf(!connectionString)(
  "deduplicateAndStore claim IN chunking (Postgres)",
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

    it("stores 66k duplicate extracted claims without exceeding the bind cap", async () => {
      const copies = Array.from({ length: OVER_BIND_LIMIT }, () =>
        extractedClaim(),
      )
      const result = await dedup(copies)

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

      expect(storedClaims).toHaveLength(1)
      expect(storedEvidence).toHaveLength(1)
      expect(new Set(result.claimsForProjection?.map((c) => c.id)).size).toBe(1)
    }, 120_000)
  },
)
