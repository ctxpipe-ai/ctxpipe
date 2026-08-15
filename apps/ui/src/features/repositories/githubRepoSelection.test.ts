import { describe, expect, it, vi } from "vitest"
import {
  buildSelectedRepositories,
  collectInstallationRepoPages,
  countSelectionDelta,
  describeSelectionDelta,
  githubCloneUrlKey,
  matchSavedRepoIds,
  unmatchedSavedRepos,
} from "./githubRepoSelection"

const page1 = [
  {
    id: 1,
    full_name: "acme/alpha",
    html_url: "https://github.com/acme/alpha",
    clone_url: "https://github.com/acme/alpha.git",
    name: "alpha",
  },
  {
    id: 2,
    full_name: "acme/beta",
    html_url: "https://github.com/acme/beta",
    clone_url: "https://github.com/acme/beta.git",
    name: "beta",
  },
]

const page2 = [
  {
    id: 31,
    full_name: "acme/payments",
    html_url: "https://github.com/acme/payments",
    clone_url: "https://github.com/acme/payments.git",
    name: "payments",
  },
]

describe("githubCloneUrlKey", () => {
  it("treats trailing .git and case as the same repo", () => {
    expect(githubCloneUrlKey("https://github.com/Acme/Web.GIT")).toBe(
      "https://github.com/acme/web",
    )
  })
})

describe("matchSavedRepoIds", () => {
  it("does not match saved repos that have not loaded yet", () => {
    const saved = [
      "https://github.com/acme/payments.git",
      "https://github.com/acme/alpha.git",
    ]
    expect(matchSavedRepoIds(saved, page1)).toEqual(new Set([1]))
    expect(matchSavedRepoIds(saved, [...page1, ...page2])).toEqual(
      new Set([1, 31]),
    )
  })
})

describe("unmatchedSavedRepos", () => {
  it("keeps indexed repos that never appeared in the GitHub list", () => {
    expect(
      unmatchedSavedRepos(
        [
          { name: "acme/alpha", gitUrl: "https://github.com/acme/alpha.git" },
          {
            name: "acme/legacy",
            gitUrl: "https://github.com/acme/legacy.git",
          },
        ],
        page1,
      ),
    ).toEqual([
      { name: "acme/legacy", gitUrl: "https://github.com/acme/legacy.git" },
    ])
  })
})

describe("buildSelectedRepositories", () => {
  it("reproduces the clobber: saving only page-1 checks drops later indexed repos", () => {
    const saved = [
      { name: "acme/alpha", gitUrl: "https://github.com/acme/alpha.git" },
      { name: "acme/payments", gitUrl: "https://github.com/acme/payments.git" },
    ]
    const page1Matched = matchSavedRepoIds(
      saved.map((repo) => repo.gitUrl),
      page1,
    )
    const clobbered = buildSelectedRepositories({
      githubRepos: page1,
      selectedIds: page1Matched,
      unmatchedSaved: [],
    })
    expect(clobbered.map((repo) => repo.clone_url)).toEqual([
      "https://github.com/acme/alpha.git",
    ])

    const kept = buildSelectedRepositories({
      githubRepos: page1,
      selectedIds: page1Matched,
      unmatchedSaved: unmatchedSavedRepos(saved, page1),
    })
    expect(kept.map((repo) => repo.clone_url)).toEqual([
      "https://github.com/acme/alpha.git",
      "https://github.com/acme/payments.git",
    ])
  })

  it("includes newly checked repos that were not previously indexed", () => {
    const payload = buildSelectedRepositories({
      githubRepos: page1,
      selectedIds: new Set([1, 2]),
      unmatchedSaved: [],
    })
    expect(payload.map((repo) => repo.full_name)).toEqual([
      "acme/alpha",
      "acme/beta",
    ])
  })
})

describe("countSelectionDelta / describeSelectionDelta", () => {
  it("summarises kept, added, and removed", () => {
    const delta = countSelectionDelta({
      savedGitUrls: [
        "https://github.com/acme/alpha.git",
        "https://github.com/acme/payments.git",
      ],
      selectedCloneUrls: [
        "https://github.com/acme/alpha.git",
        "https://github.com/acme/beta.git",
      ],
    })
    expect(delta).toEqual({ keptCount: 1, addedCount: 1, removedCount: 1 })
    expect(describeSelectionDelta(delta)).toBe(
      "1 already indexed · 1 added · 1 removed",
    )
  })
})

describe("collectInstallationRepoPages", () => {
  it("walks pages until hasMore is false", async () => {
    const fetchPage = vi.fn(async (page: number) => {
      if (page === 1) {
        return {
          repositories: page1,
          hasMore: true,
          repositorySelection: "selected",
        }
      }
      return {
        repositories: page2,
        hasMore: false,
        repositorySelection: "selected",
      }
    })
    const result = await collectInstallationRepoPages(fetchPage)
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(result.repositories.map((repo) => repo.id)).toEqual([1, 2, 31])
  })
})
