import { inArray, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { generateObjectId } from "../lib/id.js"
import { getOrgFeature, setOrgFeature } from "./org-features.js"

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const orgA = generateObjectId("org")
const orgB = generateObjectId("org")
const orgC = generateObjectId("org")
const orgD = generateObjectId("org")
const orgE = generateObjectId("org")

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
        [orgA, orgB, orgC, orgD, orgE].map((id, i) => ({
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
      .where(inArray(organizations.id, [orgA, orgB, orgC, orgD, orgE]))
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
    await withOrgDbContext(orgB, (db) =>
      db.insert(orgFeatures).values({
        organizationId: orgB,
        feature: "isolation_probe",
        value: "on",
      }),
    )
    const rows = await withOrgDbContext(orgC, (db) =>
      db.select().from(orgFeatures),
    )
    expect(rows).toEqual([])
  })

  it("gives off for a value that is not permitted", async () => {
    await setFeature(orgC, "maybe")
    expect(await getOrgFeature(orgC, "knowledge_plane")).toBe("off")
  })

  it("an operator sets a value, changes it, and a second set with the same value writes nothing", async () => {
    expect(await setOrgFeature(orgD, "knowledge_plane", "shadow")).toEqual({
      previous: "off",
      value: "shadow",
      changed: true,
    })
    expect(await getOrgFeature(orgD, "knowledge_plane")).toBe("shadow")
    const read = () =>
      withOrgDbContext(orgD, (db) => db.select().from(orgFeatures))
    const [first] = await read()

    expect(await setOrgFeature(orgD, "knowledge_plane", "shadow")).toEqual({
      previous: "shadow",
      value: "shadow",
      changed: false,
    })
    expect((await read())[0]?.updatedAt).toEqual(first?.updatedAt)

    expect(await setOrgFeature(orgD, "knowledge_plane", "off")).toEqual({
      previous: "shadow",
      value: "off",
      changed: true,
    })
    expect(await getOrgFeature(orgD, "knowledge_plane")).toBe("off")
    expect(await read()).toHaveLength(1)
  })

  it("refuses a feature or a value that is not permitted, and an org that does not exist", async () => {
    await expect(
      setOrgFeature(orgD, "knowledge_plane", "maybe"),
    ).rejects.toThrow(/not a permitted value/)
    await expect(setOrgFeature(orgD, "no_such_feature", "on")).rejects.toThrow(
      /not a known feature/,
    )
    await expect(
      setOrgFeature(generateObjectId("org"), "knowledge_plane", "shadow"),
    ).rejects.toThrow(/no organization/)
    expect(await getOrgFeature(orgD, "knowledge_plane")).toBe("off")
  })

  it("setting the default on an org with no row writes nothing, and concurrent first sets give one change", async () => {
    const read = () =>
      withOrgDbContext(orgE, (db) => db.select().from(orgFeatures))
    expect(await setOrgFeature(orgE, "knowledge_plane", "off")).toEqual({
      previous: "off",
      value: "off",
      changed: false,
    })
    expect(await read()).toEqual([])

    // Open the pool connections first, so that the setters start together.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withOrgDbContext(orgE, (db) => db.execute(sql`select pg_sleep(0.05)`)),
      ),
    )
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        setOrgFeature(orgE, "knowledge_plane", "shadow"),
      ),
    )
    const changed = results.filter((r) => r.changed)
    expect(changed).toEqual([
      { previous: "off", value: "shadow", changed: true },
    ])
    expect(
      results.filter((r) => !r.changed).every((r) => r.previous === "shadow"),
    ).toBe(true)
    expect(await read()).toHaveLength(1)
  })
})
