import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import type {
  ExtractedClaim,
  ExtractedObject,
} from "../graphs/codeIngestionGraph/schemas.js"
import {
  clearIngestionPreview,
  listIngestionPreview,
  recordIngestionPreview,
} from "./ingestion-preview.js"

describeWithDatabase("ingestion preview", () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const orgId = `org_preview_${suffix}`
  const runningId = `repo_preview_running_${suffix}`
  const readyId = `repo_preview_ready_${suffix}`

  const object = (key: string, kind: string, name: string) =>
    ({ kind, deduplicationKey: key, name }) as ExtractedObject
  const claim = (subjectRef: string, objectRef: string): ExtractedClaim => ({
    subjectRef,
    subjectKind: "Service",
    objectRef,
    objectKind: "Database",
    predicate: "READS_FROM",
    sourceId: "src",
    sourceType: "git",
    extractionMethod: "llm",
    confidence: 0.9,
  })

  beforeAll(async () => {
    initDb(process.env.DATABASE_URL ?? "")
    await getSystemDb()
      .insert(organizations)
      .values({
        id: orgId,
        name: "Ingestion preview",
        slug: `preview-${suffix}`.slice(0, 32),
        createdAt: new Date(),
      })
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(repositories).values([
        {
          id: runningId,
          orgId,
          name: `acme/running-${suffix}`,
          gitUrl: `https://github.com/acme/running-${suffix}.git`,
          indexReady: false,
          indexingStatus: "running",
        },
        {
          id: readyId,
          orgId,
          name: `acme/ready-${suffix}`,
          gitUrl: `https://github.com/acme/ready-${suffix}.git`,
          indexReady: true,
          indexingStatus: "ready",
        },
      ])
    })
  })

  afterAll(async () => {
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await withOrgDbContext(orgId, (db) =>
      db.delete(repositories).where(eq(repositories.orgId, orgId)),
    )
    await closeDb()
  })

  it("builds up as extractors report, shows only running repositories, and clears", async () => {
    // Two extractors report; the second repeats a node (a step retry).
    await recordIngestionPreview({
      orgId,
      repositoryId: runningId,
      objects: [object("svc:api", "Service", "api")],
      claims: [],
    })
    await recordIngestionPreview({
      orgId,
      repositoryId: runningId,
      objects: [
        object("svc:api", "Service", "api"),
        object("db:users", "Database", "users"),
      ],
      claims: [claim("svc:api", "db:users"), claim("svc:api", "db:orders")],
    })
    // A finished repository's leftovers never show.
    await recordIngestionPreview({
      orgId,
      repositoryId: readyId,
      objects: [object("svc:old", "Service", "old")],
      claims: [],
    })

    const preview = await listIngestionPreview({ orgId, nodeLimit: 100 })
    expect(preview.nodes.map((node) => node.id).sort()).toEqual([
      "db:orders",
      "db:users",
      "svc:api",
    ])
    expect(preview.nodes.find((node) => node.id === "db:orders")).toMatchObject(
      {
        kind: "Database",
        name: null,
      },
    )
    expect(preview.edges).toHaveLength(2)

    await clearIngestionPreview({ orgId, repositoryId: runningId })
    const cleared = await listIngestionPreview({ orgId, nodeLimit: 100 })
    expect(cleared).toEqual({ nodes: [], edges: [] })
  })
})
