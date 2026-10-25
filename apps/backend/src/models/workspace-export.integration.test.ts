import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { claims } from "../db/schema/claims.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import { orgFirstWorkspaces, workspaces } from "../db/schema/workspaces.js"
import { planKnowledgeProjection } from "../domain/workspaces/migration-export.js"
import { generateObjectId } from "../lib/id.js"
import { loadKnowledgeProjectionSource } from "./workspace-export.js"

/*
 * Hydrate reads the main-era knowledge of one Workspace with a SQL filter,
 * not all rows of the org. The filter must give the same projection as the
 * full read of upgrade step 1, also for a Workspace that is not the first.
 */

const org = { id: generateObjectId("org"), slug: "" }
org.slug = org.id
const first = generateObjectId("ws")
const second = generateObjectId("ws")
const repo = {
  // No Workspace has this repository: the first Workspace gets it.
  shared: generateObjectId("repo"),
  // The repository of the second Workspace.
  own: generateObjectId("repo"),
}
const object = {
  sharedService: generateObjectId("obj"),
  sharedLibrary: generateObjectId("obj"),
  ownService: generateObjectId("obj"),
  ownLibrary: generateObjectId("obj"),
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  initDb(databaseUrl)
  await getSystemDb().insert(organizations).values({
    id: org.id,
    slug: org.slug,
    name: "Scoped knowledge read",
    createdAt: new Date(),
  })
  await withOrgDbContext(org.id, async (db) => {
    await db.insert(workspaces).values(
      [first, second].map((id, i) => ({
        id,
        orgId: org.id,
        slug: `scoped-${i}-${org.id}`,
        displayName: `Scoped ${i}`,
        workspaceRepositoryUrl: `https://github.com/example/context-${i}-${org.id}`,
      })),
    )
    await db.insert(repositories).values([
      {
        id: repo.shared,
        orgId: org.id,
        name: "shared",
        gitUrl: "https://github.com/example/shared.git",
      },
      {
        id: repo.own,
        orgId: org.id,
        name: "context-1",
        gitUrl: `https://github.com/example/context-1-${org.id}.git`,
      },
    ])
    await db.insert(orgFirstWorkspaces).values({
      orgId: org.id,
      workspaceId: first,
      sourceRepositoryId: repo.shared,
    })
    await db.insert(objects).values([
      {
        id: object.sharedService,
        orgId: org.id,
        kind: "Service",
        deduplicationKey: `svc:${repo.shared}:billing`,
        payload: { name: "Billing", summary: "Sends invoices." },
      },
      {
        id: object.sharedLibrary,
        orgId: org.id,
        kind: "Library",
        deduplicationKey: `lib:${repo.shared}:ledger`,
        payload: { name: "Ledger", summary: "Keeps the books." },
      },
      {
        id: object.ownService,
        orgId: org.id,
        kind: "Service",
        deduplicationKey: `svc:${repo.own}:checkout`,
        payload: { name: "Checkout", summary: "Takes the payment." },
      },
      {
        id: object.ownLibrary,
        orgId: org.id,
        kind: "Library",
        deduplicationKey: `lib:${repo.own}:cart`,
        payload: { name: "Cart", summary: "Holds the items." },
      },
    ])
    const claim = (subjectId: string, objectId: string, predicate: string) => ({
      id: generateObjectId("clm"),
      orgId: org.id,
      subjectId,
      objectId,
      predicate,
      aggregatedConfidence: 0.9,
      status: "active",
      firstObservedAt: new Date("2026-01-01T00:00:00Z"),
      lastObservedAt: new Date("2026-01-01T00:00:00Z"),
    })
    await db.insert(claims).values([
      // A link inside the second Workspace.
      claim(object.ownService, object.ownLibrary, "USES"),
      // A link from the second Workspace to the first: dropped.
      claim(object.ownService, object.sharedService, "CALLS"),
      // A link inside the first Workspace.
      claim(object.sharedService, object.sharedLibrary, "USES"),
    ])
  })
})

afterAll(async () => {
  await withOrgDbContext(org.id, async (db) => {
    await db.delete(claims).where(eq(claims.orgId, org.id))
    await db.delete(objects).where(eq(objects.orgId, org.id))
    await db
      .delete(orgFirstWorkspaces)
      .where(eq(orgFirstWorkspaces.orgId, org.id))
    await db.delete(repositories).where(eq(repositories.orgId, org.id))
    await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, org.id))
  await closeDb()
})

async function projection(workspaceId: string, scoped: boolean) {
  const source = await withOrgIdContext(org, () =>
    loadKnowledgeProjectionSource(scoped ? { workspaceId } : null),
  )
  const planned = await planKnowledgeProjection({
    workspaceId,
    firstWorkspaceId: source.firstWorkspaceId,
    workspaceByRepositoryId: source.workspaceByRepositoryId,
    repositoryGitUrlById: source.repositoryGitUrlById,
    objects: source.objects,
    claims: source.claims,
    existingKnowledge: [],
    classifyUnkeyed: async () => "new_name",
  })
  return {
    objectIds: source.objects.map((row) => row.id).sort(),
    files: planned.files,
    droppedLinks: planned.droppedLinks.map((link) => ({
      from: link.from.id,
      predicate: link.predicate,
      to: link.to && {
        id: link.to.id,
        name: (link.to.payload as { name?: string }).name,
      },
    })),
  }
}

it("reads only the rows of a Workspace that is not the first, with the same projection as the full read", async () => {
  const scoped = await projection(second, true)
  const full = await projection(second, false)
  // The rows of the second Workspace, and the target of its dropped link
  // with its name only.
  expect(scoped.objectIds).toEqual(
    [object.ownService, object.ownLibrary, object.sharedService].sort(),
  )
  expect(scoped.files).toEqual(full.files)
  expect(scoped.files.map((file) => file.path).sort()).toEqual([
    "knowledge/libraries/cart.md",
    "knowledge/services/checkout.md",
  ])
  expect(scoped.droppedLinks).toEqual(full.droppedLinks)
  expect(scoped.droppedLinks).toEqual([
    {
      from: object.ownService,
      predicate: "CALLS",
      to: { id: object.sharedService, name: "Billing" },
    },
  ])
})

it("reads the rows of the first Workspace with the same projection as the full read", async () => {
  const scoped = await projection(first, true)
  const full = await projection(first, false)
  expect(scoped.objectIds).toEqual(
    [object.sharedService, object.sharedLibrary].sort(),
  )
  expect(scoped.files).toEqual(full.files)
  expect(scoped.droppedLinks).toEqual(full.droppedLinks)
})
