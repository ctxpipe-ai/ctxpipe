/**
 * Evidence lifecycle against a real Postgres (ADR-033 acceptance):
 *   1. dedup twice at different commits → still one evidence row per claim
 *   2. delete the mirrored file, partial ingest → the PR's claims are retracted
 *   3. re-ingest, delete the source repository → purge removes them too
 *   4. a full ingest sweeps evidence that the new commit did not re-observe
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
import { repositoryCheckouts } from "../../../db/schema/repository_checkouts.js"
import { computeKnowledgeGraphQuality } from "../../../domain/knowledgeGraphQuality.js"
import { generateObjectId } from "../../../lib/id.js"
import { createLogger, withLogger } from "../../../observability/logger.js"
import {
  purgeRepositoryEvidencePg,
  retractConnectorPrefixInstructionUnitsPg,
  retractIngestionForDiffPg,
  retractUnobservedRepositoryEvidencePg,
} from "../../../retrieval/services/ingestionRetraction.js"
import {
  parseGithubPullRequestMarkdown,
  renderGithubPullRequest,
} from "../../../services/github/pull-request-mirror/converter.js"
import { buildGithubPullRequestGraph } from "../../../services/github/pull-request-mirror/graph.js"
import type { CodeIngestionState } from "../schemas.js"
import { deduplicateAndStore } from "./deduplicateAndStore.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../../.env.local") })

const connectionString = process.env.DATABASE_URL

const ORG_ID = `org_test_evidence_${Date.now()}`
const CONTEXT_REPO = generateObjectId("repo")
const SOURCE_REPO = generateObjectId("repo")

const snapshot = {
  id: 1042,
  number: 42,
  repository: "acme/api",
  url: "https://github.com/acme/api/pull/42",
  title: "Split user create",
  body: "Move logic out of the handler.",
  state: "closed",
  merged: true,
  draft: false,
  author: { login: "alice", type: "human" },
  base: { ref: "main", sha: "a" },
  head: { ref: "f", sha: "b" },
  reviewDecision: "APPROVED",
  labels: [],
  requestedReviewers: [],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-02T00:00:00.000Z",
  mergedAt: "2026-03-02T11:00:00.000Z",
  files: [
    { path: "src/http/createUser.ts", status: "modified" },
    { path: "src/domain/user.ts", status: "added" },
  ],
  reviews: [],
  comments: [],
  requiredChecks: [],
} satisfies Parameters<typeof renderGithubPullRequest>[0]

const mirrored = renderGithubPullRequest(snapshot)
/** Same pull request, but `src/domain/user.ts` is no longer part of it. */
const mirroredReduced = renderGithubPullRequest({
  ...snapshot,
  files: snapshot.files.slice(0, 1),
})

function stateAt(
  targetHash: string,
  content: string = mirrored.content,
): CodeIngestionState {
  const parsed = parseGithubPullRequestMarkdown(content)
  if (!parsed) throw new Error("fixture did not parse")
  const graph = buildGithubPullRequestGraph({
    parsed,
    markdownPath: mirrored.path,
    targetHash,
    contextRepositoryId: CONTEXT_REPO,
    sourceRepositoryId: SOURCE_REPO,
  })
  return {
    repositoryId: CONTEXT_REPO,
    orgId: ORG_ID,
    targetHash,
    roots: ["./"],
    extractedObjects: graph.extractedObjects,
    extractedClaims: graph.extractedClaims,
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }
}

async function dedup(targetHash: string, content?: string) {
  return withLogger(createLogger({ test: "evidence-lifecycle" }), () =>
    withOrgIdContext({ id: ORG_ID, slug: "evidence-lifecycle" }, () =>
      withOrgDbContext(ORG_ID, () =>
        deduplicateAndStore(stateAt(targetHash, content)),
      ),
    ),
  )
}

async function evidenceSourceIds(): Promise<string[]> {
  const rows = await getSystemDb()
    .select({ sourceId: claimEvidence.sourceId })
    .from(claimEvidence)
    .innerJoin(claims, eq(claimEvidence.claimId, claims.id))
    .where(eq(claims.orgId, ORG_ID))
  return rows.map((row) => row.sourceId).sort()
}

async function counts() {
  const db = getSystemDb()
  const [claimRows, evidenceRows, objectRows] = await Promise.all([
    db.select({ id: claims.id }).from(claims).where(eq(claims.orgId, ORG_ID)),
    db
      .select({ id: claimEvidence.id })
      .from(claimEvidence)
      .innerJoin(claims, eq(claimEvidence.claimId, claims.id))
      .where(eq(claims.orgId, ORG_ID)),
    db
      .select({ kind: objects.kind })
      .from(objects)
      .where(eq(objects.orgId, ORG_ID)),
  ])
  return {
    claims: claimRows.length,
    evidence: evidenceRows.length,
    objects: objectRows.length,
    kinds: objectRows.map((row) => row.kind).sort(),
  }
}

