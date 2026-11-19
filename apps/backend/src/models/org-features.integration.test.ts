import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { generateObjectId } from "../lib/id.js"
import { getOrgFeature } from "./org-features.js"

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const orgA = generateObjectId("org")
const orgB = generateObjectId("org")
const orgC = generateObjectId("org")

function setFeature(orgId: string, value: string) {
  return withOrgDbContext(orgId, (db) =>
    db
      .insert(orgFeatures)
      .values({ organizationId: orgId, feature: "knowledge_plane", value }),
  )
}

describe("org features (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    initDb(process.env.DATABASE_URL)
    await getSystemDb()
      .insert(organizations)
      .values(
        [orgA, orgB, orgC].map((id, i) => ({
          id,
          name: `Features ${i} ${suffix}`,
          slug: `features-${i}-${suffix}`,
          createdAt: new Date(),
        })),
      )
  })

  afterAll(async () => {
    await getSystemDb()
      .delete(organizations)
      .where(inArray(organizations.id, [orgA, orgB, orgC]))
    await closeDb()
  })

  it("gives off when the org has no row", async () => {
    expect(await getOrgFeature(orgA, "knowledge_plane")).toBe("off")
  })

  it("the worker reads the value of each org by org id, with no session", async () => {
    await setFeature(orgA, "shadow")
    await setFeature(orgB, "on")

    expect(await getOrgFeature(orgA, "knowledge_plane")).toBe("shadow")
    expect(await getOrgFeature(orgB, "knowledge_plane")).toBe("on")
    expect(await getOrgFeature(orgC, "knowledge_plane")).toBe("off")
  })

  it("an org transaction does not see the row of another org", async () => {
    const rows = await withOrgDbContext(orgC, (db) =>
      db.select().from(orgFeatures),
    )
    expect(rows).toEqual([])
  })

  it("gives off for a value that is not permitted", async () => {
    await setFeature(orgC, "maybe")
    expect(await getOrgFeature(orgC, "knowledge_plane")).toBe("off")
  })
})
