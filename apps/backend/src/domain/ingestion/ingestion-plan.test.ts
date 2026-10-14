import { describe, expect, it } from "vitest"
import {
  INGEST_SHARD_MAX_ROOTS,
  ingestShardCount,
  plannedIngestSkills,
  shardRoots,
  skillStepName,
  sourceCandidateRoots,
} from "./ingestion-plan.js"

describe("ingestion v2 plan", () => {
  it("finds a candidate root for each folder with a manifest", () => {
    expect(
      sourceCandidateRoots([
        "package.json",
        "README.md",
        "services/api/package.json",
        "services/api/src/index.ts",
        "crates/core/Cargo.toml",
        "tools/go.mod",
        "docs/guide.md",
        "services/api/package.json",
      ]),
    ).toEqual([".", "crates/core", "services/api", "tools"])
  })

  it("sizes the shards at 20 roots, with at least one shard", () => {
    expect(INGEST_SHARD_MAX_ROOTS).toBe(20)
    expect(ingestShardCount(0)).toBe(1)
    expect(ingestShardCount(20)).toBe(1)
    expect(ingestShardCount(21)).toBe(2)
    expect(ingestShardCount(41)).toBe(3)
  })

  it("gives each root to exactly one shard, also when discovery finds more roots than the plan", () => {
    const roots = Array.from({ length: 45 }, (_, i) => `pkg/${i}`)
    const shards = 2
    const parts = [0, 1].map((shard) => shardRoots(roots, shard, shards))
    expect(parts.flat().sort()).toEqual([...roots].sort())
    expect(parts[0]).toContain("pkg/0")
    expect(parts[1]).toContain("pkg/1")
    expect(new Set(parts[0]).size + new Set(parts[1]).size).toBe(45)
  })

  it("plans only bundle skills, in the committed order, by scope", () => {
    const bundle = ["ownership", "discover-roots", "classify-kind", "libraries"]
    expect(plannedIngestSkills(bundle, "root").map((s) => s.name)).toEqual([
      "libraries",
      "classify-kind",
    ])
    expect(
      plannedIngestSkills(bundle, "repository").map((s) => s.name),
    ).toEqual(["ownership"])
    expect(plannedIngestSkills(bundle, "root")[1]).toMatchObject({
      run: "model",
      tier: "fast",
    })
  })

  it("refuses a bundle skill that the plan does not know", () => {
    expect(() =>
      plannedIngestSkills(["discover-roots", "unknown-skill"], "root"),
    ).toThrow("unknown-skill")
  })

  it("names a skill step by root, skill, and Workspace", () => {
    expect(skillStepName("services/api", "apis", "ws_a")).toBe(
      "skill:services/api:apis:ws_a",
    )
  })
})
