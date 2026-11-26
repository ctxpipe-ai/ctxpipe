import { inArray, sql } from "drizzle-orm"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { orgFeatures } from "../db/schema/org_features.js"
import type { AdminRequest } from "../domain/admin-request.js"
import { generateObjectId } from "../lib/id.js"
import { getOrgFeature, setOrgFeature } from "./org-features.js"

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const orgA = generateObjectId("org")
const orgB = generateObjectId("org")
const orgC = generateObjectId("org")
const orgD = generateObjectId("org")
const orgE = generateObjectId("org")
const orgF = generateObjectId("org")
const orgG = generateObjectId("org")
const orgs = [orgA, orgB, orgC, orgD, orgE, orgF, orgG]

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
        orgs.map((id, i) => ({
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
      .where(inArray(organizations.id, orgs))
    await closeDb()
  })

  // A hosted deployment, unless a test says otherwise: hosted keeps each
  // feature off until its config sets a value.
  beforeEach(() => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "production")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("on a hosted deployment, gives off when the org has no row", async () => {
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

  it("the config sets a value, changes it, and a second set with the same value writes nothing", async () => {
    expect(await setOrgFeature(orgD, "knowledge_plane", "shadow")).toEqual({
      previous: "off",
      value: "shadow",
      changed: true,
      held: false,
    })
    expect(await getOrgFeature(orgD, "knowledge_plane")).toBe("shadow")
    const read = () =>
      withOrgDbContext(orgD, (db) => db.select().from(orgFeatures))
    const [first] = await read()

    expect(await setOrgFeature(orgD, "knowledge_plane", "shadow")).toEqual({
      previous: "shadow",
      value: "shadow",
      changed: false,
      held: false,
    })
    expect((await read())[0]?.updatedAt).toEqual(first?.updatedAt)

    expect(await setOrgFeature(orgD, "knowledge_plane", "off")).toEqual({
      previous: "shadow",
      value: "off",
      changed: true,
      held: false,
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
      held: false,
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
      { previous: "off", value: "shadow", changed: true, held: false },
    ])
    expect(
      results.filter((r) => !r.changed).every((r) => r.previous === "shadow"),
    ).toBe(true)
    expect(await read()).toHaveLength(1)
  })

  it("the config does not change a value that an operator set, until the config names that value", async () => {
    const OPERATOR = {
      requestId: "00000000-0000-4000-8000-000000000001",
      requestedBy: { kind: "operator", email: "operator@example.com" },
      approvedBy: "approver@example.com",
    } as const satisfies AdminRequest
    const read = () =>
      withOrgDbContext(orgF, (db) => db.select().from(orgFeatures))
    await setOrgFeature(orgF, "knowledge_plane", "on")

    expect(
      await setOrgFeature(orgF, "knowledge_plane", "off", OPERATOR),
    ).toEqual({ previous: "on", value: "off", changed: true, held: true })
    expect(await getOrgFeature(orgF, "knowledge_plane")).toBe("off")

    // Each hosted update runs the config again with its old value.
    expect(await setOrgFeature(orgF, "knowledge_plane", "on")).toEqual({
      previous: "off",
      value: "off",
      changed: false,
      held: true,
    })
    expect(await getOrgFeature(orgF, "knowledge_plane")).toBe("off")

    // The config PR names the operator's value: the hold ends.
    expect(await setOrgFeature(orgF, "knowledge_plane", "off")).toEqual({
      previous: "off",
      value: "off",
      changed: false,
      held: false,
    })
    expect((await read())[0]?.held).toBe(false)

    // A later config change applies again.
    expect(await setOrgFeature(orgF, "knowledge_plane", "shadow")).toEqual({
      previous: "off",
      value: "shadow",
      changed: true,
      held: false,
    })
    expect(await getOrgFeature(orgF, "knowledge_plane")).toBe("shadow")
  })

  it("on a self-hosted install, gives on when the org has no row, and a row still wins", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "")
    expect(await getOrgFeature(orgG, "knowledge_plane")).toBe("on")
    // A preview is hosted too.
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "pr-12")
    expect(await getOrgFeature(orgG, "knowledge_plane")).toBe("off")
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "")

    // The default needs no write: a set of `on` changes nothing.
    expect(await setOrgFeature(orgG, "knowledge_plane", "on")).toEqual({
      previous: "on",
      value: "on",
      changed: false,
      held: false,
    })
    expect(
      await withOrgDbContext(orgG, (db) => db.select().from(orgFeatures)),
    ).toEqual([])

    // The fast `off` of an operator holds on a self-hosted install too.
    const OPERATOR = {
      requestId: "00000000-0000-4000-8000-000000000002",
      requestedBy: { kind: "operator", email: "operator@example.com" },
      approvedBy: "approver@example.com",
    } as const satisfies AdminRequest
    expect(
      await setOrgFeature(orgG, "knowledge_plane", "off", OPERATOR),
    ).toEqual({ previous: "on", value: "off", changed: true, held: true })
    expect(await getOrgFeature(orgG, "knowledge_plane")).toBe("off")
  })
})
