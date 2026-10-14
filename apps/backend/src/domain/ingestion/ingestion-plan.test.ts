import { describe, expect, it } from "vitest"
import {
  INGEST_MAX_ROOTS,
  plannedIngestSkills,
  planIngestRoots,
  skillStepName,
} from "./ingestion-plan.js"

const root = (path: string) => ({
  path,
  manifests: ["package.json"],
  evidence: ["pnpm-workspace.yaml"],
})

describe("ingestion v2 plan", () => {
  it("plans the script roots after the host check, sorted and with no duplicate", () => {
    const plan = planIngestRoots({
      roots: [root("services/b"), root("."), root("services/b"), root("../x")],
      ambiguous: [],
    })
    expect(plan.partial).toBeUndefined()
    if (plan.partial !== undefined) throw new Error("unexpected partial")
    expect(plan.roots.map((r) => r.path)).toEqual([".", "services/b"])
    expect(plan.refused).toEqual([
      { path: "../x", reason: "The path is not safe to write" },
    ])
  })

  it("refuses a script result that does not match the schema", () => {
    expect(() => planIngestRoots({ roots: "everything" })).toThrow(
      "does not match its schema",
    )
  })

  it("plans no root and gives a partial reason above the root cap", () => {
    const plan = planIngestRoots({
      roots: Array.from({ length: INGEST_MAX_ROOTS + 1 }, (_, i) =>
        root(`pkg/${i}`),
      ),
      ambiguous: [],
    })
    expect(plan).toMatchObject({
      partial: expect.stringContaining(`at most ${INGEST_MAX_ROOTS}`),
    })
    expect("roots" in plan).toBe(false)
  })

  it("plans only bundle skills, in the committed order, by scope; libraries is repository-wide", () => {
    const bundle = ["ownership", "discover-roots", "classify-kind", "libraries"]
    expect(plannedIngestSkills(bundle, "root").map((s) => s.name)).toEqual([
      "classify-kind",
    ])
    expect(
      plannedIngestSkills(bundle, "repository").map((s) => s.name),
    ).toEqual(["libraries", "ownership"])
    expect(plannedIngestSkills(bundle, "root")[0]).toMatchObject({
      run: "model",
      tier: "fast",
    })
  })

  it("refuses a bundle skill that the plan does not know", () => {
    expect(() =>
      plannedIngestSkills(["discover-roots", "unknown-skill"], "root"),
    ).toThrow("unknown-skill")
  })

  it("names a skill step with 1 to 200 printable ASCII characters for any root", () => {
    const roots = [
      "services/api",
      "apps/my app",
      "packages/zürich-ünïcode",
      `deep/${"a".repeat(245)}`,
      `deep/${"a".repeat(244)}b`,
    ]
    const names = roots.map((r) => skillStepName(r, "classify-kind", "ws_a"))
    for (const name of names) expect(name).toMatch(/^[\x21-\x7e]{1,200}$/)
    expect(new Set(names).size).toBe(roots.length)
    expect(names[0]).toMatch(/^skill:services\/api~[0-9a-f]{12}:classify-kind:ws_a$/)
    expect(skillStepName("services/api", "apis", "ws_a")).toBe(
      skillStepName("services/api", "apis", "ws_a"),
    )
    expect(skillStepName(".", "libraries", "ws_a", 2)).toMatch(
      /:libraries\.2:ws_a$/,
    )
  })
})
