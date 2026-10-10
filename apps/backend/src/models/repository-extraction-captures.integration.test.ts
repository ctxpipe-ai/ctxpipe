import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, initDb, withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryExtractionCaptures as captures } from "../db/schema/repository_extraction_captures.js"
import type { ExtractedCapture } from "../graphs/codeIngestionGraph/schemas.js"
import {
  captureRowRoot,
  deleteExtractionCapture,
  deleteRepositoryExtractionCaptures,
  type ExtractionCaptureKey,
  loadExtractionCapture,
  storedRootCapture,
  storeRootCapture,
} from "./repository-extraction-captures.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_extraction_captures_${suffix}`
const repositoryId = `repo_test_extraction_captures_${suffix}`
const full: ExtractionCaptureKey = {
  orgId,
  repositoryId,
  sourceSha: "a".repeat(40),
  scope: "full",
  extractorVersion: 1,
}

const capture: ExtractedCapture = {
  extractedObjects: [
    {
      kind: "Service",
      deduplicationKey: `svc:${repositoryId}:billing`,
      name: "Billing",
      // The extractors do not cap every summary, so a stored row can hold a long one.
      summary: "Handles invoices. ".repeat(40),
    },
  ],
  extractedClaims: [
    {
      subjectRef: repositoryId,
      subjectKind: "Repository",
      objectRef: `svc:${repositoryId}:billing`,
      objectKind: "Service",
      predicate: "HAS_SERVICE",
      sourceId: `extractKind:${repositoryId}:billing`,
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.9,
      provenance: { path: "billing/package.json" },
    },
  ],
}

function rows() {
  return withOrgDbContext(orgId, (db) =>
    db
      .select({ scope: captures.scope, root: captures.root })
      .from(captures)
      .where(eq(captures.repositoryId, repositoryId)),
  )
}

describe("repository extraction captures (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await withOrgDbContext(orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId,
        name: repositoryId,
        gitUrl: `https://fixture.invalid/${repositoryId}`,
      }),
    )
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, (db) =>
      db.delete(repositories).where(eq(repositories.id, repositoryId)),
    )
    await closeDb()
  })

  it("reuses a root only under the same scope and extractor version", async () => {
    await deleteRepositoryExtractionCaptures(full, new Date())
    expect(await storeRootCapture(full, "billing", capture, 0)).toEqual({
      objects: 1,
      claims: 1,
      skippedFiles: 0,
    })
    expect(await storedRootCapture(full, "billing")).toEqual({
      objects: 1,
      claims: 1,
      skippedFiles: 0,
    })
    const partial = { ...full, scope: `since:${"b".repeat(40)}` }
    expect(await storedRootCapture(partial, "billing")).toBeNull()
    expect(
      await storedRootCapture({ ...full, extractorVersion: 2 }, "billing"),
    ).toBeNull()
    await storeRootCapture(partial, "web", capture, 0)
    expect(await storedRootCapture(full, "web")).toBeNull()
    expect(await loadExtractionCapture(full, ["billing"])).toEqual(capture)
  })

  it("keeps the row of the root that reads the repo-root files apart", async () => {
    await deleteRepositoryExtractionCaptures(full, new Date())
    expect(captureRowRoot("billing", false)).toBe("billing")
    await storeRootCapture(full, "billing", capture, 0)
    // A plain row may lack the repo-root files, so the owner does not reuse it.
    expect(
      await storedRootCapture(full, captureRowRoot("billing", true)),
    ).toBeNull()
  })

  it("loads the plain row of a run that started before the owner row name", async () => {
    await deleteRepositoryExtractionCaptures(full, new Date())
    await storeRootCapture(full, "billing", capture, 0)
    expect(
      await loadExtractionCapture(full, [captureRowRoot("billing", true)]),
    ).toEqual(capture)
  })

  it("does not reuse a root whose extractor skipped files", async () => {
    await deleteRepositoryExtractionCaptures(full, new Date())
    await storeRootCapture(full, "billing", capture, 2)
    expect(await storedRootCapture(full, "billing")).toBeNull()
    // The run that stored it still publishes it.
    expect(await loadExtractionCapture(full, ["billing"])).toEqual(capture)
  })

  it("keeps old captures when a run stores a root", async () => {
    await deleteRepositoryExtractionCaptures(full, new Date())
    const live = { ...full, sourceSha: "c".repeat(40) }
    await storeRootCapture(live, "billing", capture, 0)
    await withOrgDbContext(orgId, (db) =>
      db
        .update(captures)
        .set({ createdAt: sql`now() - interval '30 days'` })
        .where(eq(captures.sourceSha, live.sourceSha)),
    )
    await storeRootCapture(full, "web", capture, 0)
    expect(await loadExtractionCapture(live, ["billing"])).toEqual(capture)
  })

  it("deletes one key, or every capture of the repository after a publish", async () => {
    await deleteRepositoryExtractionCaptures(full, new Date())
    const partial = { ...full, scope: `since:${"b".repeat(40)}` }
    const older = { ...full, sourceSha: "d".repeat(40) }
    for (const key of [full, partial, older])
      await storeRootCapture(key, "billing", capture, 0)
    await deleteExtractionCapture(partial)
    expect(await rows()).toHaveLength(2)
    await deleteRepositoryExtractionCaptures(full, new Date())
    expect(await rows()).toEqual([])
  })

  it("keeps the captures of a run that started after the publishing run", async () => {
    await deleteRepositoryExtractionCaptures(full, new Date())
    const older = { ...full, sourceSha: "d".repeat(40) }
    await storeRootCapture(older, "billing", capture, 0)
    await storeRootCapture(full, "billing", capture, 0)
    const runStartedAt = new Date(Date.now() + 1000)
    // A run on a new target commit starts while the first run waits to publish.
    const newer = { ...full, sourceSha: "e".repeat(40) }
    await storeRootCapture(newer, "billing", capture, 0)
    await withOrgDbContext(orgId, (db) =>
      db
        .update(captures)
        .set({ createdAt: sql`now() + interval '1 minute'` })
        .where(eq(captures.sourceSha, newer.sourceSha)),
    )
    // The publishing run stores its own root after it starts.
    await withOrgDbContext(orgId, (db) =>
      db
        .update(captures)
        .set({ createdAt: sql`now() + interval '1 minute'` })
        .where(eq(captures.sourceSha, full.sourceSha)),
    )
    await deleteRepositoryExtractionCaptures(full, runStartedAt)
    expect(await loadExtractionCapture(newer, ["billing"])).toEqual(capture)
    expect(await rows()).toHaveLength(1)
  })

  it("fails with a clear error when a stored row is not a valid capture", async () => {
    await deleteRepositoryExtractionCaptures(full, new Date())
    await withOrgDbContext(orgId, (db) =>
      db.execute(sql`
        insert into repository_extraction_captures
          (org_id, repository_id, source_sha, scope, extractor_version, root, objects, claims, skipped_files)
        values (${orgId}, ${repositoryId}, ${full.sourceSha}, ${full.scope}, ${full.extractorVersion},
          'billing', '[{"kind":"Service"}]'::jsonb, '[]'::jsonb, 0)
      `),
    )
    await expect(loadExtractionCapture(full, ["billing"])).rejects.toThrow(
      /Extraction capture of root billing is invalid/,
    )
  })
})
