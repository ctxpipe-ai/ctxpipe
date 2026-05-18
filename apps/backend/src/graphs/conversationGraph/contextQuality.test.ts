import { describe, expect, it } from "vitest"
import { formatContextQualityFlags } from "./contextQuality.js"

describe("formatContextQualityFlags", () => {
  it("marks not ready repos and weak pre-retrieval signal", () => {
    const out = formatContextQualityFlags({
      repositories: [
        { name: "org/stillwood", indexReady: false },
        { name: "org/other", indexReady: true },
      ],
      hasHydratedClaimsInContext: false,
      state: {
        candidates: [],
        claimAggregationResults: [],
        currentProjectName: "Stillwood",
      },
    })
    expect(out).toContain("repository_index_not_ready_count: 1")
    expect(out).toContain("org/stillwood")
    expect(out).toContain('pre_retrieval_signal: none')
    expect(out).toContain("at_least_one_repository_not_fully_indexed")
    expect(out).toContain("current_project_name_matches_repository_row: false")
  })

  it("reports all ready when every repo is index_ready", () => {
    const out = formatContextQualityFlags({
      repositories: [{ name: "a/b", indexReady: true }],
      hasHydratedClaimsInContext: false,
      state: {
        candidates: [],
        claimAggregationResults: [],
        currentProjectName: "a/b",
      },
    })
    expect(out).toContain("all_listed_repositories_marked_index_ready")
    expect(out).toContain("current_project_name_matches_repository_row: true")
  })
})