describe.skipIf(!connectionString)("evidence lifecycle (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) return
    initDb(connectionString)
    const db = getSystemDb()
    await db.insert(repositories).values([
      {
        id: CONTEXT_REPO,
        orgId: ORG_ID,
        name: "acme/ctx",
        gitUrl: "https://github.com/acme/ctx.git",
      },
      {
        id: SOURCE_REPO,
        orgId: ORG_ID,
        name: "acme/api",
        gitUrl: "https://github.com/acme/api.git",
      },
    ])
    await db.insert(repositoryCheckouts).values([
      {
        id: generateObjectId("co"),
        repositoryId: CONTEXT_REPO,
        checkoutKey: "default",
      },
      {
        id: generateObjectId("co"),
        repositoryId: SOURCE_REPO,
        checkoutKey: "default",
      },
    ])
  })

  afterAll(async () => {
    if (!connectionString) return
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
    await closeDb()
  })

  it("keeps one evidence row per claim across ingests at different commits", async () => {
    await dedup("hash-one")
    const first = await counts()
    expect(first.claims).toBeGreaterThan(0)
    expect(first.evidence).toBe(first.claims)
    expect(first.kinds).toEqual(["File", "File", "PullRequest"])

    await dedup("hash-one")
    await dedup("hash-two")
    const after = await counts()
    expect(after.claims).toBe(first.claims)
    expect(after.evidence).toBe(first.claims)
    // Re-observed evidence moves to the latest commit instead of staying pinned
    // to the first one; a later full-ingest sweep relies on this.
    for (const sourceId of await evidenceSourceIds()) {
      expect(sourceId.endsWith(":hash-two")).toBe(true)
    }

    // Change edges and TARGETS are dated at merge; containment is timeless.
    const validity = await getSystemDb()
      .select({ predicate: claims.predicate, validFrom: claims.validFrom })
      .from(claims)
      .where(eq(claims.orgId, ORG_ID))
    for (const row of validity) {
      if (row.predicate === "PART_OF") {
        expect(row.validFrom).toBeNull()
        continue
      }
      expect(row.validFrom?.toISOString().slice(0, 10)).toBe("2026-03-02")
    }
  })

  it("retracts the pull request's claims when its mirrored file is deleted", async () => {
    await withOrgDbContext(ORG_ID, async (db) => {
      const { stats } = await retractIngestionForDiffPg(db, {
        orgId: ORG_ID,
        repositoryId: CONTEXT_REPO,
        ingestMode: "partial",
        changedPaths: [],
        deletedPaths: [mirrored.path],
        renames: [],
      })
      expect(stats.deletedEvidenceRows).toBeGreaterThan(0)
      expect(stats.claimsDeleted).toBe(stats.deletedEvidenceRows)
    })
    const after = await counts()
    expect(after.claims).toBe(0)
    expect(after.evidence).toBe(0)
    expect(after.objects).toBe(0)
  })

  it("purges the same claims when the source repository is removed", async () => {
    await dedup("hash-three")
    expect((await counts()).claims).toBeGreaterThan(0)
    await withOrgDbContext(ORG_ID, async (db) => {
      const { stats } = await purgeRepositoryEvidencePg(db, {
        orgId: ORG_ID,
        repositoryId: SOURCE_REPO,
      })
      expect(stats.claimsDeleted).toBeGreaterThan(0)
    })
    const after = await counts()
    expect(after.claims).toBe(0)
    expect(after.objects).toBe(0)
  })

  it("removes legacy connector-derived instruction units and reports it in the quality metrics", async () => {
    const db = getSystemDb()
    const stubService = generateObjectId("obj")
    const legacyUnit = generateObjectId("obj")
    const legacyClaim = generateObjectId("clm")
    const now = new Date()
    await db.insert(objects).values([
      {
        id: stubService,
        orgId: ORG_ID,
        kind: "Service",
        deduplicationKey: `svc:${CONTEXT_REPO}:./`,
        payload: { name: "root" },
      },
      {
        id: legacyUnit,
        orgId: ORG_ID,
        kind: "InstructionUnit",
        deduplicationKey: `inu:${CONTEXT_REPO}:./:legacy`,
        payload: { name: "Fake rule", path: "linear/issues/eng-1--1.md" },
      },
    ])
    await db.insert(claims).values({
      id: legacyClaim,
      orgId: ORG_ID,
      subjectId: stubService,
      objectId: legacyUnit,
      predicate: "HAS_INSTRUCTION",
      status: "active",
      aggregatedConfidence: 0.7,
      firstObservedAt: now,
      lastObservedAt: now,
    })
    await db.insert(claimEvidence).values({
      id: generateObjectId("cev"),
      claimId: legacyClaim,
      sourceType: "git",
      sourceId: `extractInstructionUnits:${CONTEXT_REPO}:inu:${CONTEXT_REPO}:./:legacy:hash-legacy`,
      logicalSourceKey: `extractInstructionUnits:${CONTEXT_REPO}:inu:${CONTEXT_REPO}:./:legacy`,
      extractionMethod: "llm",
      confidence: 0.7,
      observedAt: now,
    })

    const before = await withOrgDbContext(ORG_ID, (tx) =>
      computeKnowledgeGraphQuality(tx, ORG_ID),
    )
    expect(before.connectorInstructionUnits).toBe(1)
    expect(before.kinds).toMatchObject({ InstructionUnit: 1, Service: 1 })

    const result = await withOrgDbContext(ORG_ID, (tx) =>
      retractConnectorPrefixInstructionUnitsPg(tx, { orgId: ORG_ID }),
    )
    expect(result.unitsDeleted).toBe(1)
    expect(result.stats.claimsDeleted).toBe(1)
    expect(result.stats.deletedEvidenceRows).toBe(1)
    expect(result.stats.orphanObjectsDeleted).toBe(1)

    const after = await withOrgDbContext(ORG_ID, (tx) =>
      computeKnowledgeGraphQuality(tx, ORG_ID),
    )
    expect(after.connectorInstructionUnits).toBe(0)
    expect(after.totalObjects).toBe(0)
    expect(after.totalClaims).toBe(0)
    expect(after.joinDensity).toBe(0)
  })

  it("reports join density inputs for a single-extractor graph", async () => {
    await dedup("hash-four")
    const quality = await withOrgDbContext(ORG_ID, (tx) =>
      computeKnowledgeGraphQuality(tx, ORG_ID),
    )
    expect(quality.multiSourceObjects).toBe(0)
    expect(quality.evidenceRowsPerClaim).toBe(1)
    expect(quality.predicates).toMatchObject({
      TARGETS: 1,
      MODIFIED: 1,
      ADDED: 1,
    })
    expect(quality.kinds).toMatchObject({ PullRequest: 1, File: 2 })
  })

  it("sweeps evidence a full ingest did not re-observe, keeping other repositories' proofs", async () => {
    await dedup("hash-five")
    const before = await counts()
    expect(before.kinds).toEqual(["File", "File", "PullRequest"])

    // Evidence produced by another repository's ingestion that merely mentions
    // this repository (PR mirror style: `extractor:<producer>:<mentioned>:…`).
    const db = getSystemDb()
    const foreignSubject = generateObjectId("obj")
    const foreignObject = generateObjectId("obj")
    const foreignClaim = generateObjectId("clm")
    const now = new Date()
    await db.insert(objects).values([
      {
        id: foreignSubject,
        orgId: ORG_ID,
        kind: "Service",
        deduplicationKey: `svc:${SOURCE_REPO}:./`,
        payload: { name: "api" },
      },
      {
        id: foreignObject,
        orgId: ORG_ID,
        kind: "Repository",
        deduplicationKey: `repo-key:${SOURCE_REPO}`,
        payload: { name: "acme/api" },
      },
    ])
    await db.insert(claims).values({
      id: foreignClaim,
      orgId: ORG_ID,
      subjectId: foreignSubject,
      objectId: foreignObject,
      predicate: "IMPLEMENTED_IN",
      status: "active",
      aggregatedConfidence: 0.9,
      firstObservedAt: now,
      lastObservedAt: now,
    })
    const foreignSourceId = `extractKind:${SOURCE_REPO}:${CONTEXT_REPO}:./:hash-old`
    await db.insert(claimEvidence).values({
      id: generateObjectId("cev"),
      claimId: foreignClaim,
      sourceType: "git",
      sourceId: foreignSourceId,
      logicalSourceKey: `extractKind:${SOURCE_REPO}:${CONTEXT_REPO}:./`,
      extractionMethod: "deterministic",
      confidence: 0.9,
      observedAt: now,
    })

    // A re-index at the unchanged tip (same hash!) whose extraction no longer
    // yields src/domain/user.ts: its ADDED and PART_OF claims are not
    // re-observed. Hash tails cannot tell these apart; observedAt can.
    const runStartedAt = new Date()
    await dedup("hash-five", mirroredReduced.content)

    const sweep = await withOrgDbContext(ORG_ID, (tx) =>
      retractUnobservedRepositoryEvidencePg(tx, {
        orgId: ORG_ID,
        repositoryId: CONTEXT_REPO,
        observedBefore: runStartedAt,
      }),
    )
    expect(sweep.stats.deletedEvidenceRows).toBe(2)
    expect(sweep.stats.claimsDeleted).toBe(2)
    expect(sweep.stats.orphanObjectsDeleted).toBe(1)
    expect(sweep.graphEffects.deletedClaimIds).toHaveLength(2)
    expect(sweep.graphEffects.deletedObjectIds).toHaveLength(1)

    const after = await counts()
    expect(after.claims).toBe(before.claims - 2 + 1)
    expect(after.kinds).toEqual([
      "File",
      "PullRequest",
      "Repository",
      "Service",
    ])
    const sourceIds = await evidenceSourceIds()
    expect(sourceIds).toContain(foreignSourceId)
    for (const sourceId of sourceIds.filter((id) => id !== foreignSourceId)) {
      expect(sourceId.endsWith(":hash-five")).toBe(true)
    }

    // Idempotent: everything left was touched by the run.
    const again = await withOrgDbContext(ORG_ID, (tx) =>
      retractUnobservedRepositoryEvidencePg(tx, {
        orgId: ORG_ID,
        repositoryId: CONTEXT_REPO,
        observedBefore: runStartedAt,
      }),
    )
    expect(again.stats.deletedEvidenceRows).toBe(0)
  })
})
