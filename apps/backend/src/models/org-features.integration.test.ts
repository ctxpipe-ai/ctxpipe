import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { generateObjectId } from "../lib/id.js"
import { setOrgFeature } from "./org-features.js"

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

  it("refuses each feature, also the ended knowledge_plane rollout, and writes nothing", async () => {
    await expect(setOrgFeature(orgB, "knowledge_plane", "on")).rejects.toThrow(
      /"knowledge_plane" is not a known feature/,
    )
    await expect(setOrgFeature(orgB, "no_such_feature", "on")).rejects.toThrow(
      /not a known feature/,
    )
    expect(
      await withOrgDbContext(orgB, (db) => db.select().from(orgFeatures)),
    ).toEqual([])
  })
})
