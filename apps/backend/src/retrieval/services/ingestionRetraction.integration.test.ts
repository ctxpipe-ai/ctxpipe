/**
 * Integration tests for purgeRepositoryEvidencePg against a real Postgres.
 * Requires DATABASE_URL pointing at a migrated ctxpipe database.
 *
 * Seeds objects, claims, and claim_evidence, then verifies that deleting
 * evidence for one repository correctly reconciles multi-source claims.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { relations, schema } from "../../db/schema.js"
import { generateObjectId } from "../../lib/id.js"
import { purgeRepositoryEvidencePg } from "./ingestionRetraction.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error(
    "DATABASE_URL required for integration tests (set in .env.local)",
  )
}

const ORG_ID = `org_test_retraction_${Date.now()}`
const REPO_A = generateObjectId("repo")
const REPO_B = generateObjectId("repo")
const CHECKOUT_A = generateObjectId("co")
const CHECKOUT_B = generateObjectId("co")

let pool: Pool
let db: ReturnType<typeof drizzle>

beforeAll(() => {
  pool = new Pool({ connectionString })
  db = drizzle({ client: pool, schema, relations })
})

afterAll(async () => {
  // Clean up seeded data
  await db.delete(repositories).where(eq(repositories.orgId, ORG_ID))
  await db.delete(claims).where(eq(claims.orgId, ORG_ID))
  await db.delete(objects).where(eq(objects.orgId, ORG_ID))
  await pool.end()
})

const objA = generateObjectId("obj")
const objB = generateObjectId("obj")
const objC = generateObjectId("obj")
const claimAB = generateObjectId("clm")
const claimAC = generateObjectId("clm")
const now = new Date()

async function seed() {
  await db.insert(repositories).values([
    {
      id: REPO_A,
      orgId: ORG_ID,
      name: "owner/repo-a",
      gitUrl: "https://github.com/owner/repo-a.git",
    },
    {
      id: REPO_B,
      orgId: ORG_ID,
      name: "owner/repo-b",
      gitUrl: "https://github.com/owner/repo-b.git",
    },
  ])
  await db.insert(repositoryCheckouts).values([
    { id: CHECKOUT_A, repositoryId: REPO_A, checkoutKey: "default" },
    { id: CHECKOUT_B, repositoryId: REPO_B, checkoutKey: "default" },
  ])
  await db.insert(objects).values([
    { id: objA, orgId: ORG_ID, kind: "Service", payload: {} },
    { id: objB, orgId: ORG_ID, kind: "Library", payload: {} },
    { id: objC, orgId: ORG_ID, kind: "InstructionUnit", payload: {} },
  ])
  await db.insert(claims).values([
    {
      id: claimAB,
      orgId: ORG_ID,
      subjectId: objA,
      objectId: objB,
      predicate: "USES_LIBRARY",
      status: "active",
      aggregatedConfidence: 0.9,
      firstObservedAt: now,
      lastObservedAt: now,
    },
    {
      id: claimAC,
      orgId: ORG_ID,
      subjectId: objA,
      objectId: objC,
      predicate: "HAS_INSTRUCTION",
      status: "active",
      aggregatedConfidence: 0.8,
      firstObservedAt: now,
      lastObservedAt: now,
    },
  ])
  // claimAB has evidence from BOTH repos (multi-source)
  // claimAC has evidence from REPO_A only
  await db.insert(claimEvidence).values([
    {
      id: generateObjectId("cev"),
      claimId: claimAB,
      sourceType: "git",
      sourceId: `identifyLibraries:${REPO_A}:main`,
      logicalSourceKey: `identifyLibraries:${REPO_A}:src/index.ts`,
      extractionMethod: "llm",
      confidence: 0.9,
      observedAt: now,
    },
    {
      id: generateObjectId("cev"),
      claimId: claimAB,
      sourceType: "git",
      sourceId: `identifyLibraries:${REPO_B}:main`,
      logicalSourceKey: `identifyLibraries:${REPO_B}:lib/util.ts`,
      extractionMethod: "llm",
      confidence: 0.85,
      observedAt: now,
    },
    {
      id: generateObjectId("cev"),
      claimId: claimAC,
      sourceType: "git",
      sourceId: `extractIU:${REPO_A}:main`,
      logicalSourceKey: `extractIU:${REPO_A}:README.md`,
      extractionMethod: "deterministic",
      confidence: 0.8,
      observedAt: now,
    },
  ])
}

async function countEvidence(claimId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(claimEvidence)
    .where(eq(claimEvidence.claimId, claimId))
  return row?.c ?? 0
}

async function claimExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: claims.id })
    .from(claims)
    .where(eq(claims.id, id))
  return rows.length > 0
}

async function objectExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: objects.id })
    .from(objects)
    .where(eq(objects.id, id))
  return rows.length > 0
}

describe("purgeRepositoryEvidencePg (integration)", () => {
  beforeEach(async () => {
    // Clean then re-seed
    await db.delete(claims).where(eq(claims.orgId, ORG_ID))
    await db.delete(objects).where(eq(objects.orgId, ORG_ID))
    await db.delete(repositories).where(eq(repositories.orgId, ORG_ID))
    await seed()
  })

  it("removes repo-A evidence, keeps repo-B evidence, recomputes multi-source claim", async () => {
    const { stats, graphEffects } = await purgeRepositoryEvidencePg(db, {
      orgId: ORG_ID,
      repositoryId: REPO_A,
    })

    expect(stats.deletedEvidenceRows).toBe(2)
    expect(stats.claimsUpdated).toBe(1)
    expect(stats.claimsDeleted).toBe(1)

    // claimAB kept (has repo-B evidence remaining)
    expect(await claimExists(claimAB)).toBe(true)
    expect(await countEvidence(claimAB)).toBe(1)

    // claimAC deleted (only had repo-A evidence)
    expect(await claimExists(claimAC)).toBe(false)
    expect(await countEvidence(claimAC)).toBe(0)

    // graphEffects
    expect(graphEffects.refreshedClaimIds).toContain(claimAB)
    expect(graphEffects.deletedClaimIds).toContain(claimAC)

    // objC should be orphaned (was only used by claimAC)
    expect(graphEffects.deletedObjectIds).toContain(objC)
    expect(await objectExists(objC)).toBe(false)

    // objA and objB still referenced by claimAB
    expect(await objectExists(objA)).toBe(true)
    expect(await objectExists(objB)).toBe(true)
  })

  it("is a no-op for a repository with no evidence", async () => {
    const fakeRepoId = generateObjectId("repo")
    const { stats } = await purgeRepositoryEvidencePg(db, {
      orgId: ORG_ID,
      repositoryId: fakeRepoId,
    })
    expect(stats.deletedEvidenceRows).toBe(0)
    expect(stats.claimsUpdated).toBe(0)
    expect(stats.claimsDeleted).toBe(0)
  })

  it("cascade deletes evidence when claims are deleted directly", async () => {
    const evidenceBefore = await countEvidence(claimAB)
    expect(evidenceBefore).toBe(2)

    await db.delete(claims).where(eq(claims.id, claimAB))

    expect(await countEvidence(claimAB)).toBe(0)
  })
})
