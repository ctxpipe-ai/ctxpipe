import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import { describeWithDatabase } from "../../../../test/db.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../../db/client.js"
import { organizations } from "../../../db/schema/auth.js"
import { objects } from "../../../db/schema/objects.js"
import { generateObjectId } from "../../../lib/id.js"
import type { ExtractedClaim, ExtractedObject } from "../schemas.js"
import { resolveReferenceClaims } from "./linkLocatedPaths.js"

const connectionString = process.env.DATABASE_URL
const orgId = generateObjectId("org")
const objectId = generateObjectId("obj")

const issue: ExtractedObject = {
  kind: "Issue",
  deduplicationKey: "iss:linear:ENG-1",
  name: "ENG-1",
}

function referenceClaim(subjectRef: string, objectRef: string): ExtractedClaim {
  return {
    subjectRef,
    subjectKind: "Issue",
    objectRef,
    objectKind: "PullRequest",
    predicate: "REFERENCES",
    sourceId: `linearIssue:repo_ctx:x:REFERENCES:${objectRef}:abc`,
    sourceType: "git",
    extractionMethod: "deterministic",
    confidence: 0.9,
  }
}

describeWithDatabase("resolveReferenceClaims graph lookup (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is unset")
    initDb(connectionString)
    await getSystemDb()
      .insert(organizations)
      .values({
        id: orgId,
        name: "linkLocatedPaths graph lookup",
        slug: `link-located-${orgId}`,
        createdAt: new Date(),
      })
    await withOrgDbContext(orgId, (db) =>
      db.insert(objects).values({
        id: objectId,
        orgId,
        kind: "PullRequest",
        deduplicationKey: "prq:repo_api:7",
        payload: {},
      }),
    )
  })

  afterAll(async () => {
    if (!connectionString) return
    await withOrgDbContext(orgId, (db) =>
      db.delete(objects).where(eq(objects.id, objectId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("keeps references to existing graph objects and drops unresolved ones", async () => {
    const nonReference: ExtractedClaim = {
      subjectRef: "svc:repo_api:./",
      subjectKind: "Service",
      objectRef: "repo_api",
      objectKind: "Repository",
      predicate: "IMPLEMENTED_IN",
      sourceId: "extractKind:repo_api:./:abc",
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.9,
    }
    const { claims, summary } = await resolveReferenceClaims({
      orgId,
      objects: [issue],
      claims: [
        nonReference,
        referenceClaim(issue.deduplicationKey, "prq:repo_api:7"),
        referenceClaim(issue.deduplicationKey, "prq:github:acme/other:9"),
      ],
    })
    expect(claims.map((claim) => claim.objectRef)).toEqual([
      "repo_api",
      "prq:repo_api:7",
    ])
    expect(summary).toEqual({ REFERENCES: { kept: 1, dropped: 1, stubbed: 0 } })
  })
})
