import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  ingestRootMap,
  packRoots,
  packRootsWithin,
  unpackRoots,
  withExistingRootFiles,
  plannedIngestSkills,
  skillStepName,
} from "./ingestion-plan.js"
import { INGEST_SKILLS_DIR } from "./skill-bundle.js"

const root = (path: string) => ({
  path,
  manifests: ["package.json"],
  evidence: ["pnpm-workspace.yaml"],
})

describe("ingestion v2 plan", () => {
  it("packs and unpacks the roots of a large monorepo", () => {
    const roots = Array.from({ length: 5000 }, (_, i) =>
      root(`packages/group-${i % 50}/package-${String(i).padStart(4, "0")}`),
    )
    const packed = packRoots(roots)
    expect(unpackRoots(packed)).toEqual(roots)
    // Far below the 1 MiB of a step output that the backend warns about.
    expect(packed.length).toBeLessThan(200_000)
    expect(packRootsWithin(roots, 2 ** 20)).toEqual({ packed, left: [] })
  })

  it("packs the first roots that fit in a size, and gives the roots that it leaves out", () => {
    // Paths that do not compress well.
    const roots = Array.from({ length: 300 }, (_, i) =>
      root(`pkg/${createHash("sha256").update(String(i)).digest("hex")}`),
    )
    const { packed, left } = packRootsWithin(roots, 4000)
    expect(packed.length).toBeLessThanOrEqual(4000)
    const kept = unpackRoots(packed)
    expect(kept.length).toBeGreaterThan(0)
    expect([...kept, ...left]).toEqual(roots)
    // One more root would not fit.
    expect(packRoots(roots.slice(0, kept.length + 1)).length).toBeGreaterThan(
      4000,
    )
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

  it("runs the repository unit first, dependencies also on the assembled ref, and datasources-infra only there", () => {
    const bundle = [
      "repository",
      "classify-kind",
      "apis",
      "dependencies",
      "datasources-infra",
      "libraries",
      "ownership",
      "feature-gates",
      "decisions",
      "instruction-areas",
    ]
    expect(plannedIngestSkills(bundle, "first")).toEqual([
      {
        name: "repository",
        scope: "first",
        run: "script",
        cursor: { finder: "repository.mjs" },
      },
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
      "feature-gates",
      "dependencies",
      "datasources-infra",
      "decisions",
      "instruction-areas",
    ])
  })

  it("names a finder script of the bundle for each cursor skill, and gives the other skills one page (CTX-1487)", () => {
    const bundle = [
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
    const skills = (["first", "root", "repository"] as const).flatMap((scope) =>
      plannedIngestSkills(bundle, scope),
    )
    for (const skill of skills)
      if (skill.cursor)
        expect(
          existsSync(
            join(INGEST_SKILLS_DIR, skill.name, "scripts", skill.cursor.finder),
          ),
          `${skill.name}: ${skill.cursor.finder}`,
        ).toBe(true)
    expect(
      skills.filter((skill) => !skill.cursor).map((skill) => skill.name),
    ).toEqual(["classify-kind"])
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
        // A part of a dependency list is not a file of the root (CTX-1487).
        step: skillStepName("services/api", "dependencies", "ws_a"),
        paths: ["knowledge/services/api.dependencies-2.md"],
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

describe("withExistingRootFiles", () => {
  const SERVICE = "knowledge/services/api.md"
  const LIBRARY = "knowledge/libraries/api.md"
  const map = (files: string[]) => ({
    roots: [
      { ...root("services/api"), files },
      { ...root("."), files: [] },
    ],
  })

  it("gives a root the files of an earlier ingest when this run wrote none", () => {
    expect(
      withExistingRootFiles(map([]), [
        { path: SERVICE, kind: "Service", root: "services/api" },
        { path: "knowledge/apps/web.md", kind: "App", root: "." },
      ]),
    ).toEqual({
      roots: [
        { ...root("services/api"), files: [SERVICE] },
        { ...root("."), files: ["knowledge/apps/web.md"] },
      ],
    })
  })

  it("keeps the files that this run wrote and adds no file twice", () => {
    expect(
      withExistingRootFiles(map(["knowledge/apis/orders.md", SERVICE]), [
        { path: SERVICE, kind: "Service", root: "services/api" },
      ]).roots[0]?.files,
    ).toEqual(["knowledge/apis/orders.md", SERVICE])
  })

  it("gives no old package file to a root whose package file this run wrote", () => {
    // This run classified the root as a Library: the old Service file of the
    // same root is stale and must not get the claims of the Service.
    expect(
      withExistingRootFiles(map([LIBRARY]), [
        { path: LIBRARY, kind: "Library", root: "services/api" },
        { path: SERVICE, kind: "Service", root: "services/api" },
      ]).roots[0]?.files,
    ).toEqual([LIBRARY])
  })

  it("gives no old package file to a root that has more than one", () => {
    // Two earlier ingests classified the root in two ways. The map cannot
    // know which file is current, so it adds neither.
    expect(
      withExistingRootFiles(map([]), [
        { path: SERVICE, kind: "Service", root: "services/api" },
        { path: LIBRARY, kind: "Library", root: "services/api" },
      ]).roots[0]?.files,
    ).toEqual([])
  })
})
