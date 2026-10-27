import { describe, expect, it } from "vitest"

import {
  INGEST_MAX_ROOTS,
  ingestRootMap,
  planIngestRoots,
  plannedIngestSkills,
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

  it("runs the repository unit first, dependencies also on the assembled ref, datasources-infra only there, and workflows last", () => {
    const bundle = [
      "workflows",
      "repository",
      "classify-kind",
      "apis",
      "dependencies",
      "datasources-infra",
      "libraries",
      "ownership",
      "decisions",
      "instruction-areas",
    ]
    expect(plannedIngestSkills(bundle, "first")).toEqual([
      { name: "repository", scope: "first", run: "script" },
    ])
    expect(plannedIngestSkills(bundle, "root").map((s) => s.name)).toEqual([
      "classify-kind",
      "apis",
      "dependencies",
    ])
    expect(
      plannedIngestSkills(bundle, "repository").map((s) => s.name),
    ).toEqual([
      "libraries",
      "ownership",
      "dependencies",
      "datasources-infra",
      "decisions",
      "instruction-areas",
      "workflows",
    ])
    expect(plannedIngestSkills(bundle, "repository").at(-1)).toEqual({
      name: "workflows",
      scope: "repository",
      run: "script",
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
    expect(names[0]).toMatch(
      /^skill:services\/api~[0-9a-f]{12}:classify-kind:ws_a$/,
    )
    expect(skillStepName("services/api", "apis", "ws_a")).toBe(
      skillStepName("services/api", "apis", "ws_a"),
    )
    // A repository-wide step never has the key of a root, also of ".".
    expect(skillStepName(null, "libraries", "ws_a", 2)).toBe(
      "skill:repository:libraries.2:ws_a",
    )
    expect(skillStepName(".", "libraries", "ws_a")).not.toContain("repository")
  })
})

describe("ingestRootMap", () => {
  it("gives each root the files that its root steps wrote, and ignores repository steps", () => {
    const roots = [root("."), root("services/api")]
    const map = ingestRootMap(roots, [
      {
        step: skillStepName("services/api", "apis", "ws_a"),
        paths: ["knowledge/services/api.md", "knowledge/apis/orders.md"],
      },
      {
        step: skillStepName("services/api", "classify-kind", "ws_a"),
        paths: ["knowledge/services/api.md"],
      },
      {
        step: skillStepName(".", "classify-kind", "ws_a"),
        paths: ["knowledge/codebases/checkout.md"],
      },
      {
        step: skillStepName(null, "libraries", "ws_a"),
        paths: ["knowledge/libraries/zod.md"],
      },
      { step: "assemble:ws_a", paths: ["knowledge/merged.md"] },
    ])
    expect(map).toEqual({
      roots: [
        { ...root("."), files: ["knowledge/codebases/checkout.md"] },
        {
          ...root("services/api"),
          files: ["knowledge/apis/orders.md", "knowledge/services/api.md"],
        },
      ],
    })
  })
})
