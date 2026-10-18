import { describe, expect, it } from "vitest"
import { parseLegacyScope, splitLegacyScope } from "./legacy-scope.js"
import { confluenceSourceScopeSchema } from "./providers/confluence.js"
import { linearScopeSchema } from "./providers/linear.js"

const ids = (count: number, make: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => make(i))

describe("splitLegacyScope", () => {
  it("gives a scope in the caps back as it is", () => {
    const scope = { teams: ["ENG"] }
    expect(splitLegacyScope(linearScopeSchema, scope)).toEqual([scope])
  })

  it("splits a long top list, and puts each other list only in the first part", () => {
    const teams = ids(51, (i) => `T${i}`)
    const parts = splitLegacyScope(linearScopeSchema, {
      teams,
      projects: ["p1"],
      customerRequests: "exclude",
    })
    expect(parts).toEqual([
      {
        teams: teams.slice(0, 50),
        projects: ["p1"],
        customerRequests: "exclude",
      },
      { teams: teams.slice(50), customerRequests: "exclude" },
    ])
    for (const part of parts)
      expect(linearScopeSchema.safeParse(part).success).toBe(true)
  })

  it("splits the long page list of one Confluence space, and a long space list", () => {
    const pages = ids(501, (i) => String(i + 1))
    const spaces = [
      { key: "ENG", pages },
      ...ids(100, (i) => ({ key: `S${i}`, pages: "all" as const })),
    ]
    const parts = splitLegacyScope(confluenceSourceScopeSchema, { spaces })
    for (const part of parts)
      expect(confluenceSourceScopeSchema.safeParse(part).success).toBe(true)
    const all = parts.flatMap(
      (part) =>
        (part as { spaces: Array<{ key: string; pages: unknown }> }).spaces,
    )
    expect(
      all
        .filter((space) => space.key === "ENG")
        .flatMap((space) => space.pages),
    ).toEqual(pages)
    expect(all.filter((space) => space.key !== "ENG")).toHaveLength(100)
  })
})

describe("parseLegacyScope", () => {
  it("accepts a long list when each part is valid, and keeps other errors", () => {
    const teams = ids(51, (i) => `T${i}`)
    expect(parseLegacyScope(linearScopeSchema, { teams })).toEqual({
      success: true,
      data: { teams },
    })
    expect(
      parseLegacyScope(linearScopeSchema, { teams: [...teams, "bad key"] })
        .success,
    ).toBe(false)
  })
})
