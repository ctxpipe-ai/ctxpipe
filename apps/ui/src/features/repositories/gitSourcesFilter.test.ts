import { describe, expect, it } from "vitest"
import {
  gitSourceFilterCounts,
  gitSourceMatchesQuery,
  repositoryMatchesStatusFilter,
} from "./gitSourcesFilter"

describe("gitSourceMatchesQuery", () => {
  it("matches name or URL, ignoring case", () => {
    expect(
      gitSourceMatchesQuery(
        "acme/payments",
        "https://github.com/acme/payments.git",
        "PAY",
      ),
    ).toBe(true)
    expect(
      gitSourceMatchesQuery(
        "acme/web",
        "https://github.com/acme/web.git",
        "nope",
      ),
    ).toBe(false)
  })

  it("matches everything when the query is empty", () => {
    expect(
      gitSourceMatchesQuery("acme/web", "https://github.com/acme/web.git", ""),
    ).toBe(true)
  })
})

describe("repositoryMatchesStatusFilter", () => {
  it("treats ready as indexed and running-with-hash as indexing", () => {
    expect(
      repositoryMatchesStatusFilter(
        { indexingStatus: "ready", lastIngestedHash: "abc" },
        "indexed",
      ),
    ).toBe(true)
    expect(
      repositoryMatchesStatusFilter(
        {
          indexingStatus: "running",
          lastIngestedHash: "abc",
        },
        "indexing",
      ),
    ).toBe(true)
    expect(
      repositoryMatchesStatusFilter(
        { indexingStatus: "failed", lastIngestedHash: "abc" },
        "failed",
      ),
    ).toBe(true)
    expect(
      repositoryMatchesStatusFilter(
        { indexingStatus: "ready", lastIngestedHash: "abc" },
        "pending",
      ),
    ).toBe(false)
  })

  it("treats complete with issues as both indexed and needing attention", () => {
    expect(
      repositoryMatchesStatusFilter(
        {
          indexingStatus: "complete_with_issues",
          lastIngestedHash: "abc",
        },
        "indexed",
      ),
    ).toBe(true)
    expect(
      repositoryMatchesStatusFilter(
        {
          indexingStatus: "complete_with_issues",
          lastIngestedHash: "abc",
        },
        "failed",
      ),
    ).toBe(true)
  })

  it("counts complete with issues in both indexed and failed chips", () => {
    expect(
      gitSourceFilterCounts(
        [
          { indexingStatus: "ready", lastIngestedHash: "abc" },
          {
            indexingStatus: "complete_with_issues",
            lastIngestedHash: "abc",
          },
          { indexingStatus: "failed", lastIngestedHash: null },
        ],
        0,
      ),
    ).toEqual({
      all: 3,
      indexed: 2,
      indexing: 0,
      failed: 2,
      pending: 0,
    })
  })
})
