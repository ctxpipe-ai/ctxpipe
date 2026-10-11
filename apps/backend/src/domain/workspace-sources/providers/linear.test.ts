import { describe, expect, it } from "vitest"
import { parseSourceEntry } from "../sources-file.js"
import { linearSourceScope, summarizeLinearScope } from "./linear.js"

const project = "4a5b6c7d-0000-4000-8000-000000000001"

describe("Linear source scope", () => {
  it("accepts team keys with optional project ids from a sources.yaml entry", () => {
    expect(
      parseSourceEntry({
        id: "eng-issues",
        provider: "linear",
        connection: "con_linear1",
        teams: ["ENG"],
        projects: [project],
        customerRequests: "exclude",
      }),
    ).toEqual({
      ok: true,
      entry: {
        key: "eng-issues",
        provider: "linear",
        connectionId: "con_linear1",
        scope: {
          teams: ["ENG"],
          projects: [project],
          customerRequests: "exclude",
        },
      },
    })
  })

  it("accepts teams alone or projects alone, and keeps the entry as written", () => {
    expect(linearSourceScope.schema.parse({ teams: ["ENG"] })).toEqual({
      teams: ["ENG"],
    })
    expect(linearSourceScope.schema.parse({ projects: [project] })).toEqual({
      projects: [project],
    })
  })

  it("refuses an empty scope", () => {
    expect(linearSourceScope.schema.safeParse({}).success).toBe(false)
  })

  it("refuses a team key or project id that is not a safe path segment", () => {
    for (const bad of [
      { teams: ["../x"] },
      { teams: [""] },
      { projects: ["a/b"] },
    ])
      expect(linearSourceScope.schema.safeParse(bad).success).toBe(false)
  })

  it("refuses the same team twice, in any letter case", () => {
    expect(
      linearSourceScope.schema.safeParse({ teams: ["ENG", "eng"] }).success,
    ).toBe(false)
  })

  it("summarizes teams and projects", () => {
    expect(summarizeLinearScope({ teams: ["ENG"] })).toBe("1 Linear team")
    expect(
      summarizeLinearScope({ teams: ["ENG", "OPS"], projects: [project] }),
    ).toBe("2 Linear teams · 1 project")
    expect(summarizeLinearScope({ projects: [project] })).toBe(
      "1 Linear project",
    )
  })
})
