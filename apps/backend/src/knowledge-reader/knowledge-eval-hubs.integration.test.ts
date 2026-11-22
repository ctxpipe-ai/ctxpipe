import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { highDegreeUnits } from "../../evals/knowledge/runner.js"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  seedKnowledgeUnits,
  seedKnowledgeWorkspace,
} from "../test/knowledge-search-fixture.js"

/*
 * The high-degree units of the hub check of the knowledge eval (CTX-1518,
 * check 4), from the units of the old stack in real Postgres.
 */

const sha = "c".repeat(40)
let seed: SeededOrg
let workspaceId: string

/** A unit with `degree` claims. */
const unit = (name: string, degree: number) => ({
  id: `${workspaceId}_${name}`,
  workspaceId,
  path: `knowledge/${name}.md`,
  title: name,
  updatedAt: "2026-11-01T00:00:00Z",
  body: `# ${name}\n\nText.`,
  claims: Array.from({ length: degree }, (_, index) => ({
    to: `knowledge/services/service-${index}.md`,
    predicate: "INFLUENCES",
  })),
})

describe("the high-degree units of the hub check (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    workspaceId = `ws_hubs_${Date.now()}_${Math.random().toString(36).slice(2)}`
    await seedKnowledgeWorkspace(seed.orgId, workspaceId, sha)
  })

  afterAll(async () => {
    if (!seed) return
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
    )
    await cleanupSeededOrg(seed)
  })

  it("gives the units with at least 10 links and claims, at or above the 99th percentile of the Workspace", async () => {
    const reset = async () => {
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
      )
      await seedKnowledgeWorkspace(seed.orgId, workspaceId, sha)
    }
    // An ADR that links to every service is a hub. A unit with 9 claims is
    // not: the floor is 10.
    await seedKnowledgeUnits(seed.orgId, sha, [
      unit("adr-024", 40),
      unit("adr-002", 12),
      unit("adr-017", 9),
      ...Array.from({ length: 97 }, (_, index) => unit(`note-${index}`, 1)),
    ])
    expect(await highDegreeUnits(seed.orgId, workspaceId)).toEqual(
      new Set(["knowledge/adr-024.md", "knowledge/adr-002.md"]),
    )
    // Where most units link a lot, a unit with 12 claims is not in the top.
    await reset()
    await seedKnowledgeUnits(seed.orgId, sha, [
      unit("adr-002", 12),
      ...Array.from({ length: 10 }, (_, index) => unit(`kep-${index}`, 30)),
    ])
    const hubs = await highDegreeUnits(seed.orgId, workspaceId)
    expect(hubs.size).toBe(10)
    expect(hubs.has("knowledge/adr-002.md")).toBe(false)
    // No unit reaches 10: no hub.
    await reset()
    await seedKnowledgeUnits(seed.orgId, sha, [unit("adr-017", 9)])
    expect(await highDegreeUnits(seed.orgId, workspaceId)).toEqual(new Set())
  })
})
