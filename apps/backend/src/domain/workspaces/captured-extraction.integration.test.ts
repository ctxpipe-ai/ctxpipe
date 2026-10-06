import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryExtractionCaptures as captures } from "../../db/schema/repository_extraction_captures.js"
import { InvalidExtractionCaptureError } from "../../models/repository-extraction-captures.js"
import { storeTestExtraction } from "../../test/extraction-capture-fixture.js"
import { planStoredExtraction } from "./captured-extraction.js"
import type { WorkspaceExtraction } from "./extraction.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_captured_extraction_${suffix}`
const repositoryId = `repo_test_captured_extraction_${suffix}`
const repositoryUrl = `https://fixture.invalid/${repositoryId}.git`

function storeExtraction(): Promise<WorkspaceExtraction> {
  return storeTestExtraction(orgId, {
    repositoryId,
    repositoryUrl,
    sourceSha: "a".repeat(40),
    objects: [{ kind: "Service", deduplicationKey: `svc:${repositoryId}:./` }],
    claims: [
      {
        subjectRef: repositoryId,
        objectRef: `svc:${repositoryId}:./`,
        predicate: "HAS_SERVICE",
        confidence: 0.9,
        sourceId: `extractKind:${repositoryId}:./`,
      },
    ],
  })
}

function storedRoots(extraction: WorkspaceExtraction) {
  return withOrgDbContext(orgId, (db) =>
    db
      .select({ root: captures.root })
      .from(captures)
      .where(eq(captures.scope, extraction.capture.scope)),
  )
}

function plan(extraction: WorkspaceExtraction, agents: string) {
  return planStoredExtraction({
    orgId,
    extraction,
    workspaceId: `ws_test_captured_extraction_${suffix}`,
    workspaceRepositoryUrl: repositoryUrl,
    existingKnowledge: [{ path: "AGENTS.md", content: agents }],
    knownKnowledgePaths: {},
    stampImportKey: false,
  })
}

describe("planStoredExtraction (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, (db) =>
      db.delete(repositories).where(eq(repositories.id, repositoryId)),
    )
    await closeDb()
  })

  it("plans a valid capture", async () => {
    const extraction = await storeExtraction()
    const planned = await plan(extraction, "# App\n")
    expect(planned.files.map((file) => file.path)).toContain("AGENTS.md")
  })

  it("deletes the rows when a stored row is not a valid capture", async () => {
    const extraction = await storeExtraction()
    await withOrgDbContext(orgId, (db) =>
      db
        .update(captures)
        .set({ objects: [{ kind: "Service" }] })
        .where(eq(captures.scope, extraction.capture.scope)),
    )
    await expect(plan(extraction, "# App\n")).rejects.toBeInstanceOf(
      InvalidExtractionCaptureError,
    )
    expect(await storedRoots(extraction)).toEqual([])
  })

  it("keeps the rows when a workspace file makes the plan fail", async () => {
    const extraction = await storeExtraction()
    await expect(
      plan(extraction, "---\nclaims: not-a-list\n---\n# App\n"),
    ).rejects.toThrow(/malformed knowledge claims/)
    expect(await storedRoots(extraction)).toEqual([{ root: "." }])
  })

  it("keeps the rows when the database fails", async () => {
    const extraction = await storeExtraction()
    // Postgres rejects a NUL byte in a text parameter.
    const broken = {
      ...extraction,
      capture: { ...extraction.capture, roots: [".", "\u0000"] },
    }
    await expect(plan(broken, "# App\n")).rejects.toThrow(/Failed query/)
    expect(await storedRoots(extraction)).toEqual([{ root: "." }])
  })
})
