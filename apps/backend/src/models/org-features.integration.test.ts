import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { generateObjectId } from "../lib/id.js"
import { setOrgFeature } from "./org-features.js"

/*
 * The org features table with no feature (CTX-1712 removed
 * `knowledge_plane`, the only one). The table and its tooling stay for a
 * later feature.
 */

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const orgA = generateObjectId("org")
const orgB = generateObjectId("org")

describe("org features (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    initDb(process.env.DATABASE_URL)
    await getSystemDb()
      .insert(organizations)
      .values(
        [orgA, orgB].map((id, i) => ({
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
      .where(inArray(organizations.id, [orgA, orgB]))
    await closeDb()
  })

  it("an org transaction does not see the row of another org", async () => {
    await withOrgDbContext(orgA, (db) =>
      db.insert(orgFeatures).values({
        organizationId: orgA,
        feature: "isolation_probe",
        value: "on",
      }),
    )
    const rows = await withOrgDbContext(orgB, (db) =>
      db.select().from(orgFeatures),
    )
    expect(rows).toEqual([])
  })

  it("refuses each feature: none is known, also the removed knowledge_plane", async () => {
    for (const feature of ["knowledge_plane", "no_such_feature"])
      await expect(setOrgFeature(orgA, feature, "off")).rejects.toThrow(
        `"${feature}" is not a known feature`,
      )
    expect(
      await withOrgDbContext(orgA, (db) =>
        db
          .select({ feature: orgFeatures.feature })
          .from(orgFeatures)
          .where(inArray(orgFeatures.feature, ["knowledge_plane"])),
      ),
    ).toEqual([])
  })
})
