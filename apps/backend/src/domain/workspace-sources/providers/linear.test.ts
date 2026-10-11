import { describe, expect, it } from "vitest"
import { parseSourceEntry } from "../sources-file.js"
import { linearSourceScope, summarizeLinearScope } from "./linear.js"

const team = { id: "9c1d2e3f-team", key: "ENG", name: "Engineering" }
const project = { id: "4a5b6c7d-project", name: "Launch" }

describe("Linear source scope", () => {
  it("accepts teams with optional projects from a sources.yaml entry", () => {
    const parsed = parseSourceEntry({
      id: "eng-issues",
      provider: "linear",
      connection: "con_linear1",
      teams: [team],
      projects: [project],
    })
    expect(parsed).toEqual({
      ok: true,
      entry: {
        key: "eng-issues",
        provider: "linear",
        connectionId: "con_linear1",
        scope: { teams: [team], projects: [project] },
      },
    })
  })

  it("defaults projects to an empty list", () => {
    expect(linearSourceScope.schema.parse({ teams: [team] })).toEqual({
      teams: [team],
      projects: [],
    })
  })

  it("accepts projects without teams", () => {
    expect(linearSourceScope.schema.parse({ projects: [project] })).toEqual({
      teams: [],
      projects: [project],
    })
  })

  it("refuses an empty scope", () => {
    expect(linearSourceScope.schema.safeParse({}).success).toBe(false)
  })

  it("refuses a team key or id that is not a safe path segment", () => {
    for (const bad of [
      { ...team, key: "../x" },
      { ...team, key: "" },
      { ...team, id: "a/b" },
    ])
      expect(linearSourceScope.schema.safeParse({ teams: [bad] }).success).toBe(
        false,
      )
  })

  it("refuses the same team twice", () => {
    expect(
      linearSourceScope.schema.safeParse({ teams: [team, team] }).success,
    ).toBe(false)
  })

  it("summarizes teams and projects", () => {
    expect(summarizeLinearScope({ teams: [team], projects: [] })).toBe(
      "1 Linear team",
    )
    expect(
      summarizeLinearScope({
        teams: [team, { ...team, id: "t2", key: "OPS" }],
        projects: [project],
      }),
    ).toBe("2 Linear teams · 1 project")
    expect(summarizeLinearScope({ teams: [], projects: [project] })).toBe(
      "1 Linear project",
    )
  })
})
